import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const PASSWORD = 'test-only-password-123';
const INVITE = 'test-only-invite-code';
async function start(options = {}) {
  const app = createApp({ databasePath: ':memory:', inviteCode: INVITE, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  async function request(route, { method = 'GET', body, cookie = '', requestOrigin = origin } = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: requestOrigin }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], fullCookie: response.headers.get('set-cookie') };
  }
  const stop = () => new Promise(resolve => app.server.close(() => { app.close(); resolve(); }));
  return { request, stop };
}
const registration = username => ({ username, password: PASSWORD, inviteCode: INVITE });

test('four accounts share tasks, preserve assignments, reject stale edits, and undo deletion', async () => {
  const app = await start();
  try {
    assert.equal((await app.request('/api/workspace')).status, 401);
    const accounts = {};
    for (const username of ['eric', 'abinash', 'sondor', 'sudip']) {
      const result = await app.request('/api/auth/register', { method: 'POST', body: registration(username) });
      assert.equal(result.status, 200);
      assert.match(result.fullCookie, /HttpOnly; SameSite=Lax/);
      accounts[username] = result.cookie;
    }
    const created = await app.request('/api/tasks', { method: 'POST', cookie: accounts.sudip, body: { title: '<script>literal text</script>', subject: 'Web Programming', deadline: '2026-11-01', assignee: 'eric' } });
    assert.equal(created.status, 201);
    const task = created.data.tasks[0];
    assert.equal(task.createdBy, 'sudip');
    assert.equal(task.assignee, 'eric');
    const ericView = await app.request('/api/workspace', { cookie: accounts.eric });
    assert.equal(ericView.data.tasks[0].id, task.id);
    const completed = await app.request('/api/tasks/' + task.id, { method: 'PUT', cookie: accounts.eric, body: { ...task, completed: true } });
    assert.equal(completed.status, 200);
    assert.equal(completed.data.tasks[0].updatedBy, 'eric');
    assert.equal(completed.data.tasks[0].completed, true);
    assert.equal((await app.request('/api/tasks/' + task.id, { method: 'PUT', cookie: accounts.sudip, body: { ...task, title: 'A stale edit' } })).status, 409);
    const deleted = await app.request('/api/tasks/' + task.id, { method: 'DELETE', cookie: accounts.sondor, body: { version: completed.data.tasks[0].version } });
    assert.equal(deleted.data.tasks.length, 0);
    const restored = await app.request('/api/tasks/' + task.id + '/restore', { method: 'POST', cookie: accounts.abinash, body: { version: deleted.data.deletedTask.version } });
    assert.equal(restored.data.tasks.length, 1);
    assert.equal(restored.data.activity[0].username, 'abinash');
    assert.equal(restored.data.activity[0].action, 'restored');
    assert.equal(restored.data.members.every(member => member.registered), true);
    await app.request('/api/auth/logout', { method: 'POST', cookie: accounts.eric });
    assert.equal((await app.request('/api/workspace', { cookie: accounts.eric })).status, 401);
  } finally { await app.stop(); }
});

test('registration, origin, task validation, and private-file protections', async () => {
  const app = await start();
  try {
    assert.equal((await app.request('/api/auth/register', { method: 'POST', body: { ...registration('eric'), inviteCode: 'wrong' } })).status, 403);
    assert.equal((await app.request('/api/auth/register', { method: 'POST', body: registration('unknown') })).status, 400);
    const account = await app.request('/api/auth/register', { method: 'POST', body: registration('eric') });
    assert.equal((await app.request('/api/auth/register', { method: 'POST', body: registration('eric') })).status, 409);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: { username: 'eric', password: 'incorrect-password' } })).status, 401);
    assert.equal((await app.request('/api/tasks', { method: 'POST', cookie: account.cookie, requestOrigin: 'https://unrelated.example', body: { title: 'Blocked' } })).status, 403);
    for (const body of [{ title: ' ' }, { title: 'x', deadline: '2026-02-30' }, { title: 'x', assignee: 'stranger' }, { title: 'x', completed: 'yes' }]) {
      assert.equal((await app.request('/api/tasks', { method: 'POST', cookie: account.cookie, body })).status, 400);
    }
    for (const route of ['/data/nextstep.sqlite', '/.env', '/server.mjs', '/tests/server.test.mjs', '/package.json']) assert.equal((await app.request(route)).status, 404);
    const login = await app.request('/api/auth/login', { method: 'POST', body: { username: 'eric', password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal((await app.request('/api/workspace', { cookie: account.cookie })).status, 200);
  } finally { await app.stop(); }
});

test('database tasks and sessions survive a server restart', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextstep-test-'));
  const databasePath = path.join(temp, 'test.sqlite');
  let app = await start({ databasePath });
  try {
    const account = await app.request('/api/auth/register', { method: 'POST', body: registration('sudip') });
    await app.request('/api/tasks', { method: 'POST', cookie: account.cookie, body: { title: 'Persistent task' } });
    await app.stop();
    app = await start({ databasePath });
    const result = await app.request('/api/workspace', { cookie: account.cookie });
    assert.equal(result.status, 200);
    assert.equal(result.data.tasks[0].title, 'Persistent task');
    assert.equal(fs.readFileSync(databasePath).toString().includes(PASSWORD), false);
  } finally { await app.stop(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('production config rejects development settings and uses secure cookies', async () => {
  assert.throws(() => createApp({ production: true, databasePath: ':memory:', inviteCode: INVITE }), /APP_ORIGIN/);
  assert.throws(() => createApp({ production: true, origin: 'https://planner.example', databasePath: ':memory:', inviteCode: 'nextstep-local-team' }), /TEAM_INVITE_CODE/);
  const app = await start({ production: true, origin: 'https://planner.example' });
  try {
    const result = await app.request('/api/auth/register', { method: 'POST', requestOrigin: 'https://planner.example', body: registration('sudip') });
    assert.equal(result.status, 200);
    assert.match(result.fullCookie, /; Secure/);
  } finally { await app.stop(); }
});
