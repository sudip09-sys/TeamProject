(() => {
  'use strict';
  const form = document.getElementById('task-form');
  const titleInput = document.getElementById('task-title');
  const subjectInput = document.getElementById('task-subject');
  const deadlineInput = document.getElementById('task-deadline');
  const assigneeInput = document.getElementById('task-assignee');
  const list = document.getElementById('task-list');
  const subjectFilter = document.getElementById('subject-filter');
  const search = document.getElementById('task-search');
  const feedback = document.getElementById('form-feedback');
  const memberNames = { eric: 'Eric', abinash: 'Abinash', sondor: 'Sondor', sudip: 'Sudip' };
  let user = null;
  let tasks = [];
  let members = [];
  let activity = [];
  let currentView = 'all';
  let currentSubject = '';
  let editingId = null;
  let editingVersion = null;
  let deletedTask = null;
  let busy = false;
  let syncing = false;
  let registerMode = false;
  let mutationEpoch = 0;
  const memberName = username => memberNames[username] || username;

  async function api(route, method = 'GET', body) {
    const response = await fetch('/api/' + route, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && user) showAuth('Your session ended. Sign in again.');
      const error = new Error(data.error || 'The request failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showAuth(message = '') {
    user = null;
    tasks = [];
    members = [];
    activity = [];
    editingId = null;
    deletedTask = null;
    list.replaceChildren();
    document.getElementById('activity-list').replaceChildren();
    document.getElementById('app-shell').hidden = true;
    document.getElementById('auth-screen').hidden = false;
    document.getElementById('auth-message').textContent = message;
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-invite').value = '';
  }

  function showNotice(message, canUndo = false) {
    document.getElementById('action-message').textContent = message;
    document.getElementById('undo-delete').hidden = !canUndo;
    document.getElementById('action-notice').hidden = false;
  }

  function renderTeam() {
    const container = document.getElementById('team-members');
    container.replaceChildren();
    for (const member of members) {
      const item = document.createElement('div');
      item.className = 'member-card';
      const avatar = document.createElement('span');
      avatar.className = 'member-avatar';
      avatar.textContent = member.name[0];
      const detail = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = member.name + (member.username === user?.username ? ' · You' : '');
      const count = document.createElement('small');
      count.textContent = tasks.filter(task => !task.completed && task.assignee === member.username).length + ' open tasks · ' + (member.registered ? 'Account ready' : 'Not registered');
      detail.append(name, count);
      item.append(avatar, detail);
      container.append(item);
    }
    const log = document.getElementById('activity-list');
    log.replaceChildren();
    for (const entry of activity) {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = memberName(entry.username) + ' ' + entry.action + ' “' + entry.title + '”';
      const time = document.createElement('time');
      const date = new Date(entry.createdAt);
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      item.append(text, time);
      log.append(item);
    }
    document.getElementById('activity-empty').hidden = activity.length > 0;
  }

  function applySnapshot(data) {
    tasks = data.tasks;
    members = data.members;
    activity = data.activity;
    render();
    renderTeam();
    document.getElementById('sync-state').textContent = 'Shared board · synced';
  }

  async function sync() {
    if (!user || syncing || busy) return;
    syncing = true;
    const epoch = mutationEpoch;
    try {
      const data = await api('workspace');
      if (user && !busy && epoch === mutationEpoch) applySnapshot(data);
    }
    catch (error) { document.getElementById('sync-state').textContent = 'Not synced · use Refresh'; }
    finally { syncing = false; }
  }

  async function mutate(route, method, data, success) {
    if (busy) return;
    busy = true;
    mutationEpoch++;
    form.querySelector('button[type=submit]').disabled = true;
    try {
      const result = await api(route, method, data);
      applySnapshot(result);
      success(result);
    } catch (error) {
      if (user) render();
      showNotice(error.message || 'Connection lost. Please try again.');
      if (error.status === 409) {
        try { applySnapshot(await api('workspace')); } catch { /* Keep the existing board. */ }
      }
    } finally { busy = false; form.querySelector('button[type=submit]').disabled = false; }
  }
  function dateKey(date = new Date()) {
    // Local calendar dates avoid midnight shifts caused by UTC date parsing.
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function validDate(value) {
    if (value === '') return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1000 || year > 9999) return false;
    const date = new Date(year, month - 1, day, 12);
    return dateKey(date) === value;
  }

  function resetComposer() {
    editingId = null;
    editingVersion = null;
    form.reset();
    feedback.textContent = '';
    document.getElementById('composer-title').textContent = 'What’s next?';
    document.getElementById('composer-label').textContent = 'MAKE A LITTLE PROGRESS';
    const submit = document.getElementById('submit-task');
    submit.replaceChildren(document.createTextNode('Add to my list '));
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '＋';
    submit.append(icon);
    document.getElementById('cancel-edit').hidden = true;
  }

  function startEditing(task) {
    editingId = task.id;
    editingVersion = task.version;
    assigneeInput.value = task.assignee;
    titleInput.value = task.title;
    subjectInput.value = task.subject;
    deadlineInput.value = task.deadline;
    feedback.textContent = '';
    document.getElementById('composer-title').textContent = 'A little adjustment.';
    document.getElementById('composer-label').textContent = 'EDIT TASK';
    document.getElementById('submit-task').textContent = 'Save changes ↗';
    document.getElementById('cancel-edit').hidden = false;
    titleInput.focus();
  }

  function readableDeadline(task, today) {
    if (!task.deadline) return { text: 'No deadline', className: '' };
    const [year, month, day] = task.deadline.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
    if (task.completed) return { text: label, className: '' };
    if (task.deadline < today) return { text: 'Overdue · ' + label, className: 'overdue' };
    if (task.deadline === today) return { text: 'Today', className: 'today' };
    return { text: label, className: '' };
  }

  function taskRow(task, today) {
    const item = document.createElement('li');
    item.className = 'task-item' + (task.completed ? ' task-complete' : '');
    item.dataset.id = task.id;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.checked = task.completed;
    checkbox.setAttribute('aria-label', (task.completed ? 'Mark incomplete: ' : 'Complete: ') + task.title);

    const info = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title; // Never parse user-entered text as markup.
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const subject = document.createElement('span');
    subject.className = 'subject-tag';
    subject.textContent = task.subject || 'General';
    const tools = document.createElement('div');
    tools.className = 'task-tools';
    for (const [action, symbol] of [['edit', 'Edit'], ['delete', '×']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.textContent = symbol;
      button.setAttribute('aria-label', (action === 'edit' ? 'Edit: ' : 'Delete: ') + task.title);
      tools.append(button);
    }
    const assigned = document.createElement('span');
    assigned.className = 'assignment-tag';
    assigned.textContent = task.assignee ? '↳ ' + memberName(task.assignee) : 'Unassigned';
    meta.append(subject, assigned, tools);
    info.append(title, meta);
    const due = readableDeadline(task, today);
    const deadline = document.createElement(task.deadline ? 'time' : 'span');
    deadline.className = 'deadline ' + due.className;
    if (task.deadline) deadline.dateTime = task.deadline;
    deadline.textContent = due.text;
    item.append(checkbox, info, deadline);
    return item;
  }

  function refreshSubjects() {
    const names = [...new Set(tasks.map(task => task.subject || 'General'))].sort((a, b) => a.localeCompare(b));
    if (currentSubject !== '' && !names.includes(currentSubject)) currentSubject = '';
    subjectFilter.replaceChildren(new Option('All subjects', ''));
    for (const name of names) subjectFilter.add(new Option(name, name));
    subjectFilter.value = currentSubject;
    const suggestions = document.getElementById('subject-options');
    suggestions.replaceChildren();
    for (const name of new Set(['Web Programming', 'Database', 'Algorithms', 'Korean', ...names])) {
      suggestions.append(new Option(name, name));
    }
  }

  function render() {
    const today = dateKey();
    const open = tasks.filter(task => !task.completed);
    const counts = {
      all: tasks.length,
      mine: open.filter(task => task.assignee === user?.username).length,
      today: open.filter(task => task.deadline === today).length,
      upcoming: open.filter(task => task.deadline && task.deadline > today).length,
      completed: tasks.length - open.length
    };
    document.getElementById('open-total').textContent = open.length;
    document.getElementById('today-total').textContent = counts.today;
    document.getElementById('completed-total').textContent = counts.completed;
    for (const [view, count] of Object.entries(counts)) document.getElementById('count-' + view).textContent = count;
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === currentView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    refreshSubjects();
    const query = search.value.trim().toLocaleLowerCase();
    const visible = tasks.filter(task => {
      const inView = currentView === 'all' ||
        (currentView === 'mine' && !task.completed && task.assignee === user?.username) ||
        (currentView === 'today' && !task.completed && task.deadline === today) ||
        (currentView === 'upcoming' && !task.completed && task.deadline && task.deadline > today) ||
        (currentView === 'completed' && task.completed);
      return inView && (currentSubject === '' || (task.subject || 'General') === currentSubject) &&
        (task.title + ' ' + (task.subject || 'General')).toLocaleLowerCase().includes(query);
    }).sort((a, b) => Number(a.completed) - Number(b.completed) ||
      (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') || b.createdAt - a.createdAt);

    list.replaceChildren(...visible.map(task => taskRow(task, today)));
    const viewNames = { mine: 'Assigned to me', all: 'All tasks', today: 'Due today', upcoming: 'Upcoming', completed: 'Completed' };
    document.getElementById('tasks-heading').textContent = viewNames[currentView];
    document.getElementById('visible-count').textContent = visible.length + (visible.length === 1 ? ' task' : ' tasks');
    document.getElementById('empty-state').hidden = visible.length > 0;
    const isEmpty = tasks.length === 0;
    const filtered = Boolean(query) || currentSubject !== '';
    document.getElementById('empty-title').textContent = isEmpty ? 'A fresh page for your plans.' : filtered ? 'No tasks match just yet.' : currentView === 'completed' ? 'Your first small win is ahead.' : currentView === 'today' ? 'A little breathing room today.' : 'Nothing on the horizon yet.';
    document.getElementById('empty-description').textContent = isEmpty ? 'Add your first task. A little clarity goes a long way.' : filtered ? 'Try a different search or show all subjects.' : currentView === 'completed' ? 'Finish a task and it will appear here.' : 'Add a task, or switch to All tasks to see the rest of your plan.';
    document.getElementById('empty-action').textContent = filtered ? 'Clear filters ↗' : isEmpty ? 'Add my first task ↗' : 'Show all tasks ↗';
    
    const summary = document.getElementById('list-summary');
    summary.textContent = isEmpty ? 'Your task list is ready when you are.' : open.length === 0 ? 'Everything is checked off. Enjoy the breathing room.' : open.length + (open.length === 1 ? ' task left. One step at a time.' : ' tasks left. One step at a time.');
    const dateLabel = document.getElementById('today-label');
    dateLabel.dateTime = today;
    dateLabel.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  }


  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const title = titleInput.value.trim();
    if (!title) { feedback.textContent = 'Give your task a short, specific name.'; titleInput.focus(); return; }
    const existing = tasks.find(task => task.id === editingId);
    if (editingId && !existing) { showNotice('This task was deleted. Cancel editing to add a new task.'); return; }
    const data = { title, subject: subjectInput.value.trim(), deadline: deadlineInput.value, assignee: assigneeInput.value, completed: existing?.completed || false };
    if (!validDate(data.deadline)) { feedback.textContent = 'Check the deadline.'; return; }
    const editing = Boolean(editingId);
    const route = editing ? 'tasks/' + editingId : 'tasks';
    if (editing) data.version = editingVersion;
    await mutate(route, editing ? 'PUT' : 'POST', data, () => {
      resetComposer(); currentView = 'all'; currentSubject = ''; search.value = ''; render();
      showNotice(editing ? 'Task updated for the team.' : 'Task added to your shared board.');
      titleInput.focus();
    });
  });

  list.addEventListener('change', async event => {
    if (!event.target.matches('.task-checkbox')) return;
    const task = tasks.find(task => task.id === event.target.closest('[data-id]').dataset.id);
    if (!task) return;
    if (busy) { render(); return; }
    const completed = event.target.checked;
    await mutate('tasks/' + task.id, 'PUT', { ...task, completed }, () => {
      showNotice(completed ? 'Small win: task completed.' : 'Task reopened.');
      const row = [...list.children].find(row => row.dataset.id === task.id);
      (row?.querySelector('.task-checkbox') || document.querySelector('[data-view="' + currentView + '"]')).focus();
    });
  });

  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) return;
    const task = tasks.find(task => task.id === button.closest('[data-id]').dataset.id);
    if (!task) return;
    if (button.dataset.action === 'edit') { startEditing(task); return; }
    await mutate('tasks/' + task.id, 'DELETE', { version: task.version }, result => {
      deletedTask = result.deletedTask;
      if (editingId === task.id) resetComposer();
      showNotice('Deleted: ' + task.title, true);
      document.getElementById('undo-delete').focus();
    });
  });
  document.getElementById('undo-delete').addEventListener('click', async () => {
    if (!deletedTask || busy) return;
    await mutate('tasks/' + deletedTask.id + '/restore', 'POST', { version: deletedTask.version }, () => {
      deletedTask = null; showNotice('Task restored for the team.');
      document.getElementById('dismiss-notice').focus();
    });
  });
  document.getElementById('dismiss-notice').addEventListener('click', () => {
    document.getElementById('action-notice').hidden = true; deletedTask = null; titleInput.focus();
  });
  document.getElementById('cancel-edit').addEventListener('click', () => { resetComposer(); titleInput.focus(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { currentView = button.dataset.view; render(); }));
  subjectFilter.addEventListener('change', () => { currentSubject = subjectFilter.value; render(); });
  search.addEventListener('input', render);
  document.getElementById('empty-action').addEventListener('click', () => {
    if (!tasks.length) { titleInput.focus(); return; }
    currentView = 'all'; currentSubject = ''; search.value = ''; render();
  });
  document.getElementById('refresh-board').addEventListener('click', sync);
  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('auth/logout', 'POST'); resetComposer(); showAuth(); }
    catch (error) { showNotice(error.message); }
  });

  function setAuthMode(register) {
    registerMode = register;
    document.getElementById('invite-field').hidden = !register;
    document.getElementById('auth-invite').required = register;
    document.getElementById('auth-password').autocomplete = register ? 'new-password' : 'current-password';
    document.getElementById('auth-submit').textContent = register ? 'Create my account ↗' : 'Sign in to the team ↗';
    document.getElementById('mode-login').setAttribute('aria-pressed', String(!register));
    document.getElementById('mode-register').setAttribute('aria-pressed', String(register));
    document.getElementById('auth-message').textContent = '';
  }
  document.getElementById('mode-login').onclick = () => setAuthMode(false);
  document.getElementById('mode-register').onclick = () => setAuthMode(true);
  async function enterWorkspace(account) {
    user = account;
    const data = await api('workspace');
    resetComposer(); currentView = 'all'; currentSubject = ''; search.value = '';
    document.getElementById('action-notice').hidden = true;
    document.getElementById('current-member').textContent = user.name;
    applySnapshot(data);
    document.getElementById('auth-screen').hidden = true;
    document.getElementById('app-shell').hidden = false;
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-invite').value = '';
  }
  document.getElementById('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('auth-submit');
    button.disabled = true;
    document.getElementById('auth-message').textContent = '';
    try {
      const data = await api(registerMode ? 'auth/register' : 'auth/login', 'POST', {
        username: document.getElementById('auth-member').value,
        password: document.getElementById('auth-password').value,
        ...(registerMode ? { inviteCode: document.getElementById('auth-invite').value } : {})
      });
      await enterWorkspace(data.user);
    } catch (error) { document.getElementById('auth-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  setInterval(() => {
    if (user && !document.hidden && !editingId && !list.contains(document.activeElement) && document.activeElement !== subjectFilter) sync();
  }, 12000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && user && !editingId) sync(); });
  (async () => {
    try { const data = await api('me'); if (data.user) await enterWorkspace(data.user); else showAuth(); }
    catch { showAuth('Could not connect to the server. Start the project with npm start and refresh.'); }
  })();
})();
