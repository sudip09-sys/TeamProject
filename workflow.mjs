import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const statuses = ['todo', 'in_progress', 'review', 'done'];
const priorities = ['low', 'medium', 'high'];
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(400, 'Check the text fields and their length.');
  return value.trim();
};
const date = value => {
  if (value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1000) fail(400, 'Enter a valid date.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, 'Enter a valid date.');
  return value;
};
const link = value => {
  const result = text(value, 1000, true);
  try { const url = new URL(result); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
  catch { fail(400, 'Links must start with https:// or http:// and contain no credentials.'); }
  return result;
};

export function migrate(db, databasePath) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) throw new Error('Database version is newer than this application.');
  // VACUUM INTO creates a consistent copy, including data currently in the WAL.
  if (databasePath !== ':memory:') {
    const folder = path.join(path.dirname(databasePath), 'backups');
    fs.mkdirSync(folder, { recursive: true });
    const name = `nextstep-${new Date().toISOString().slice(0, 10)}-v${version}.sqlite`;
    const filename = path.join(folder, name);
    if (!fs.existsSync(filename)) db.prepare('VACUUM INTO ?').run(filename);
    const backups = fs.readdirSync(folder).filter(name => /^nextstep-.*\.sqlite$/.test(name)).sort();
    for (const name of backups.slice(0, -7)) fs.unlinkSync(path.join(folder, name));
  }
  if (version === 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
    for (const [name, definition] of Object.entries({ priority: "TEXT NOT NULL DEFAULT 'medium'", status: "TEXT NOT NULL DEFAULT 'todo'", reviewer: "TEXT NOT NULL DEFAULT ''", milestone_id: "TEXT NOT NULL DEFAULT ''", dependencies: "TEXT NOT NULL DEFAULT '[]'", links: "TEXT NOT NULL DEFAULT '[]'" })) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
    db.exec("UPDATE tasks SET status=CASE WHEN completed=1 THEN 'done' ELSE 'todo' END");
    if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'recovery_hash')) db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS milestones(id TEXT PRIMARY KEY,title TEXT NOT NULL,deadline TEXT NOT NULL,description TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),username TEXT NOT NULL REFERENCES users(username),body TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL,username TEXT NOT NULL REFERENCES users(username),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,starts_at TEXT NOT NULL,topic TEXT NOT NULL,username TEXT NOT NULL REFERENCES users(username),version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS rsvps(meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,username TEXT NOT NULL REFERENCES users(username),answer TEXT NOT NULL,PRIMARY KEY(meeting_id,username));
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,username TEXT NOT NULL REFERENCES users(username),message TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,is_read INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS focus_logs(id TEXT PRIMARY KEY,username TEXT NOT NULL REFERENCES users(username),minutes INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(username,created_at);
      CREATE INDEX IF NOT EXISTS comments_task ON comments(task_id,created_at);
      PRAGMA user_version=2; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createWorkflow({ db, members, json, readBody, activity, snapshot, sessionUser, deriveKey, keyOptions, newSession, inviteCode, rateLimit }) {
  const names = new Map(members.map(member => [member.username, member.name]));
  const clients = new Set();
  let revision = 0;
  function notify(username, message, taskId = '') {
    if (!names.has(username) || !db.prepare('SELECT username FROM users WHERE username=?').get(username)) return;
    db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,0)').run(randomUUID(), username, message, taskId, Date.now());
    db.prepare('DELETE FROM notifications WHERE username=? AND id NOT IN (SELECT id FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT 100)').run(username, username);
  }
  function broadcast() {
    revision++;
    for (const client of clients) client.response.write(`event: changed\ndata: ${revision}\n\n`);
  }
  const timer = setInterval(() => {
    for (const client of clients) {
      if (!sessionUser(client.request)) { client.response.write('event: expired\ndata: {}\n\n'); client.response.end(); clients.delete(client); }
      else client.response.write(': heartbeat\n\n');
    }
  }, 15000);
  timer.unref();
  const task = row => ({ id: row.id, title: row.title, subject: row.subject, deadline: row.deadline, assignee: row.assignee, completed: Boolean(row.completed), createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by, updatedBy: row.updated_by, version: row.version, priority: row.priority, status: row.status, reviewer: row.reviewer, milestoneId: row.milestone_id, dependencies: JSON.parse(row.dependencies), links: JSON.parse(row.links) });
  function extra(user) {
    return {
      milestones: db.prepare('SELECT * FROM milestones ORDER BY deadline,title').all(),
      comments: db.prepare('SELECT c.id,c.task_id AS taskId,c.username,c.body,c.created_at AS createdAt FROM comments c JOIN tasks t ON t.id=c.task_id WHERE t.deleted_at IS NULL ORDER BY c.created_at').all(),
      resources: db.prepare('SELECT id,title,url,username,created_at AS createdAt FROM resources ORDER BY created_at DESC').all(),
      meetings: db.prepare('SELECT id,title,starts_at AS startsAt,topic,username,version FROM meetings ORDER BY starts_at').all().map(row => ({ ...row, rsvps: db.prepare('SELECT username,answer FROM rsvps WHERE meeting_id=?').all(row.id) })),
      notifications: user ? db.prepare('SELECT id,message,task_id AS taskId,created_at AS createdAt,is_read AS isRead FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT 100').all(user.username) : [],
      focus: db.prepare('SELECT username,SUM(minutes) AS minutes,COUNT(*) AS sessions FROM focus_logs GROUP BY username').all(),
      revision
    };
  }
  function validate(body, row, user) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid task.');
    const t = {
      title: text(body.title, 120, true), subject: text(body.subject ?? '', 60), deadline: date(body.deadline ?? ''),
      assignee: body.assignee ?? '', priority: body.priority ?? row?.priority ?? 'medium',
      reviewer: body.reviewer ?? row?.reviewer ?? '', milestoneId: body.milestoneId ?? row?.milestone_id ?? '',
      dependencies: body.dependencies ?? (row ? JSON.parse(row.dependencies) : []), links: body.links ?? (row ? JSON.parse(row.links) : [])
    };
    let status = body.status ?? (body.completed === undefined ? row?.status ?? 'todo' : body.completed ? 'done' : 'todo');
    // Older clients send completed alongside a stale status; honor explicit status changes first.
    if (row && body.status === row.status && typeof body.completed === 'boolean' && body.completed !== Boolean(row.completed)) status = body.completed ? 'done' : 'todo';
    t.status = status;
    if (!statuses.includes(t.status) || !priorities.includes(t.priority) || !['', ...names.keys()].includes(t.assignee) || !['', ...names.keys()].includes(t.reviewer) || (body.completed !== undefined && typeof body.completed !== 'boolean')) fail(400, 'Choose a valid member, priority, and status.');
    if (t.reviewer && t.reviewer === t.assignee) fail(400, 'Choose a reviewer other than the assigned member.');
    if (typeof t.milestoneId !== 'string' || (t.milestoneId && !db.prepare('SELECT id FROM milestones WHERE id=?').get(t.milestoneId))) fail(400, 'Choose an existing milestone.');
    if (!Array.isArray(t.dependencies) || t.dependencies.length > 20 || t.dependencies.some(id => typeof id !== 'string') || new Set(t.dependencies).size !== t.dependencies.length) fail(400, 'Choose up to 20 different prerequisite tasks.');
    if (!Array.isArray(t.links) || t.links.length > 10) fail(400, 'Use up to 10 work links.');
    t.links = t.links.map(item => ({ title: text(item?.title, 80, true), url: link(item?.url) }));
    const rows = db.prepare('SELECT id,dependencies,status FROM tasks WHERE deleted_at IS NULL').all();
    const graph = new Map(rows.map(item => [item.id, JSON.parse(item.dependencies)]));
    if (t.dependencies.some(id => id === row?.id || !graph.has(id))) fail(400, 'Prerequisite tasks must exist and cannot include this task.');
    if (row) graph.set(row.id, t.dependencies);
    const visited = new Set(), visiting = new Set();
    function visit(id) {
      if (visiting.has(id)) fail(409, 'These dependencies would create a cycle.');
      if (visited.has(id)) return;
      visiting.add(id); for (const child of graph.get(id) || []) visit(child); visiting.delete(id); visited.add(id);
    }
    for (const id of graph.keys()) visit(id);
    if (t.status !== 'todo' && t.dependencies.some(id => rows.find(item => item.id === id)?.status !== 'done')) fail(409, 'Complete the prerequisite tasks before starting this task.');
    if (row?.status === 'done' && t.status !== 'done' && rows.some(item => item.id !== row.id && item.status !== 'todo' && JSON.parse(item.dependencies).includes(row.id))) fail(409, 'Move dependent tasks back to To do before reopening their prerequisite.');
    const actorCanWork = !t.assignee || t.assignee === user.username || user.username === 'sudip' || row?.created_by === user.username;
    if (row && row.status !== t.status) {
      const reviewing = row.status === 'review' && row.reviewer;
      if (reviewing && ['done', 'in_progress'].includes(t.status)) {
        if (user.username !== row.reviewer) fail(403, 'Only the selected reviewer can approve or request changes.');
      } else if (!actorCanWork) fail(403, 'Only the assignee, task creator, or team lead can change this status.');
    }
    if (row?.status === 'review' && row.reviewer && (t.reviewer !== row.reviewer || t.assignee !== row.assignee)) fail(409, 'Finish the review before changing its participants.');
    if (t.status === 'review' && (!t.reviewer || !t.assignee)) fail(400, 'Select an assignee and a separate reviewer before requesting review.');
    if (t.status === 'done' && row?.status !== 'done' && t.reviewer && (row?.status !== 'review' || row.reviewer !== user.username || t.reviewer !== row.reviewer)) fail(403, 'Submit for review first; the selected reviewer must approve it.');
    return t;
  }
  const reply = (response, user, status = 200, additional = {}) => { broadcast(); json(response, status, { ...snapshot(user), ...additional }); };
  const admin = user => { if (user.username !== 'sudip') fail(403, 'Only Sudip, the team lead, can manage invitations.'); };
  const version = (row, body) => { if (!row) fail(404, 'Item not found.'); if (!Number.isSafeInteger(body?.version)) fail(400, 'Item version is required.'); if (body.version !== row.version) fail(409, 'Someone else changed this item. Refresh and try again.'); };

  async function handle(request, response, url, user) {
    const method = request.method, route = url.pathname;
    if (route === '/api/auth/recover' && method === 'POST') {
      const body = await readBody(request);
      rateLimit(request, String(body?.username));
      if (!names.has(body?.username) || typeof body.recoveryCode !== 'string' || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail(400, 'Enter your member name, recovery code, and a new password of 10–128 characters.');
      const stored = db.prepare('SELECT recovery_hash FROM users WHERE username=?').get(body.username);
      if (!stored?.recovery_hash || hash(body.recoveryCode.trim()) !== stored.recovery_hash) fail(403, 'The recovery code is incorrect or no longer valid.');
      const expectedRecovery = stored.recovery_hash;
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await deriveKey(body.password, salt, 64, keyOptions)).toString('hex');
      // The KDF yields: recheck and consume the recovery code atomically.
      const changed = db.prepare('UPDATE users SET salt=?,password_hash=?,recovery_hash=NULL WHERE username=? AND recovery_hash=?').run(salt, passwordHash, body.username, expectedRecovery);
      if (!changed.changes) fail(403, 'That recovery code has already been used.');
      db.prepare('DELETE FROM sessions WHERE username=?').run(body.username);
      json(response, 200, { ok: true }); return true;
    }
    if (!user) return false;
    if (route === '/api/events' && method === 'GET') {
      if ([...clients].filter(c => c.user === user.username).length >= 8) fail(429, 'Too many live connections. Close another tab.');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`event: ready\ndata: ${revision}\n\n`);
      const client = { request, response, user: user.username }; clients.add(client);
      response.on('close', () => clients.delete(client)); return true;
    }
    if (route === '/api/account/password' && method === 'POST') {
      const body = await readBody(request); rateLimit(request, user.username);
      if (typeof body?.currentPassword !== 'string' || body.currentPassword.length > 128 || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail(400, 'Use a new password of 10–128 characters.');
      const stored = db.prepare('SELECT * FROM users WHERE username=?').get(user.username);
      const key = await deriveKey(body.currentPassword, stored.salt, 64, keyOptions);
      if (!timingSafeEqual(key, Buffer.from(stored.password_hash, 'hex'))) fail(403, 'Current password is incorrect.');
      const salt = randomBytes(16).toString('hex'), nextHash = (await deriveKey(body.password, salt, 64, keyOptions)).toString('hex');
      if (!db.prepare('UPDATE users SET salt=?,password_hash=? WHERE username=? AND password_hash=?').run(salt, nextHash, user.username, stored.password_hash).changes) fail(409, 'Your account changed. Sign in again.');
      db.prepare('DELETE FROM sessions WHERE username=?').run(user.username); newSession(request, response, user.username);
      json(response, 200, { ok: true }); return true;
    }
    if (route === '/api/account/recovery' && method === 'POST') {
      const body = await readBody(request); rateLimit(request, user.username);
      if (typeof body?.currentPassword !== 'string' || body.currentPassword.length > 128) fail(400, 'Enter your current password.');
      const stored = db.prepare('SELECT * FROM users WHERE username=?').get(user.username);
      if (!timingSafeEqual(await deriveKey(body.currentPassword, stored.salt, 64, keyOptions), Buffer.from(stored.password_hash, 'hex'))) fail(403, 'Current password is incorrect.');
      if (db.prepare('SELECT password_hash FROM users WHERE username=?').get(user.username).password_hash !== stored.password_hash) fail(409, 'Your account changed. Sign in again.');
      const recoveryCode = randomBytes(24).toString('hex');
      db.prepare('UPDATE users SET recovery_hash=? WHERE username=?').run(hash(recoveryCode), user.username);
      json(response, 200, { recoveryCode }); return true;
    }
    if (route === '/api/invitations' && method === 'POST') {
      admin(user); const code = randomBytes(24).toString('hex');
      db.prepare("INSERT INTO settings VALUES('invite_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(code));
      activity(user.username, 'rotated invite for', 'Team registration');
      reply(response, user, 200, { inviteCode: code }); return true;
    }
    if (route === '/api/notifications/read' && method === 'POST') {
      db.prepare('UPDATE notifications SET is_read=1 WHERE username=?').run(user.username);
      reply(response, user); return true;
    }
    if (route === '/api/export' && method === 'GET') {
      json(response, 200, { format: 'nextstep-workspace', version: 2, exportedAt: new Date().toISOString(), ...snapshot(user) }); return true;
    }
    if (route === '/api/focus' && method === 'POST') {
      const body = await readBody(request);
      if (!Number.isInteger(body?.minutes) || body.minutes < 1 || body.minutes > 180) fail(400, 'Focus sessions must be 1–180 minutes.');
      if (db.prepare('SELECT created_at FROM focus_logs WHERE username=? ORDER BY created_at DESC LIMIT 1').get(user.username)?.created_at > Date.now() - body.minutes * 60000) fail(429, 'A focus session was already logged recently.');
      db.prepare('INSERT INTO focus_logs VALUES(?,?,?,?)').run(randomUUID(), user.username, body.minutes, Date.now());
      reply(response, user); return true;
    }
    if (route === '/api/tasks' && method === 'POST') {
      if (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL').get().n >= 1000) fail(409, 'The workspace is limited to 1,000 active tasks.');
      const t = validate(await readBody(request), null, user), id = randomUUID(), now = Date.now();
      db.prepare('INSERT INTO tasks(id,title,subject,deadline,assignee,completed,created_at,updated_at,created_by,updated_by,version,deleted_at,priority,status,reviewer,milestone_id,dependencies,links) VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL,?,?,?,?,?,?)').run(id, t.title, t.subject, t.deadline, t.assignee, Number(t.status === 'done'), now, now, user.username, user.username, t.priority, t.status, t.reviewer, t.milestoneId, JSON.stringify(t.dependencies), JSON.stringify(t.links));
      activity(user.username, 'created', t.title);
      if (t.assignee !== user.username) notify(t.assignee, `${names.get(user.username)} assigned you: ${t.title}`, id);
      if (t.status === 'review') notify(t.reviewer, `Review requested: ${t.title}`, id);
      reply(response, user, 201); return true;
    }
    const match = route.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(restore|comments))?$/);
    if (match && ['PUT', 'DELETE', 'POST'].includes(method)) {
      const body = await readBody(request), row = db.prepare('SELECT * FROM tasks WHERE id=?').get(match[1]);
      if (match[2] === 'comments' && method === 'POST') {
        if (!row || row.deleted_at) fail(404, 'Task not found.');
        const comment = text(body?.body, 2000, true);
        if (db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id=?').get(row.id).n >= 200) fail(409, 'This task has reached its 200-comment limit.');
        db.prepare('INSERT INTO comments VALUES(?,?,?,?,?)').run(randomUUID(), row.id, user.username, comment, Date.now());
        for (const member of new Set([row.assignee, row.reviewer, row.created_by])) if (member !== user.username) notify(member, `${names.get(user.username)} commented on ${row.title}`, row.id);
        activity(user.username, 'commented on', row.title); reply(response, user, 201); return true;
      }
      version(row, body);
      if (match[2] === 'restore' && method === 'POST') {
        if (!row.deleted_at) fail(409, 'Task is already restored.');
        if (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL').get().n >= 1000) fail(409, 'The workspace is full.');
        // Restore as To do if its prerequisites have since changed or disappeared.
        const deps = JSON.parse(row.dependencies).filter(id => db.prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL').get(id));
        db.prepare("UPDATE tasks SET deleted_at=NULL,status='todo',completed=0,dependencies=?,milestone_id=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?").run(JSON.stringify(deps), db.prepare('SELECT id FROM milestones WHERE id=?').get(row.milestone_id) ? row.milestone_id : '', Date.now(), user.username, row.id);
        activity(user.username, 'restored', row.title);
      } else if (!match[2] && method === 'DELETE') {
        if (row.deleted_at) fail(404, 'Task is already deleted.');
        if (db.prepare('SELECT dependencies FROM tasks WHERE deleted_at IS NULL AND id<>?').all(row.id).some(t => JSON.parse(t.dependencies).includes(row.id))) fail(409, 'Remove this prerequisite from its dependent tasks before deleting it.');
        db.prepare('UPDATE tasks SET deleted_at=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(Date.now(), Date.now(), user.username, row.id);
        activity(user.username, 'deleted', row.title);
        reply(response, user, 200, { deletedTask: task(db.prepare('SELECT * FROM tasks WHERE id=?').get(row.id)) }); return true;
      } else if (!match[2] && method === 'PUT') {
        if (row.deleted_at) fail(404, 'Task was deleted.');
        const t = validate(body, row, user);
        db.prepare('UPDATE tasks SET title=?,subject=?,deadline=?,assignee=?,completed=?,priority=?,status=?,reviewer=?,milestone_id=?,dependencies=?,links=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(t.title, t.subject, t.deadline, t.assignee, Number(t.status === 'done'), t.priority, t.status, t.reviewer, t.milestoneId, JSON.stringify(t.dependencies), JSON.stringify(t.links), Date.now(), user.username, row.id);
        activity(user.username, t.status !== row.status ? `moved to ${t.status.replace('_', ' ')}:` : 'updated', t.title);
        if (t.assignee !== row.assignee && t.assignee !== user.username) notify(t.assignee, `${names.get(user.username)} assigned you: ${t.title}`, row.id);
        if (t.status === 'review' && row.status !== 'review') notify(t.reviewer, `Review requested: ${t.title}`, row.id);
        if (row.status === 'review' && ['done', 'in_progress'].includes(t.status)) notify(t.assignee, `${t.status === 'done' ? 'Approved' : 'Changes requested'}: ${t.title}`, row.id);
      } else fail(405, 'Method not allowed.');
      reply(response, user); return true;
    }
    if (route === '/api/milestones' && method === 'POST') {
      const b = await readBody(request);
      if (db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n >= 100) fail(409, 'Milestone limit reached.');
      const title = text(b?.title, 120, true), deadline = date(b.deadline ?? ''), description = text(b.description ?? '', 1000);
      db.prepare('INSERT INTO milestones VALUES(?,?,?,?,1)').run(randomUUID(), title, deadline, description);
      activity(user.username, 'created milestone', title); reply(response, user, 201); return true;
    }
    const milestone = route.match(/^\/api\/milestones\/([a-f0-9-]{36})$/);
    if (milestone && ['PUT', 'DELETE'].includes(method)) {
      const b = await readBody(request), row = db.prepare('SELECT * FROM milestones WHERE id=?').get(milestone[1]); version(row, b);
      if (method === 'DELETE') {
        if (db.prepare('SELECT id FROM tasks WHERE milestone_id=? AND deleted_at IS NULL').get(row.id)) fail(409, 'Unassign this milestone from its tasks first.');
        db.prepare('DELETE FROM milestones WHERE id=?').run(row.id);
      } else db.prepare('UPDATE milestones SET title=?,deadline=?,description=?,version=version+1 WHERE id=?').run(text(b.title, 120, true), date(b.deadline ?? ''), text(b.description ?? '', 1000), row.id);
      activity(user.username, method === 'DELETE' ? 'deleted milestone' : 'updated milestone', row.title); reply(response, user); return true;
    }
    if (route === '/api/resources' && method === 'POST') {
      const b = await readBody(request);
      if (db.prepare('SELECT COUNT(*) AS n FROM resources').get().n >= 200) fail(409, 'Resource limit reached.');
      const title = text(b?.title, 120, true), url = link(b.url);
      db.prepare('INSERT INTO resources VALUES(?,?,?,?,?)').run(randomUUID(), title, url, user.username, Date.now());
      activity(user.username, 'shared resource', title); reply(response, user, 201); return true;
    }
    const resource = route.match(/^\/api\/resources\/([a-f0-9-]{36})$/);
    if (resource && method === 'DELETE') {
      const row = db.prepare('SELECT * FROM resources WHERE id=?').get(resource[1]);
      if (!row) fail(404, 'Resource not found.');
      if (row.username !== user.username && user.username !== 'sudip') fail(403, 'Only the author or team lead can remove a resource.');
      db.prepare('DELETE FROM resources WHERE id=?').run(row.id); activity(user.username, 'removed resource', row.title); reply(response, user); return true;
    }
    if (route === '/api/meetings' && method === 'POST') {
      const b = await readBody(request), title = text(b?.title, 120, true), topic = text(b.topic ?? '', 1000);
      if (typeof b.startsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(b.startsAt) || !Number.isFinite(Date.parse(b.startsAt)) || Date.parse(b.startsAt) <= Date.now()) fail(400, 'Choose a future date and time for the session.');
      if (db.prepare('SELECT COUNT(*) AS n FROM meetings').get().n >= 100) fail(409, 'Session limit reached.');
      const id = randomUUID();
      db.prepare('INSERT INTO meetings VALUES(?,?,?,?,?,1)').run(id, title, new Date(b.startsAt).toISOString(), topic, user.username);
      db.prepare('INSERT INTO rsvps VALUES(?,?,?)').run(id, user.username, 'yes');
      for (const m of members) if (m.username !== user.username) notify(m.username, `New study session: ${title}`);
      activity(user.username, 'scheduled', title); reply(response, user, 201); return true;
    }
    const meeting = route.match(/^\/api\/meetings\/([a-f0-9-]{36})(\/rsvp)?$/);
    if (meeting && ['POST', 'DELETE'].includes(method)) {
      const row = db.prepare('SELECT * FROM meetings WHERE id=?').get(meeting[1]);
      if (!row) fail(404, 'Session not found.');
      if (meeting[2] && method === 'POST') {
        const b = await readBody(request); if (!['yes', 'maybe', 'no'].includes(b?.answer)) fail(400, 'Choose yes, maybe, or no.');
        db.prepare('INSERT INTO rsvps VALUES(?,?,?) ON CONFLICT(meeting_id,username) DO UPDATE SET answer=excluded.answer').run(row.id, user.username, b.answer);
      } else if (!meeting[2] && method === 'DELETE') {
        if (row.username !== user.username && user.username !== 'sudip') fail(403, 'Only the organizer or team lead can cancel a session.');
        db.prepare('DELETE FROM meetings WHERE id=?').run(row.id);
        for (const m of members) if (m.username !== user.username) notify(m.username, `Session cancelled: ${row.title}`);
        activity(user.username, 'cancelled', row.title);
      } else fail(405, 'Method not allowed.');
      reply(response, user); return true;
    }
    return false;
  }
  return { handle, task, extra, broadcast, validInvite: code => {
    const override = db.prepare("SELECT value FROM settings WHERE key='invite_hash'").get()?.value;
    return typeof code === 'string' && hash(code.trim()) === (override || hash(inviteCode));
  }, close: () => { clearInterval(timer); for (const client of clients) client.response.end(); clients.clear(); } };
}
