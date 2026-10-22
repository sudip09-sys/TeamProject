import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';

const password = 'only-for-automated-tests', invite = 'only-for-automated-test-invites';
async function start(databasePath = ':memory:') {
  const app = createApp({ databasePath, inviteCode: invite });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const accounts = {};
  async function req(route, method = 'GET', body, member = 'sudip', cookieOverride) {
    const response = await fetch(origin + '/api/' + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookieOverride ?? accounts[member] ?? '' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, data, cookie };
  }
  for (const username of ['sudip','eric','abinash','sondor']) {
    const result = await req('auth/register','POST',{ username, password, inviteCode: invite },username,'');
    if (result.status === 200) accounts[username] = result.cookie;
  }
  return { req, origin, accounts, stop: () => { app.stopStreams(); return new Promise(resolve => app.server.close(() => { app.close(); resolve(); })); } };
}
async function add(app, body) {
  const result = await app.req('tasks','POST',body); assert.equal(result.status,201,JSON.stringify(result.data));
  return result.data.tasks.find(task => task.title === body.title);
}
async function update(app, task, fields, member = 'sudip') { return app.req('tasks/'+task.id,'PUT',{...task,...fields},member); }

test('review workflow enforces reviewer permission, notifies participants, and preserves comments and links', async () => {
  const app = await start();
  try {
    let task = await add(app,{title:'Build homepage',assignee:'eric',reviewer:'abinash',priority:'high',links:[{title:'Work',url:'https://github.com/example/project'}]});
    assert.equal(task.priority,'high');
    assert.match((await app.req('workspace','GET',undefined,'eric')).data.notifications[0].message,/assigned you/);
    assert.equal((await update(app,task,{status:'in_progress'},'sondor')).status,403);
    let result = await update(app,task,{status:'in_progress'},'eric'); assert.equal(result.status,200); task=result.data.tasks[0];
    assert.equal((await update(app,task,{status:'done'},'eric')).status,403);
    result=await update(app,task,{status:'review'},'eric'); assert.equal(result.status,200); task=result.data.tasks[0];
    assert.match((await app.req('workspace','GET',undefined,'abinash')).data.notifications[0].message,/Review requested/);
    assert.equal((await update(app,task,{status:'done'},'sudip')).status,403);
    assert.equal((await update(app,task,{status:'done',reviewer:''},'eric')).status,403);
    result=await update(app,task,{status:'in_progress'},'abinash'); assert.equal(result.status,200); task=result.data.tasks[0];
    result=await update(app,task,{status:'review'},'eric'); task=result.data.tasks[0];
    const comment=await app.req('tasks/'+task.id+'/comments','POST',{body:'<img src=x onerror=alert(1)> Please check spacing.'},'abinash');
    assert.equal(comment.status,201); assert.match(comment.data.comments[0].body,/<img/);
    result=await update(app,task,{status:'done'},'abinash'); assert.equal(result.status,200); assert.equal(result.data.tasks[0].completed,true);
    const ownerView=(await app.req('workspace','GET',undefined,'eric')).data;
    assert(ownerView.notifications.some(n=>n.message.includes('Approved')));
    assert.equal(result.data.tasks[0].links[0].url,'https://github.com/example/project');
    assert.equal((await app.req('notifications/read','POST',undefined,'eric')).data.notifications.every(n=>n.isRead),true);
    assert.equal((await app.req('workspace','GET',undefined,'sondor')).data.notifications.length,0);
    const serialized=JSON.stringify((await app.req('export')).data); assert(!serialized.includes('password_hash')); assert(!serialized.includes('token_hash'));
  } finally { await app.stop(); }
});

test('dependency graph rejects cycles and blocks starting, deletion, and premature reopening', async () => {
  const app = await start();
  try {
    let first=await add(app,{title:'Slides'}), second=await add(app,{title:'Rehearsal',dependencies:[first.id]});
    assert.equal((await update(app,second,{status:'in_progress'})).status,409);
    assert.equal((await update(app,first,{dependencies:[second.id]})).status,409);
    assert.equal((await app.req('tasks/'+first.id,'DELETE',{version:first.version})).status,409);
    let result=await update(app,first,{status:'done'}); first=result.data.tasks.find(t=>t.id===first.id);
    result=await update(app,second,{status:'in_progress'}); assert.equal(result.status,200); second=result.data.tasks.find(t=>t.id===second.id);
    assert.equal((await update(app,first,{status:'todo'})).status,409);
    assert.equal((await update(app,second,{dependencies:[second.id]})).status,400);
    assert.equal((await update(app,second,{priority:'urgent'})).status,400);
    assert.equal((await update(app,second,{links:[{title:'Bad',url:'javascript:alert(1)'}]})).status,400);
    assert.equal((await update(app,second,{reviewer:'eric',assignee:'eric'})).status,400);
    assert.equal((await update(app,{...first,version:1},{title:'Stale'})).status,409);
  } finally { await app.stop(); }
});

test('milestones, resources, scheduled sessions, RSVP and server side ownership checks', async () => {
  const app = await start();
  try {
    let result=await app.req('milestones','POST',{title:'Midterm',deadline:'2026-11-20',description:'Demonstration'});
    assert.equal(result.status,201);const milestone=result.data.milestones[0];
    await add(app,{title:'Demo',milestoneId:milestone.id});
    assert.equal((await app.req('milestones/'+milestone.id,'DELETE',{version:1})).status,409);
    assert.equal((await app.req('milestones/'+milestone.id,'PUT',{...milestone,title:'Midterm demo'})).status,200);
    assert.equal((await app.req('milestones/'+milestone.id,'PUT',{...milestone,title:'Stale'})).status,409);
    assert.equal((await app.req('resources','POST',{title:'Unsafe',url:'data:text/html,hello'})).status,400);
    result=await app.req('resources','POST',{title:'Repository',url:'https://github.com/sudip09-sys/TeamProject'},'eric');const resource=result.data.resources[0];
    assert.equal((await app.req('resources/'+resource.id,'DELETE',undefined,'sondor')).status,403);
    assert.equal((await app.req('resources/'+resource.id,'DELETE',undefined,'eric')).status,200);
    assert.equal((await app.req('meetings','POST',{title:'Past',startsAt:'2020-01-01T00:00:00Z'})).status,400);
    result=await app.req('meetings','POST',{title:'Study together',startsAt:new Date(Date.now()+86400000).toISOString(),topic:'Review the app'},'eric');
    assert.equal(result.status,201);const meeting=result.data.meetings[0];
    result=await app.req('meetings/'+meeting.id+'/rsvp','POST',{answer:'maybe'},'abinash');
    assert(result.data.meetings[0].rsvps.some(r=>r.username==='abinash'&&r.answer==='maybe'));
    assert.equal((await app.req('meetings/'+meeting.id,'DELETE',undefined,'sondor')).status,403);
    assert.equal((await app.req('meetings/'+meeting.id,'DELETE',undefined,'eric')).status,200);
    assert.equal((await app.req('focus','POST',{minutes:25})).status,200);
    assert.equal((await app.req('focus','POST',{minutes:25})).status,429);
  } finally { await app.stop(); }
});

test('password change revokes old sessions, recovery code is one use, and invites are lead-only', async () => {
  const app = await start();
  try {
    const oldCookie=app.accounts.eric;
    assert.equal((await app.req('account/recovery','POST',{currentPassword:'wrong'},'eric')).status,403);
    const recovery=await app.req('account/recovery','POST',{currentPassword:password},'eric');
    assert.equal(recovery.status,200);assert.equal(recovery.data.recoveryCode.length,48);
    let result=await app.req('account/password','POST',{currentPassword:password,password:'new-test-password-123'},'eric');
    assert.equal(result.status,200);app.accounts.eric=result.cookie;
    assert.equal((await app.req('workspace','GET',undefined,'eric',oldCookie)).status,401);
    assert.equal((await app.req('auth/recover','POST',{username:'eric',password:'recovered-password-123',recoveryCode:recovery.data.recoveryCode})).status,200);
    assert.equal((await app.req('workspace','GET',undefined,'eric')).status,401);
    assert.equal((await app.req('auth/recover','POST',{username:'eric',password:'recovered-password-123',recoveryCode:recovery.data.recoveryCode})).status,403);
    result=await app.req('auth/login','POST',{username:'eric',password:'recovered-password-123'},'eric','');assert.equal(result.status,200);app.accounts.eric=result.cookie;
    assert.equal((await app.req('invitations','POST',undefined,'eric')).status,403);
    result=await app.req('invitations','POST');assert.equal(result.status,200);const code=result.data.inviteCode;
    assert.equal((await app.req('auth/register','POST',{username:'sudip',password,inviteCode:invite})).status,403);
    assert.equal((await app.req('auth/register','POST',{username:'sudip',password,inviteCode:' '+code+'\n'})).status,409);
  } finally { await app.stop(); }
});

test('authenticated event stream signals shared mutations without leaking workspace data', async () => {
  const app = await start();
  try {
    const controller=new AbortController();
    const response=await fetch(app.origin+'/api/events',{headers:{Cookie:app.accounts.eric},signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
    const reader=response.body.getReader();const decoder=new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value),/event: ready/);
    await add(app,{title:'Live shared task'});
    const changed=decoder.decode((await reader.read()).value);assert.match(changed,/event: changed/);assert(!changed.includes('Live shared task'));
    controller.abort();await reader.cancel().catch(()=>{});
    assert.equal((await app.req('events','GET',undefined,'stranger')).status,401);
  } finally { await app.stop(); }
});

test('old database migrates with accounts, task completion, and an intact pre-migration backup', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nextstep-migrate-')),databasePath=path.join(temp,'nextstep.sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE users(username TEXT PRIMARY KEY,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,subject TEXT NOT NULL,deadline TEXT NOT NULL,assignee TEXT NOT NULL,completed INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,created_by TEXT NOT NULL,updated_by TEXT NOT NULL,version INTEGER NOT NULL,deleted_at INTEGER);
    INSERT INTO users VALUES('sudip','salt','hash',1);
    INSERT INTO tasks VALUES('old-task','Existing completed task','Web','2026-10-22','sudip',1,1,1,'sudip','sudip',7,NULL);`);db.close();
  let app;
  try {
    app=createApp({databasePath,inviteCode:invite});app.close();app=null;
    const migrated=new DatabaseSync(databasePath);const row=migrated.prepare('SELECT * FROM tasks').get();
    assert.equal(row.status,'done');assert.equal(row.priority,'medium');assert.equal(row.version,7);assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,2);migrated.close();
    const backups=fs.readdirSync(path.join(temp,'backups'));assert.equal(backups.length,1);
    const backup=new DatabaseSync(path.join(temp,'backups',backups[0]));assert.equal(backup.prepare('SELECT title FROM tasks').get().title,'Existing completed task');assert.equal(backup.prepare('PRAGMA user_version').get().user_version,0);backup.close();
    app=createApp({databasePath,inviteCode:invite});app.close();app=null;
  } finally { app?.close();fs.rmSync(temp,{recursive:true,force:true}); }
});
