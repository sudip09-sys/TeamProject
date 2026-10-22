(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names = { eric: 'Eric', abinash: 'Abinash', sondor: 'Sondor', sudip: 'Sudip' };
  const labels = { todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
  const pages = { dashboard: ['◈', 'Overview'], tasks: ['▦', 'Tasks & board'], milestones: ['⚑', 'Milestones'], calendar: ['▤', 'Calendar'], sessions: ['◎', 'Team sessions'], resources: ['↗', 'Resources'], break: ['✳', 'Study Break'], activity: ['↻', 'Contribution history'], settings: ['⚙', 'Account & data'] };
  let user = null, state = { tasks: [], members: [], activity: [], milestones: [], comments: [], resources: [], meetings: [], notifications: [], focus: [] };
  let page = 'dashboard', authMode = 'login', editing = null, deleted = null, listView = false, busy = false, syncing = false, needsSync = false, epoch = 0, stream = null, live = false;
  let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1), milestoneEditing = null;
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = () => dayKey(new Date());
  const shortDate = value => value ? new Date(value + 'T12:00:00').toLocaleDateString(undefined, {month:'short',day:'numeric'}) : 'No deadline';
  const timestamp = value => new Date(value).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
  const empty = message => `<p class="empty-state">${esc(message)}</p>`;
  const options = (items, selected) => items.map(([value,label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
  function notice(message, error = false) { $('notice').hidden = false; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
  function confirmAction(message) {
    return new Promise(resolve => {
      $('confirm-message').textContent = message; $('confirm-dialog').showModal();
      function finish(answer) { $('confirm-dialog').close(); $('confirm-dialog').oncancel = null; resolve(answer); }
      $('confirm-yes').onclick = () => finish(true); $('confirm-no').onclick = () => finish(false);
      $('confirm-dialog').oncancel = event => { event.preventDefault(); finish(false); };
    });
  }
  async function api(route, method = 'GET', body) {
    const response = await fetch('/api/' + route, { method, credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && user) showAuth('Your session ended. Sign in again.');
      throw Object.assign(new Error(result.error || 'The request failed.'), {status:response.status});
    }
    return result;
  }
  function apply(data) {
    state = data;
    render();
    if ($('task-dialog').open && editing) renderDiscussion(editing.id);
    $('sync-state').textContent = live ? 'Live · connected' : 'Saved · automatic sync';
  }
  async function sync() {
    if (!user) return;
    if (busy || syncing) { needsSync = true; return; }
    syncing = true; needsSync = false; const started = epoch, account = user;
    try { const data = await api('workspace'); if (started === epoch && user === account) apply(data); }
    catch (error) { if (user) { $('sync-state').textContent = 'Offline · retrying'; notice(error.message, true); } }
    finally { syncing = false; if (needsSync && !busy && user) { needsSync = false; queueMicrotask(sync); } }
  }
  async function mutate(route, method, body, success) {
    if (busy) return false;
    busy = true; epoch++;
    try {
      const data = await api(route, method, body);
      if (data.tasks) apply(data);
      if (success) await success(data);
      return true;
    } catch (error) {
      notice(error.message, true); if ($('task-dialog').open) $('task-feedback').textContent = error.message;
      if (error.status === 409) needsSync = true;
      return false;
    } finally { busy = false; if (needsSync && user) { needsSync = false; sync(); } }
  }
  function connectLive() {
    stream?.close(); live = false; stream = new EventSource('/api/events');
    stream.addEventListener('ready', () => { live = true; sync(); });
    stream.addEventListener('changed', sync);
    stream.addEventListener('expired', () => showAuth('Your session ended. Sign in again.'));
    stream.onerror = () => { live = false; $('sync-state').textContent = 'Reconnecting · automatic sync'; };
  }
  function showAuth(message = '') {
    user = null; epoch++; stream?.close(); stream = null; live = false;
    $('auth-screen').hidden = false; $('app-shell').hidden = true; $('auth-message').textContent = message;
    $('task-dialog').close(); $('confirm-dialog').close(); $('notifications-panel').hidden = true;
    $('recovery-output').textContent = ''; $('invite-output').textContent = '';
    $('password-form').reset(); $('recovery-form').reset(); $('auth-password').value = ''; $('auth-recovery').value = ''; $('auth-invite').value = '';
    window.dispatchEvent(new Event('nextstep-signout'));
  }
  async function enter(account) {
    user = account; epoch++;
    apply(await api('workspace'));
    $('current-member').textContent = user.name; $('invite-settings').hidden = user.username !== 'sudip';
    $('auth-screen').hidden = true; $('app-shell').hidden = false;
    $('auth-password').value = ''; $('auth-invite').value = ''; $('auth-recovery').value = '';
    go('dashboard'); connectLive();
    window.dispatchEvent(new CustomEvent('nextstep-signin', {detail:user.username}));
  }
  function setAuth(mode) {
    authMode = mode; $('invite-field').hidden = mode !== 'register'; $('auth-invite').required = mode === 'register';
    $('recovery-field').hidden = mode !== 'recover'; $('auth-recovery').required = mode === 'recover';
    $('password-label').textContent = mode === 'recover' ? 'New password' : 'Password';
    $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('auth-submit').textContent = mode === 'register' ? 'Create my account ↗' : mode === 'recover' ? 'Reset password' : 'Sign in to the team ↗';
    $('mode-login').setAttribute('aria-pressed', mode === 'login'); $('mode-register').setAttribute('aria-pressed', mode === 'register'); $('auth-message').textContent = '';
  }
  $('mode-login').onclick = () => setAuth('login'); $('mode-register').onclick = () => setAuth('register'); $('mode-recover').onclick = () => setAuth('recover');
  $('auth-form').onsubmit = async event => {
    event.preventDefault(); $('auth-submit').disabled = true;
    try {
      const result = await api('auth/' + authMode, 'POST', {username:$('auth-member').value, password:$('auth-password').value, inviteCode:$('auth-invite').value.trim(), recoveryCode:$('auth-recovery').value.trim()});
      if (authMode === 'recover') { setAuth('login'); $('auth-password').value = ''; $('auth-message').textContent = 'Password reset. Sign in, then generate a new recovery code in Account & data.'; }
      else await enter(result.user);
    } catch (error) { $('auth-message').textContent = error.message; }
    finally { $('auth-submit').disabled = false; }
  };
  $('navigation').innerHTML = Object.entries(pages).map(([id,[symbol,label]]) => `<button data-page="${id}" class="nav-item"><span aria-hidden="true">${symbol}</span><span>${label}</span></button>`).join('');
  function go(id) {
    if (!pages[id]) return;
    page = id;
    document.querySelectorAll('.page').forEach(section => section.hidden = section.id !== 'page-' + id);
    document.querySelectorAll('[data-page]').forEach(button => { button.classList.toggle('active', button.dataset.page === id); if (button.dataset.page === id) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
    render();
  }
  $('navigation').onclick = event => { const button = event.target.closest('[data-page]'); if (button) go(button.dataset.page); };
  const blocked = t => t.dependencies.some(id => state.tasks.find(other => other.id === id)?.status !== 'done');
  function stat(label,value,caption) { return `<article class="stat"><span class="eyebrow">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(caption)}</small></article>`; }
  function progress(m) {
    const tasks = state.tasks.filter(t => t.milestoneId === m.id), done = tasks.filter(t => t.status === 'done').length;
    return `<div class="progress-item"><div class="row between"><strong>${esc(m.title)}</strong><span class="muted">${done}/${tasks.length} done</span></div><progress max="${tasks.length || 1}" value="${done}" aria-label="${esc(m.title)} completion"></progress><small class="muted">${esc(shortDate(m.deadline))}</small></div>`;
  }
  function renderOverview() {
    const open = state.tasks.filter(t => t.status !== 'done'), done = state.tasks.length - open.length, overdue = open.filter(t => t.deadline && t.deadline < today());
    $('overview-stats').innerHTML = stat('STILL TO DO',open.length,'small steps ahead') + stat('OVERDUE',overdue.length,'ready for attention') + stat('COMPLETED',done,'wins worth celebrating') + stat('COMPLETION',`${state.tasks.length ? Math.round(done/state.tasks.length*100) : 0}%`,'across the shared board');
    $('team-members').innerHTML = state.members.map(m => { const count = open.filter(t => t.assignee === m.username).length; return `<div class="workload"><span class="avatar">${m.name[0]}</span><div class="grow"><strong>${esc(m.name)}</strong><small class="muted">${m.registered ? 'Account ready' : 'Not registered yet'}</small><progress max="${Math.max(1,open.length)}" value="${count}" aria-label="${esc(m.name)} open workload"></progress></div><span>${count} open</span></div>`; }).join('');
    const radar = open.filter(t => t.deadline && t.deadline <= today() || t.status === 'review' || blocked(t)).slice(0,5);
    $('radar').innerHTML = radar.length ? radar.map(t => `<button class="radar-item" data-open-task="${t.id}"><strong>${esc(t.title)}</strong><small>${blocked(t) ? 'Blocked by prerequisite' : t.status === 'review' ? 'Waiting for review' : esc(shortDate(t.deadline))}</small></button>`).join('') : empty('No urgent tasks. A good moment to plan ahead.');
    $('dashboard-milestones').innerHTML = state.milestones.slice(0,4).map(progress).join('') || empty('Add your first milestone to see the bigger picture.');
    $('focus-summary').innerHTML = state.members.map(m => { const f = state.focus.find(f => f.username === m.username); return `<p class="row between"><strong>${esc(m.name)}</strong><span>${f?.minutes || 0} minutes · ${f?.sessions || 0} sessions</span></p>`; }).join('');
  }
  function card(t) {
    const isBlocked = blocked(t);
    const links = t.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join(' · ');
    const canReview = t.status === 'review' && t.reviewer === user.username;
    return `<article class="task-card ${t.status === 'done' ? 'completed' : ''}" draggable="true" data-id="${t.id}"><div class="row between"><span class="badge priority-${t.priority}">${esc(t.priority)} priority</span><button class="icon-button" data-task-action="edit" data-id="${t.id}" aria-label="Open ${esc(t.title)}">↗</button></div><h3><button class="task-title-button" data-open-task="${t.id}">${esc(t.title)}</button></h3><p class="muted">${esc(t.subject || 'General')} ${t.milestoneId ? '· ' + esc(state.milestones.find(m=>m.id===t.milestoneId)?.title || '') : ''}</p><div class="row between"><span class="assigned"><span class="mini-avatar">${(names[t.assignee] || '—')[0]}</span>${esc(names[t.assignee] || 'Unassigned')}</span><span class="${t.deadline && t.deadline < today() && t.status !== 'done' ? 'overdue' : 'muted'}">${esc(shortDate(t.deadline))}</span></div>${isBlocked ? '<p class="blocked-label">⌁ Waiting for prerequisite tasks</p>' : ''}${t.reviewer ? `<small class="muted">Reviewer: ${esc(names[t.reviewer])}</small>` : ''}${links ? `<p class="work-links">${links}</p>` : ''}<label class="status-label">Move to<select data-task-status="${t.id}" aria-label="Status for ${esc(t.title)}">${options(Object.entries(labels),t.status)}</select></label>${canReview ? `<div class="row"><button data-review="done" data-id="${t.id}">Approve ✓</button><button data-review="in_progress" data-id="${t.id}">Request changes</button></div>` : ''}<div class="row between"><button class="text-button" data-open-task="${t.id}">${state.comments.filter(c=>c.taskId===t.id).length} comments</button><button class="text-button muted" data-task-action="delete" data-id="${t.id}">Delete</button></div></article>`;
  }
  function renderTasks() {
    const q = $('task-search').value.toLowerCase(), priority = $('priority-filter').value, member = $('member-filter').value, due = $('due-filter').value;
    const tasks = state.tasks.filter(t => (!q || `${t.title} ${t.subject} ${names[t.assignee] || ''}`.toLowerCase().includes(q)) && (!priority || t.priority === priority) && (!member || t.assignee === (member === 'mine' ? user.username : member)) && (!due || t.status !== 'done' && (due === 'today' ? t.deadline === today() : due === 'overdue' ? t.deadline && t.deadline < today() : t.deadline > today()))).sort((a,b) => ['high','medium','low'].indexOf(a.priority)-['high','medium','low'].indexOf(b.priority) || (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    $('task-count').textContent = `${tasks.length} of ${state.tasks.length} tasks · Move with the status menu or drag a card to a column.`;
    $('task-board').hidden = listView; $('task-list').hidden = !listView;
    if (listView) $('task-list').innerHTML = tasks.map(card).join('') || empty('No matching tasks. Add a task or adjust your filters.');
    else $('task-board').innerHTML = Object.entries(labels).map(([status,label]) => `<section class="kanban-column" data-drop-status="${status}" aria-label="${label}"><h2>${label}<span>${tasks.filter(t=>t.status===status).length}</span></h2><div class="card-stack">${tasks.filter(t=>t.status===status).map(card).join('') || empty('Room for your next step.')}</div></section>`).join('');
  }
  function renderMilestones() {
    $('milestone-list').innerHTML = state.milestones.map(m => `<article class="panel">${progress(m)}<p>${esc(m.description)}</p><div class="row"><button data-milestone-edit="${m.id}">Edit</button><button data-milestone-delete="${m.id}">Delete</button></div></article>`).join('') || empty('Start with a goal such as your midterm presentation.');
  }
  function renderCalendar() {
    $('calendar-month').textContent = month.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const first = new Date(month.getFullYear(),month.getMonth(),1), last = new Date(month.getFullYear(),month.getMonth()+1,0);
    let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<div class="calendar-heading">${day}</div>`).join('');
    for(let i=0;i<first.getDay();i++) html += '<div class="calendar-spacer"></div>';
    for(let d=1;d<=last.getDate();d++) {
      const key = dayKey(new Date(month.getFullYear(),month.getMonth(),d));
      const tasks = state.tasks.filter(t=>t.deadline===key), milestones = state.milestones.filter(m=>m.deadline===key), meetings = state.meetings.filter(m=>dayKey(new Date(m.startsAt))===key);
      html += `<div class="calendar-day ${key===today()?'is-today':''}"><time datetime="${key}">${d}</time>${tasks.map(t=>`<button class="calendar-event priority-${t.priority}" data-open-task="${t.id}">${esc(t.title)}</button>`).join('')}${milestones.map(m=>`<span class="calendar-event milestone-event">⚑ ${esc(m.title)}</span>`).join('')}${meetings.map(m=>`<button class="calendar-event session-event" data-go="sessions">◎ ${esc(m.title)}</button>`).join('')}</div>`;
    }
    $('calendar').innerHTML = html;
  }
  function renderSessions() {
    $('meeting-list').innerHTML = state.meetings.map(m=>`<article class="panel"><h2>${esc(m.title)}</h2><p><strong>${esc(timestamp(m.startsAt))}</strong></p><p class="pre-line">${esc(m.topic)}</p><small class="muted">Organized by ${esc(names[m.username])}</small><p>${state.members.map(member=>`${esc(member.name)}: ${esc(m.rsvps.find(r=>r.username===member.username)?.answer || 'no reply')}`).join(' · ')}</p><div class="row">${['yes','maybe','no'].map(answer=>`<button data-rsvp="${answer}" data-id="${m.id}" aria-pressed="${m.rsvps.some(r=>r.username===user.username&&r.answer===answer)}">${answer==='yes'?'Going':answer==='maybe'?'Maybe':'Can’t attend'}</button>`).join('')}</div><p><button data-copy-meeting="${m.id}">Copy invitation</button>${m.username===user.username||user.username==='sudip'?` <button data-cancel-meeting="${m.id}">Cancel session</button>`:''}</p></article>`).join('') || empty('Find a time to study, rehearse, or solve a problem together.');
  }
  function renderResources() {
    $('resource-list').innerHTML = state.resources.map(r=>`<article class="panel"><h2><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)} ↗</a></h2><p class="url-text">${esc(r.url)}</p><small class="muted">Shared by ${esc(names[r.username])}</small>${r.username===user.username||user.username==='sudip'?`<p><button data-remove-resource="${r.id}">Remove</button></p>`:''}</article>`).join('') || empty('Keep your repository, shared documents, and useful references here.');
  }
  function renderActivity() {
    $('activity-list').innerHTML = state.activity.map(a=>`<li><span class="avatar">${esc(names[a.username]?.[0] || '?')}</span><div><strong>${esc(names[a.username])}</strong> ${esc(a.action)} <strong>${esc(a.title)}</strong><small class="muted">${esc(timestamp(a.createdAt))}</small></div></li>`).join('') || empty('Your team’s changes will appear here.');
    $('contribution-summary').innerHTML = state.members.map(m=>stat(m.name,state.activity.filter(a=>a.username===m.username).length,'changes in recent history')).join('');
  }
  function renderInbox() {
    $('notification-count').textContent = state.notifications.filter(n=>!n.isRead).length;
    $('notifications-list').innerHTML = state.notifications.map(n=>`<li class="${n.isRead?'':'unread'}"><div>${n.taskId?`<button class="text-button" data-open-task="${n.taskId}">${esc(n.message)}</button>`:esc(n.message)}<small class="muted">${esc(timestamp(n.createdAt))}</small></div></li>`).join('') || empty('You’re all caught up.');
  }
  function render() {
    if (!user) return;
    renderInbox();
    if (page==='dashboard') renderOverview(); if(page==='tasks') renderTasks(); if(page==='milestones') renderMilestones(); if(page==='calendar') renderCalendar(); if(page==='sessions') renderSessions(); if(page==='resources') renderResources(); if(page==='activity') renderActivity();
  }
  function renderDiscussion(id) {
    const task = state.tasks.find(t=>t.id===id);
    $('task-meta').textContent = task ? `Created by ${names[task.createdBy]} · Last changed by ${names[task.updatedBy]} · ${timestamp(task.updatedAt)}${editing && editing.version !== task.version ? ' · Changed since you opened it. Close and reopen before editing.' : ''}` : 'This task is no longer on the board.';
    $('task-comments').innerHTML = state.comments.filter(c=>c.taskId===id).map(c=>`<article><strong>${esc(names[c.username])}</strong><small class="muted">${esc(timestamp(c.createdAt))}</small><p class="pre-line">${esc(c.body)}</p></article>`).join('') || empty('Start a conversation about this task.');
  }
  function openTask(id) {
    const t = id ? state.tasks.find(t=>t.id===id) : null;
    if(id&&!t) {notice('That task was deleted. Refresh the workspace.',true);return;}
    editing = t ? {...t} : null; $('task-form').reset(); $('task-feedback').textContent = ''; $('comment-body').value = '';
    $('task-dialog-title').textContent = t ? 'A closer look' : 'A new next step';
    for(const key of ['title','subject','deadline','priority','status','assignee','reviewer']) $('task-'+key).value = t?.[key] ?? ({priority:'medium',status:'todo'}[key] || '');
    document.querySelectorAll('.member-select').forEach(select=>select.innerHTML=options([['','None'],...Object.entries(names)],t?.[select.id==='task-assignee'?'assignee':'reviewer']||''));
    $('task-milestone').innerHTML=options([['','No milestone'],...state.milestones.map(m=>[m.id,m.title])],t?.milestoneId||'');
    $('task-dependencies').innerHTML=state.tasks.filter(other=>other.id!==id).map(other=>`<option value="${other.id}" ${t?.dependencies.includes(other.id)?'selected':''}>${esc(other.title)} (${labels[other.status]})</option>`).join('');
    $('task-links').value=t?.links.map(l=>`${l.title} | ${l.url}`).join('\n')||'';
    $('task-discussion').hidden=!t; if(t)renderDiscussion(t.id);
    if(!$('task-dialog').open) $('task-dialog').showModal(); $('task-title').focus();
  }
  $('new-task').onclick=()=>openTask(); $('close-task').onclick=()=>{$('task-dialog').close();editing=null;};
  $('task-form').onsubmit=async event=>{
    event.preventDefault();
    let links=[];
    try { links=$('task-links').value.split('\n').filter(line=>line.trim()).map(line=>{const at=line.indexOf('|');if(at<1)throw new Error('Use Label | https://example.com for each work link.');return {title:line.slice(0,at).trim(),url:line.slice(at+1).trim()};}); }
    catch(error){$('task-feedback').textContent=error.message;return;}
    const body={links,milestoneId:$('task-milestone').value,dependencies:[...$('task-dependencies').selectedOptions].map(o=>o.value)};
    for(const key of ['title','subject','deadline','priority','status','assignee','reviewer'])body[key]=$('task-'+key).value;
    if(editing)body.version=editing.version;
    $('save-task').disabled=true;
    await mutate(editing?'tasks/'+editing.id:'tasks',editing?'PUT':'POST',body,()=>{$('task-dialog').close();editing=null;notice('Task saved for the team.');});
    $('save-task').disabled=false;
  };
  $('comment-form').onsubmit=async event=>{event.preventDefault();if(!editing)return;await mutate(`tasks/${editing.id}/comments`,'POST',{body:$('comment-body').value},()=>{$('comment-body').value='';notice('Comment shared.');});};
  async function moveTask(id,status){const t=state.tasks.find(t=>t.id===id);if(!t)return;const ok=await mutate('tasks/'+id,'PUT',{...t,status,completed:status==='done'},()=>notice('Moved to '+labels[status]+'.'));if(!ok)renderTasks();}
  document.addEventListener('change',event=>{if(event.target.matches('[data-task-status]'))moveTask(event.target.dataset.taskStatus,event.target.value);});
  let dragged=null;
  $('task-board').addEventListener('dragstart',event=>{if(event.target.closest('button,input,select,a')){event.preventDefault();return;}const card=event.target.closest('[data-id]');if(card){dragged=card.dataset.id;event.dataTransfer.setData('text/plain',dragged);event.dataTransfer.effectAllowed='move';}});
  $('task-board').addEventListener('dragover',event=>{if(event.target.closest('[data-drop-status]'))event.preventDefault();});
  $('task-board').addEventListener('drop',event=>{const column=event.target.closest('[data-drop-status]');if(column&&dragged){event.preventDefault();moveTask(dragged,column.dataset.dropStatus);}dragged=null;});
  $('task-board').addEventListener('dragend',()=>dragged=null);
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||!user)return;
    if(button.dataset.openTask){openTask(button.dataset.openTask);return;}
    if(button.dataset.go){go(button.dataset.go);return;}
    if(button.dataset.review){moveTask(button.dataset.id,button.dataset.review);return;}
    if(button.dataset.taskAction){const t=state.tasks.find(t=>t.id===button.dataset.id);if(!t)return;if(button.dataset.taskAction==='edit')openTask(t.id);else if(await confirmAction('Delete “'+t.title+'”? You can undo this deletion.'))await mutate('tasks/'+t.id,'DELETE',{version:t.version},data=>{deleted=data.deletedTask;$('undo-panel').hidden=false;$('undo-message').textContent='Deleted: '+t.title;});return;}
    if(button.dataset.milestoneEdit){const m=state.milestones.find(m=>m.id===button.dataset.milestoneEdit);if(!m)return;milestoneEditing={...m};$('milestone-id').value=m.id;for(const key of ['title','deadline','description'])$('milestone-'+key).value=m[key];$('milestone-form-title').textContent='Edit milestone';$('cancel-milestone').hidden=false;$('milestone-title').focus();}
    if(button.dataset.milestoneDelete){const m=state.milestones.find(m=>m.id===button.dataset.milestoneDelete);if(m&&await confirmAction('Delete this milestone? It must first be unassigned from all tasks.'))await mutate('milestones/'+m.id,'DELETE',{version:m.version},()=>notice('Milestone removed.'));}
    if(button.dataset.rsvp)await mutate('meetings/'+button.dataset.id+'/rsvp','POST',{answer:button.dataset.rsvp},()=>notice('Attendance updated.'));
    if(button.dataset.cancelMeeting&&await confirmAction('Cancel this team session?'))await mutate('meetings/'+button.dataset.cancelMeeting,'DELETE',undefined,()=>notice('Session cancelled.'));
    if(button.dataset.copyMeeting){const m=state.meetings.find(m=>m.id===button.dataset.copyMeeting);if(m){try{await navigator.clipboard.writeText(`NextStep team session: ${m.title}\n${new Date(m.startsAt).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n${m.topic}\nhttps://nextstep-team-production.up.railway.app/`);notice('Invitation copied. Paste it into your private group chat.');}catch{notice('Clipboard is unavailable. Copy the session title and time manually.',true);}}}
    if(button.dataset.removeResource&&await confirmAction('Remove this shared link?'))await mutate('resources/'+button.dataset.removeResource,'DELETE',undefined,()=>notice('Resource removed.'));
  });
  $('undo-delete').onclick=async()=>{if(deleted)await mutate('tasks/'+deleted.id+'/restore','POST',{version:deleted.version},()=>{deleted=null;$('undo-panel').hidden=true;notice('Task restored to To do.');});};
  for(const id of ['task-search','priority-filter','member-filter','due-filter'])$(id).addEventListener(id==='task-search'?'input':'change',renderTasks);
  $('view-board').onclick=()=>{listView=false;$('view-board').setAttribute('aria-pressed','true');$('view-list').setAttribute('aria-pressed','false');renderTasks();};
  $('view-list').onclick=()=>{listView=true;$('view-board').setAttribute('aria-pressed','false');$('view-list').setAttribute('aria-pressed','true');renderTasks();};
  function resetMilestone(){milestoneEditing=null;$('milestone-form').reset();$('milestone-id').value='';$('milestone-form-title').textContent='Create a milestone';$('cancel-milestone').hidden=true;}
  $('cancel-milestone').onclick=resetMilestone;
  $('milestone-form').onsubmit=async event=>{event.preventDefault();const body={title:$('milestone-title').value,deadline:$('milestone-deadline').value,description:$('milestone-description').value};if(milestoneEditing)body.version=milestoneEditing.version;await mutate('milestones'+(milestoneEditing?'/'+milestoneEditing.id:''),milestoneEditing?'PUT':'POST',body,()=>{resetMilestone();notice('Milestone saved.');});};
  $('meeting-form').onsubmit=async event=>{event.preventDefault();const starts=new Date($('meeting-start').value);if(!Number.isFinite(starts.getTime()))return;await mutate('meetings','POST',{title:$('meeting-title').value,startsAt:starts.toISOString(),topic:$('meeting-topic').value},()=>{$('meeting-form').reset();notice('Team session scheduled. Registered members will see an inbox notification.');});};
  $('resource-form').onsubmit=async event=>{event.preventDefault();await mutate('resources','POST',{title:$('resource-title').value,url:$('resource-url').value},()=>{$('resource-form').reset();notice('Resource shared.');});};
  $('calendar-prev').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);renderCalendar();};$('calendar-next').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);renderCalendar();};$('calendar-today').onclick=()=>{month=new Date(new Date().getFullYear(),new Date().getMonth(),1);renderCalendar();};
  $('show-notifications').onclick=()=>{$('notifications-panel').hidden=!$('notifications-panel').hidden;};$('mark-read').onclick=()=>mutate('notifications/read','POST',undefined,()=>notice('Inbox marked read.'));
  $('password-form').onsubmit=async event=>{event.preventDefault();await mutate('account/password','POST',{currentPassword:$('current-password').value,password:$('new-password').value},()=>{$('password-form').reset();connectLive();notice('Password updated. Other sessions have ended.');});};
  $('recovery-form').onsubmit=async event=>{event.preventDefault();await mutate('account/recovery','POST',{currentPassword:$('recovery-password').value},data=>{$('recovery-form').reset();$('recovery-output').textContent='Save privately: '+data.recoveryCode;notice('Recovery code generated. Store it safely; it is shown only here.');});};
  $('rotate-invite').onclick=async()=>{if(await confirmAction('Replace the current team invite code? Anyone still registering will need the new code.'))await mutate('invitations','POST',undefined,data=>{$('invite-output').textContent=data.inviteCode;notice('Invite replaced. Share the new code privately with unregistered members.');});};
  $('export-data').onclick=async()=>{try{const data=await api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='nextstep-workspace-'+today()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('Workspace data downloaded.');}catch(error){notice(error.message,true);}};
  $('refresh-board').onclick=sync;$('logout').onclick=async()=>{try{await api('auth/logout','POST');showAuth();}catch(error){notice(error.message,true);}};
  $('today-label').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}).toUpperCase();
  $('meeting-timezone').textContent='Your time zone: '+Intl.DateTimeFormat().resolvedOptions().timeZone;
  setInterval(()=>{if(user&&!document.hidden)sync();},30000);
  document.addEventListener('visibilitychange',()=>{if(user&&!document.hidden)sync();});
  window.NextStep={logFocus:minutes=>mutate('focus','POST',{minutes},()=>notice('Focus session saved for the team.')),notice};
  (async()=>{try{const data=await api('me');if(data.user)await enter(data.user);else showAuth();}catch{showAuth('Could not reach the server. Please try refreshing.');}})();
})();
