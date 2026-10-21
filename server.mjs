import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const deriveKey = promisify(scrypt);
export const MEMBERS = [
  { username: 'eric', name: 'Eric' },
  { username: 'abinash', name: 'Abinash' },
  { username: 'sondor', name: 'Sondor' },
  { username: 'sudip', name: 'Sudip' }
];
const names = new Map(MEMBERS.map(member => [member.username, member.name]));
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const keyOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function validDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function fault(status, message) { return Object.assign(new Error(message), { status }); }
function validateTask(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault(400, 'Invalid task.');
  const { title, subject = '', deadline = '', assignee = '', completed = false } = body;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
      typeof subject !== 'string' || subject.trim().length > 60 ||
      typeof deadline !== 'string' || !validDate(deadline) ||
      typeof assignee !== 'string' || (assignee !== '' && !names.has(assignee)) ||
      typeof completed !== 'boolean') throw fault(400, 'Check the task title, subject, deadline, and assigned member.');
  return { title: title.trim(), subject: subject.trim(), deadline, assignee, completed };
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fault(415, 'Use a JSON request.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw fault(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault(400, 'Invalid JSON.'); }
}

export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const inviteCode = options.inviteCode ?? process.env.TEAM_INVITE_CODE ?? (production ? '' : 'nextstep-local-team');
  const origin = options.origin ?? process.env.APP_ORIGIN;
  if (production && (!origin || !/^https:\/\/[^/]+$/.test(origin))) throw new Error('Set APP_ORIGIN to the exact public HTTPS origin.');
  if (production && (inviteCode.length < 16 || /replace-with|nextstep-local-team/.test(inviteCode))) throw new Error('Set a private TEAM_INVITE_CODE with at least 16 characters.');
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(root, 'data', 'nextstep.sqlite');
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, subject TEXT NOT NULL, deadline TEXT NOT NULL, assignee TEXT NOT NULL, completed INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(username), updated_by TEXT NOT NULL REFERENCES users(username), version INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL REFERENCES users(username), action TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);`);
  const attempts = new Map();
  let closed = false;

  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  function tokenFrom(request) {
    return (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('nextstep_session='))?.slice('nextstep_session='.length) || '';
  }
  function sessionUser(request) {
    const token = tokenFrom(request);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const session = db.prepare('SELECT username FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    return session ? { username: session.username, name: names.get(session.username) } : null;
  }
  function newSession(request, response, username) {
    const old = tokenFrom(request);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(old));
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), username, Date.now() + SESSION_AGE);
    response.setHeader('Set-Cookie', `nextstep_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_AGE / 1000}${production ? '; Secure' : ''}`);
  }
  function rateLimit(request, username) {
    const now = Date.now();
    for (const [key, item] of attempts) if (item.until < now) attempts.delete(key);
    const key = request.socket.remoteAddress + ':' + username;
    const item = attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
    if (++item.count > 20) throw fault(429, 'Too many attempts. Please wait 15 minutes.');
    if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
    attempts.set(key, item);
  }
  function publicTask(row) {
    return { id: row.id, title: row.title, subject: row.subject, deadline: row.deadline, assignee: row.assignee, completed: Boolean(row.completed), createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by, updatedBy: row.updated_by, version: row.version };
  }
  function snapshot() {
    return {
      tasks: db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC').all().map(publicTask),
      activity: db.prepare('SELECT id,username,action,title,created_at AS createdAt FROM activity ORDER BY id DESC LIMIT 12').all(),
      members: MEMBERS.map(member => ({ ...member, registered: Boolean(db.prepare('SELECT username FROM users WHERE username=?').get(member.username)) }))
    };
  }
  function activity(username, action, title) {
    db.prepare('INSERT INTO activity(username,action,title,created_at) VALUES(?,?,?,?)').run(username, action, title, Date.now());
    db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 200)');
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const method = request.method;
      if (url.pathname === '/health' && method === 'GET') return json(response, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(method)) {
          const expected = origin || `http://${request.headers.host}`;
          if (request.headers.origin !== expected) throw fault(403, 'Request origin is not allowed.');
        }
        if (url.pathname === '/api/me' && method === 'GET') return json(response, 200, { user: sessionUser(request) });
        if (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') {
          if (method !== 'POST') throw fault(405, 'Method not allowed.');
          const body = await readBody(request);
          if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') throw fault(400, 'Enter your member name and password.');
          const username = body.username.toLowerCase().trim();
          rateLimit(request, username);
          if (!names.has(username) || body.password.length < 10 || body.password.length > 128) throw fault(400, 'Choose a team member and a password of 10–128 characters.');
          if (url.pathname.endsWith('/register')) {
            if (typeof body.inviteCode !== 'string' || hash(body.inviteCode) !== hash(inviteCode)) throw fault(403, 'The team invite code is incorrect.');
            if (db.prepare('SELECT username FROM users WHERE username=?').get(username)) throw fault(409, 'This member already has an account. Sign in instead.');
            const salt = randomBytes(16).toString('hex');
            const key = await deriveKey(body.password, salt, 64, keyOptions);
            try { db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(username, salt, key.toString('hex'), Date.now()); }
            catch (error) { if (error.code?.includes('CONSTRAINT')) throw fault(409, 'This member already has an account.'); throw error; }
          } else {
            const stored = db.prepare('SELECT * FROM users WHERE username=?').get(username);
            const key = await deriveKey(body.password, stored?.salt || 'unregistered-account-salt', 64, keyOptions);
            if (!stored || !timingSafeEqual(key, Buffer.from(stored.password_hash, 'hex'))) throw fault(401, 'The member name or password is incorrect.');
          }
          newSession(request, response, username);
          return json(response, 200, { user: { username, name: names.get(username) } });
        }
        const user = sessionUser(request);
        if (!user) throw fault(401, 'Sign in to your team workspace.');
        if (url.pathname === '/api/auth/logout' && method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(tokenFrom(request)));
          response.setHeader('Set-Cookie', `nextstep_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${production ? '; Secure' : ''}`);
          return json(response, 200, { ok: true });
        }
        if (url.pathname === '/api/workspace' && method === 'GET') return json(response, 200, snapshot());
        if (url.pathname === '/api/tasks' && method === 'POST') {
          const task = validateTask(await readBody(request));
          if (db.prepare('SELECT count(*) AS count FROM tasks WHERE deleted_at IS NULL').get().count >= 1000) throw fault(409, 'The workspace is limited to 1,000 active tasks.');
          const now = Date.now();
          db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(randomUUID(), task.title, task.subject, task.deadline, task.assignee, Number(task.completed), now, now, user.username, user.username, 1);
          activity(user.username, 'created', task.title);
          return json(response, 201, snapshot());
        }
        const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(\/restore)?$/);
        if (match && ['PUT', 'DELETE', 'POST'].includes(method)) {
          const body = await readBody(request);
          if (!Number.isSafeInteger(body?.version)) throw fault(400, 'Task version is required.');
          const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(match[1]);
          if (!row) throw fault(404, 'Task not found.');
          if (row.version !== body.version) throw fault(409, 'Someone else changed this task. Refresh the board and try again.');
          if (match[2] && method === 'POST') {
            if (!row.deleted_at) throw fault(409, 'This task has already been restored.');
            db.prepare('UPDATE tasks SET deleted_at=NULL,updated_by=?,updated_at=?,version=version+1 WHERE id=?').run(user.username, Date.now(), row.id);
            activity(user.username, 'restored', row.title);
          } else if (!match[2] && method === 'DELETE') {
            if (row.deleted_at) throw fault(404, 'Task was already deleted.');
            db.prepare('UPDATE tasks SET deleted_at=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(Date.now(), Date.now(), user.username, row.id);
            activity(user.username, 'deleted', row.title);
            return json(response, 200, { ...snapshot(), deletedTask: publicTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(row.id)) });
          } else if (!match[2] && method === 'PUT') {
            if (row.deleted_at) throw fault(404, 'Task was deleted.');
            const task = validateTask(body);
            db.prepare('UPDATE tasks SET title=?,subject=?,deadline=?,assignee=?,completed=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(task.title, task.subject, task.deadline, task.assignee, Number(task.completed), Date.now(), user.username, row.id);
            activity(user.username, task.completed !== Boolean(row.completed) ? (task.completed ? 'completed' : 'reopened') : 'updated', task.title);
          } else throw fault(405, 'Method not allowed.');
          return json(response, 200, snapshot());
        }
        throw fault(404, 'API route not found.');
      }
      if (!['GET', 'HEAD'].includes(method)) throw fault(405, 'Method not allowed.');
      // Explicit allowlist: database files, source, tests, and environment files are never public.
      const publicFiles = new Set(['/', '/index.html', '/app.js', '/styles.css', '/team.html', '/assets/mark.svg']);
      if (!publicFiles.has(url.pathname)) throw fault(404, 'Page not found.');
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filename = path.join(root, relative);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)], 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') response.end(); else fs.createReadStream(filename).pipe(response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      json(response, error.status || 500, { error: error.status ? error.message : 'The server could not complete the request.' });
      if (!error.status) console.error('Request failed:', error.message);
    }
  });
  server.requestTimeout = 20_000;
  return { server, close: () => { if (!closed) { db.close(); closed = true; } } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 4175);
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => {
    console.log(`NextStep team workspace: http://${host}:${app.server.address().port}`);
    if (process.env.NODE_ENV !== 'production' && !process.env.TEAM_INVITE_CODE) console.log('Local development invite code: nextstep-local-team');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.server.close(() => { app.close(); process.exit(0); }));
}
