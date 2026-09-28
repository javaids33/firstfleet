'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('ff:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ff:' + k, JSON.stringify(v)); } catch {} },
};

const S = {
  board: null,
  events: [],
  view: store.get('view', 'harbor'),
  space: store.get('space', null),
  harness: store.get('harness', null),
  group: store.get('group', 'none'),
  q: '',
  expanded: new Set(),
  lastSeq: 0,
  lanesById: {},
};

const HASH = new URLSearchParams(location.hash.slice(1));
if (HASH.get('view')) S.view = HASH.get('view');
if (HASH.has('space')) S.space = HASH.get('space') || null;
if (HASH.get('group')) S.group = HASH.get('group');
if (HASH.has('crew')) S.harness = HASH.get('crew') || null;
S.openTask = HASH.get('task') || null;
if (HASH.get('theme')) document.documentElement.dataset.theme = HASH.get('theme');

function syncHash() {
  const h = new URLSearchParams();
  if (HASH.get('snap')) h.set('snap', '1');
  h.set('view', S.view);
  if (S.space) h.set('space', S.space);
  if (S.group !== 'none') h.set('group', S.group);
  if (S.harness) h.set('crew', S.harness);
  if (S.openTask) h.set('task', S.openTask);
  if (document.documentElement.dataset.theme) h.set('theme', document.documentElement.dataset.theme);
  history.replaceState(null, '', '#' + h.toString());
}

const LANE_TONE = { backlog: 'plain', selected: 'teal', dev: 'blue', blocked: 'red', review: 'purple', done: 'green' };
const VERB_TONE = { working: 'blue', done: 'green', blocked: 'red', paused: 'yellow', resolved: 'purple', message: 'plain' };

// ---------- helpers ----------
function crewOf(h) {
  const s = String(h || '').toLowerCase();
  if (!s) return 'unassigned';
  if (s.includes('claude') || s === 'sonnet' || s === 'haiku' || s === 'opus') return 'claude';
  if (s.includes('codex') || s.includes('gpt')) return 'codex';
  if (s.includes('agy') || s.includes('gemini') || s === 'pro' || s === 'flash' || s.includes('antigravity')) return 'agy';
  if (s === 'firstmate' || s === 'lead') return s;
  return 'other';
}
const CREW_LABEL = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', firstmate: 'First mate', lead: 'Lead', other: 'Other', unassigned: 'Unassigned' };
const CREW_INIT = { claude: 'CL', codex: 'CX', agy: 'AG', firstmate: 'FM', lead: 'LD', other: '??', unassigned: '–' };

function avatar(crew, status, title) {
  const pip = status ? `<i class="pip ${esc(status)}"></i>` : '';
  return `<span class="av ${crew}" title="${esc(title || CREW_LABEL[crew] || crew)}">${CREW_INIT[crew] || '?'}${pip}</span>`;
}

function ago(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

function spaceColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function typeIcon(t) {
  if (t.kind === 'scout') return `<span class="type-ico" style="background:#e2b203" title="Scout (investigation)"><svg width="10" height="10" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 10l4 4" stroke="#fff" stroke-width="2"/></svg></span>`;
  if (t.unassigned) return `<span class="type-ico" style="background:#8590a2" title="Card on lead's board"><svg width="10" height="10" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1" fill="#fff"/></svg></span>`;
  return `<span class="type-ico" style="background:#1d7afc" title="Ship task"><svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="#fff" stroke-width="2.4"/></svg></span>`;
}

function prBadge(pr) {
  if (!pr) return '';
  const st = pr.state || 'OPEN';
  const tone = st === 'MERGED' ? 'purple' : st === 'CLOSED' ? 'red' : 'green';
  let checks = '';
  if (pr.checks && pr.checks.total) checks = pr.checks.failing ? ' ✕' : pr.checks.pending ? ' …' : ' ✓';
  return `<span class="lz ${tone}" title="${esc(pr.url)}">PR #${esc(pr.number)}${checks}</span>`;
}

function matches(t) {
  if (S.space && t.repo !== S.space) return false;
  if (S.harness && crewOf(t.actor && t.actor.harness) !== S.harness) return false;
  if (S.q) {
    const hay = `${t.key} ${t.title} ${t.id} ${t.epic} ${t.why || ''} ${t.actor && t.actor.harness} ${t.actor && t.actor.model}`.toLowerCase();
    if (!hay.includes(S.q)) return false;
  }
  return true;
}

function laneSort(lane) {
  return (a, b) => {
    if (lane === 'backlog') {
      const rank = (t) => (!t.unassigned ? 0 : t.card && t.card.status === 'ready' ? 1 : 2);
      return rank(a) - rank(b) || String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
    }
    return (b.lastAt || b.firstAt || 0) - (a.lastAt || a.firstAt || 0) || String(a.key).localeCompare(String(b.key));
  };
}

// ---------- card ----------
function cardHtml(t) {
  const crew = crewOf(t.actor && t.actor.harness);
  const agentStatus = t.agent ? t.agent.status : t.busy ? (t.busy.state === 'busy' ? 'working' : t.busy.state) : null;
  const who = [CREW_LABEL[crew], t.actor && t.actor.model].filter(Boolean).join(' · ');
  const showWhy = t.lane !== 'backlog' && t.why;
  const cls = ['card', `lane-${t.lane}`];
  if (agentStatus === 'working' && t.lane !== 'done') cls.push('agent-working');
  return `<div class="${cls.join(' ')}" data-id="${esc(t.id)}" tabindex="0">
    <p class="ttl">${esc(t.title)}</p>
    ${showWhy ? `<p class="why">${esc(t.why)}</p>` : ''}
    <div class="row">
      <span class="lz" style="background:${spaceColor(t.epic)}22;color:${spaceColor(t.epic)}">${esc(t.epic)}</span>
      ${prBadge(t.pr)}
      ${t.inboxPending ? `<span class="lz yellow" title="Unread first-mate messages">✉ ${t.inboxPending}</span>` : ''}
      ${t.unassigned && t.card && t.card.status && t.card.status !== 'ready' ? `<span class="lz">${esc(t.card.status)}</span>` : ''}
    </div>
    <div class="row" style="margin-top:8px">
      <span class="key">${typeIcon(t)}${esc(t.key)}</span>
      <span class="spacer muted" style="font-size:11px">${esc(ago(t.lastAt))}</span>
      ${avatar(crew, t.lane === 'done' ? null : agentStatus, who)}
    </div>
  </div>`;
}

// ---------- views ----------
function visibleTasks() { return (S.board ? S.board.tasks : []).filter(matches); }

function renderBoard(tasks) {
  const lanes = S.board.lanes;
  const LIMIT = S.group === 'epic' ? 6 : 25;
  const column = (lane, list, scope) => {
    const key = `${scope}:${lane.id}`;
    const sorted = list.filter((t) => t.lane === lane.id).sort(laneSort(lane.id));
    const shown = S.expanded.has(key) ? sorted : sorted.slice(0, LIMIT);
    const rest = sorted.length - shown.length;
    return `<div class="col" data-lane="${lane.id}">
      ${scope === 'all' || S.group === 'none' ? `<div class="col-h">${esc(lane.name)} <span class="n">${sorted.length}</span></div>` : ''}
      <div class="cards">${shown.length ? shown.map(cardHtml).join('') : `<div class="col-empty">${lane.id === 'blocked' ? 'No blockers' : 'Empty'}</div>`}</div>
      ${rest > 0 ? `<button class="more" data-expand="${esc(key)}">+ ${rest} more</button>` : ''}
    </div>`;
  };
  if (S.group !== 'epic') {
    return `<div class="board">${lanes.map((l) => column(l, tasks, 'all')).join('')}</div>`;
  }
  const byEpic = new Map();
  for (const t of tasks) {
    const k = `${t.repo}::${t.epic}`;
    if (!byEpic.has(k)) byEpic.set(k, []);
    byEpic.get(k).push(t);
  }
  const order = [...byEpic.entries()].sort((a, b) => {
    const live = (l) => l.filter((t) => t.lane !== 'backlog' && t.lane !== 'done').length;
    return live(b[1]) - live(a[1]) || a[0].localeCompare(b[0], undefined, { numeric: true });
  });
  const head = `<div class="board">${lanes.map((l) => `<div class="col-h" style="background:none">${esc(l.name)} <span class="n">${tasks.filter((t) => t.lane === l.id).length}</span></div>`).join('')}</div>`;
  return head + order.map(([k, list]) => {
    const [repo, epic] = k.split('::');
    return `<div class="swim"><div class="swim-h">${epicBar(list)}<span>${esc(epic)}</span><span class="muted" style="font-weight:400">${esc(repo)} · ${list.length} issues</span></div>
      <div class="board">${lanes.map((l) => column(l, list, k)).join('')}</div></div>`;
  }).join('');
}

function epicBar(list) {
  const n = list.length || 1;
  const c = (lane) => list.filter((t) => (Array.isArray(lane) ? lane.includes(t.lane) : t.lane === lane)).length;
  return `<div class="progress bar" title="${c('done')} done / ${list.length}">
    <i class="p-done" style="width:${(c('done') / n) * 100}%"></i><i class="p-review" style="width:${(c('review') / n) * 100}%"></i>
    <i class="p-active" style="width:${(c(['dev', 'selected']) / n) * 100}%"></i><i class="p-blocked" style="width:${(c('blocked') / n) * 100}%"></i></div>`;
}

function renderBacklog(tasks) {
  const groups = new Map();
  for (const t of tasks.filter((x) => x.lane !== 'done')) {
    const k = `${t.repo}::${t.epic}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  if (!groups.size) return `<div class="empty">Nothing open. The fleet is idle.</div>`;
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, list]) => {
    const [repo, epic] = k.split('::');
    list.sort((a, b) => S.board.lanes.findIndex((l) => l.id === b.lane) - S.board.lanes.findIndex((l) => l.id === a.lane) || laneSort(a.lane)(a, b));
    return `<div class="group-h"><span class="lz" style="background:${spaceColor(epic)}22;color:${spaceColor(epic)}">${esc(epic)}</span><span class="muted">${esc(repo)} · ${list.length}</span></div>
    <table class="table"><thead><tr><th style="width:170px">Key</th><th>Summary</th><th style="width:150px">Status</th><th style="width:170px">Assignee</th><th style="width:110px">Updated</th></tr></thead><tbody>
    ${list.map((t) => {
      const crew = crewOf(t.actor && t.actor.harness);
      return `<tr class="clickable" data-id="${esc(t.id)}"><td><span class="key" style="display:inline-flex;gap:6px;align-items:center">${typeIcon(t)}<b class="mono">${esc(t.key)}</b></span></td>
      <td>${esc(t.title)}</td><td><span class="lz ${LANE_TONE[t.lane]}">${esc(S.lanesById[t.lane])}</span></td>
      <td><span style="display:inline-flex;gap:8px;align-items:center">${avatar(crew, t.agent && t.agent.status)}${esc(t.actor && (t.actor.model || t.actor.harness) || 'Unassigned')}</span></td>
      <td class="muted">${esc(ago(t.lastAt) || t.since || '')}</td></tr>`;
    }).join('')}</tbody></table>`;
  }).join('');
}

function renderEpics(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const k = `${t.repo}::${t.epic}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const list = [...map.entries()].sort((a, b) => {
    const w = (l) => l.filter((t) => !['backlog', 'done'].includes(t.lane)).length;
    return w(b[1]) - w(a[1]) || a[0].localeCompare(b[0], undefined, { numeric: true });
  });
  return `<div class="epics">${list.map(([k, l]) => {
    const [repo, epic] = k.split('::');
    const c = (x) => l.filter((t) => t.lane === x).length;
    const crews = [...new Set(l.filter((t) => !t.unassigned).map((t) => crewOf(t.actor && t.actor.harness)))];
    const pct = Math.round((c('done') / (l.length || 1)) * 100);
    const state = c('dev') + c('selected') + c('review') + c('blocked') ? '<span class="lz blue">In motion</span>' : c('done') === l.length ? '<span class="lz green">Complete</span>' : '<span class="lz">To do</span>';
    return `<div class="epic" data-epic="${esc(k)}">
      <div><h3><span class="type-ico" style="background:#8270db"><svg width="10" height="10" viewBox="0 0 16 16"><path d="M9 1L3 9h4l-1 6 6-8H8z" fill="#fff"/></svg></span>${esc(epic)} ${state}</h3>
      <div class="meta">${esc(repo)} · ${l.length} issues · ${crews.map((cr) => avatar(cr)).join(' ')}</div></div>
      ${epicBar(l)}
      <div class="nums">${pct}% · ${c('done')} done · ${c('review')} review · ${c('dev') + c('selected')} dev · ${c('blocked')} blocked · ${c('backlog')} backlog</div>
    </div>`;
  }).join('')}</div>`;
}

function renderFleet() {
  const tasksByPane = new Map((S.board.tasks || []).filter((t) => t.meta && t.meta.pane).map((t) => [t.meta.pane, t]));
  const agents = (S.board.agents || []).slice().sort((a, b) => (a.status === 'working' ? -1 : 0) - (b.status === 'working' ? -1 : 0));
  if (!agents.length) return `<div class="empty">No herdr agents visible. Start herdr or run with a herdr session to see live panes.</div>`;
  return `<div class="fleet">${agents.map((a) => {
    const t = tasksByPane.get(a.pane);
    const role = a.name === 'firstmate' ? 'firstmate' : t ? crewOf(t.actor.harness) : /claude_projects$/.test(a.cwd || '') ? 'lead' : crewOf(a.agent);
    const label = a.name === 'firstmate' ? 'First mate' : t ? t.key : role === 'lead' ? 'Lead' : a.workspace;
    const tone = a.status === 'working' ? 'green' : a.status === 'idle' ? 'yellow' : a.status === 'done' ? 'blue' : '';
    return `<div class="agent ${esc(a.status)}" ${t ? `data-id="${esc(t.id)}" style="cursor:pointer"` : ''}>
      <div class="hd">${avatar(role, a.status)}<b>${esc(label)}</b><span class="lz ${tone}" style="margin-left:auto">${esc(a.status)}</span></div>
      <div class="t">${esc(a.title || (t && t.title) || '')}</div>
      ${t ? `<div class="row" style="display:flex;gap:6px;flex-wrap:wrap"><span class="lz ${LANE_TONE[t.lane]}">${esc(S.lanesById[t.lane])}</span>${prBadge(t.pr)}</div>` : ''}
      <div class="p mono">${esc(a.agent)} · ${esc(a.pane)} · ${esc(a.cwd || '')}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderLog() {
  const evs = S.events.filter((e) => !S.space || e.repo === S.space).slice().reverse();
  const byDay = new Map();
  for (const e of evs) {
    const d = new Date((e.at || 0) * 1000).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  if (!evs.length) return `<div class="empty">No fleet events yet.</div>`;
  const moved = evs.filter((e) => e.type === 'moved' || (e.type === 'status' && e.verb === 'done')).length;
  const blocked = evs.filter((e) => e.verb === 'blocked').length;
  return `<div class="page" style="padding:0;max-width:860px">
    <div class="panel info">ℹ️ <div><b>What happened while you were away.</b> ${evs.length} events, ${moved} deliveries, ${blocked} blockers across ${new Set(evs.map((e) => e.key)).size} cards. Written from firstmate's status logs, inbox, and live herdr panes.</div></div>
    ${[...byDay.entries()].map(([d, list]) => `<h2>${esc(d)}</h2><ul class="timeline">${list.map((e) => `<li class="${esc(e.verb || e.type)}" data-id="${esc(e.task)}" style="cursor:pointer">
      <div><b>${esc(e.key)}</b> <span class="lz ${VERB_TONE[e.verb] || (e.type === 'moved' ? 'blue' : 'plain')}">${esc(e.verb || e.type)}</span> ${esc(e.text)}</div>
      <div class="tm">${esc(new Date((e.at || 0) * 1000).toLocaleTimeString())} · ${esc(CREW_LABEL[crewOf(e.actor)] || e.actor)}</div></li>`).join('')}</ul>`).join('')}
  </div>`;
}

// ---------- chrome ----------
function renderSidebar() {
  const all = S.board.tasks;
  const repos = S.board.repos;
  const count = (fn) => all.filter(fn).filter((t) => t.lane !== 'done' && t.lane !== 'backlog').length;
  $('#spaces').innerHTML = [
    `<li><button data-space="" class="${!S.space ? 'active' : ''}"><span class="space-ico" style="background:var(--text-sub)">∗</span>All spaces<span class="count">${count(() => true)}</span></button></li>`,
    ...repos.map((r) => `<li><button data-space="${esc(r)}" class="${S.space === r ? 'active' : ''}"><span class="space-ico" style="background:${spaceColor(r)}">${esc(r.slice(0, 2).toUpperCase())}</span>${esc(r)}<span class="count">${count((t) => t.repo === r)}</span></button></li>`),
  ].join('');
  const crews = ['claude', 'codex', 'agy'];
  const live = (c) => all.filter((t) => crewOf(t.actor && t.actor.harness) === c && t.agent && t.agent.status === 'working').length;
  $('#harnesses').innerHTML = [
    `<li><button data-harness="" class="${!S.harness ? 'active' : ''}">${avatar('firstmate')}Everyone</button></li>`,
    ...crews.map((c) => `<li><button data-harness="${c}" class="${S.harness === c ? 'active' : ''}">${avatar(c, live(c) ? 'working' : null)}${CREW_LABEL[c]}<span class="count">${live(c) ? live(c) + ' live' : ''}</span></button></li>`),
  ].join('');
  $('#home').textContent = S.board.home;
}

function renderStats(tasks) {
  const c = (l) => tasks.filter((t) => t.lane === l).length;
  const working = (S.board.agents || []).filter((a) => a.status === 'working').length;
  $('#stats').innerHTML = [
    ['Agents working', working],
    ['In development', c('dev') + c('selected')],
    ['In review / QA', c('review')],
    ['Blocked', c('blocked')],
    ['Done', c('done')],
    ['Backlog', c('backlog')],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
}

function render() {
  if (!S.board) return;
  S.lanesById = Object.fromEntries(S.board.lanes.map((l) => [l.id, l.name]));
  const harbor = S.view === 'harbor';
  const wasHarbor = document.body.classList.contains('mode-harbor');
  document.body.classList.toggle('mode-harbor', harbor);
  $('#actTitle').textContent = harbor ? "📜 Captain's log" : 'Activity';
  if (harbor !== wasHarbor) renderActivity();
  if (harbor) {
    document.querySelectorAll('.apps button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
    syncHash();
    if (!$('#view .harbor')) $('#view').innerHTML = '';
    Harbor.update($('#view'));
    const h = $('#view .harbor');
    if (h) h.classList.toggle('calm', !visibleTasks().some((t) => t.lane === 'blocked'));
    return;
  }
  const titles = { harbor: 'Harbor', board: 'Board', backlog: 'Backlog', epics: 'Epics', fleet: 'Fleet', log: 'Fleet log' };
  document.querySelectorAll('.apps button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#title').textContent = titles[S.view];
  $('#crumbs').innerHTML = `Projects / <a href="#">${esc(S.space || 'All spaces')}</a>${S.harness ? ' / ' + esc(CREW_LABEL[S.harness]) : ''}`;
  $('#groupSeg').style.display = S.view === 'board' ? '' : 'none';
  document.querySelectorAll('#groupSeg button').forEach((b) => b.classList.toggle('active', b.dataset.group === S.group));
  renderSidebar();
  syncHash();
  const tasks = visibleTasks();
  renderStats(tasks);

  const before = new Map();
  document.querySelectorAll('#view .card').forEach((el) => before.set(el.dataset.id, { rect: el.getBoundingClientRect(), lane: el.closest('.col') && el.closest('.col').dataset.lane }));

  const html = S.view === 'board' ? renderBoard(tasks) : S.view === 'backlog' ? renderBacklog(tasks)
    : S.view === 'epics' ? renderEpics(tasks) : S.view === 'fleet' ? renderFleet() : renderLog();
  $('#view').innerHTML = html;

  // FLIP: glide cards that changed position, flash ones that changed lane.
  document.querySelectorAll('#view .card').forEach((el) => {
    const prev = before.get(el.dataset.id);
    if (!prev) return;
    const now = el.getBoundingClientRect();
    const dx = prev.rect.left - now.left;
    const dy = prev.rect.top - now.top;
    const lane = el.closest('.col') && el.closest('.col').dataset.lane;
    if (dx || dy) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: lane !== prev.lane ? 700 : 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    if (lane !== prev.lane) { el.classList.add('flash'); requestAnimationFrame(() => setTimeout(() => el.classList.remove('flash'), 60)); }
  });
}

// ---------- activity ----------
function evHtml(e, isNew) {
  const crew = crewOf(e.actor);
  if (S.view === 'harbor') {
    const [emoji, line] = Harbor.friendly(e);
    return `<li class="ev${isNew ? ' new' : ''}" data-id="${esc(e.task)}"><span class="emoji">${emoji}</span>
      <div><div class="txt">${esc(line)}</div><div class="when"><span>${esc(e.repo || '')}</span><span>·</span><span data-at="${e.at || ''}">${esc(ago(e.at))}</span></div></div></li>`;
  }
  let body = esc(e.text);
  if (e.type === 'moved') body = `moved <b>${esc(e.key)}</b> <span class="lz ${LANE_TONE[e.from]}">${esc(S.lanesById[e.from] || e.from)}</span> <span class="arrow">→</span> <span class="lz ${LANE_TONE[e.to]}">${esc(S.lanesById[e.to] || e.to)}</span>`;
  else if (e.type === 'message') body = `→ <b>${esc(e.key)}</b>: ${esc(e.text)}`;
  else if (e.type === 'created') body = esc(e.text);
  else if (e.type === 'status') body = `<b>${esc(e.key)}</b> ${esc(e.text)}`;
  const verb = e.type === 'status' ? `<span class="lz ${VERB_TONE[e.verb] || 'plain'}">${esc(e.verb)}</span>` : e.type === 'message' ? '<span class="lz plain">message</span>' : '';
  return `<li class="ev${isNew ? ' new' : ''}" data-id="${esc(e.task)}">${avatar(crew)}
    <div><div class="txt"><span class="who">${esc(CREW_LABEL[crew] || e.actor)}</span> ${body}</div>
    <div class="when">${verb}<span>${esc(e.repo || '')}</span><span>·</span><span data-at="${e.at || ''}">${esc(ago(e.at))}</span></div></div></li>`;
}

function renderActivity() {
  const evs = S.events.filter((e) => !S.space || e.repo === S.space).slice(-150).reverse();
  $('#activity').innerHTML = evs.map((e) => evHtml(e, false)).join('');
  $('#actCount').textContent = `${evs.length}`;
}

function addEvents(list) {
  for (const e of list) {
    if (e.seq <= S.lastSeq) continue;
    S.lastSeq = e.seq;
    S.events.push(e);
    if (!S.space || e.repo === S.space) {
      $('#activity').insertAdjacentHTML('afterbegin', evHtml(e, true));
      if (e.type === 'moved' || e.type === 'created' || (e.type === 'status' && ['done', 'blocked'].includes(e.verb))) toast(e);
    }
  }
  if (S.events.length > 800) S.events = S.events.slice(-800);
  if (S.view === 'log') render();
}

function toast(e) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (S.view === 'harbor') { const [emoji, line] = Harbor.friendly(e); el.innerHTML = `${emoji} ${esc(line).slice(0, 160)}`; }
  else el.innerHTML = e.type === 'moved'
    ? `<b>${esc(e.key)}</b> ${esc(S.lanesById[e.from] || e.from)} → <b>${esc(S.lanesById[e.to] || e.to)}</b>`
    : `<b>${esc(e.key)}</b> ${esc(e.text).slice(0, 140)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- drawer ----------
function md(src) {
  if (!src) return '';
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(src));
  return `<pre>${esc(src)}</pre>`;
}

async function openTask(id) {
  if (!id) return;
  const res = await fetch(`/api/task/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const d = await res.json();
  const t = d.task;
  S.openTask = id;
  syncHash();
  const crew = crewOf(t.actor && t.actor.harness);
  const panel = t.lane === 'blocked' ? ['err', '⛔', 'Blocked'] : t.lane === 'review' ? ['info', '🔍', 'Waiting on the lead'] : t.lane === 'done' ? ['ok', '✅', 'Done'] : t.lane === 'dev' ? ['info', '⚙️', 'In development'] : ['warn', '📋', 'Not started'];
  const timeline = [
    ...(d.status || []).map((s) => ({ at: s.at, cls: s.verb, html: `<span class="lz ${VERB_TONE[s.verb] || 'plain'}">${esc(s.verb)}</span> ${esc(s.text)}` })),
    ...(d.inbox || []).map((m) => ({ at: m.at, cls: 'message', html: `<span class="lz plain">first mate → crew</span> ${esc(m.body.split('\n')[0]).slice(0, 300)}` })),
  ].sort((a, b) => (a.at || 0) - (b.at || 0));
  const m = t.meta || {};
  const row = (k, v) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
  $('#drawer').innerHTML = `<div class="page">
    <button class="close" data-close aria-label="Close">×</button>
    <div class="crumbs">${esc(t.repo)} / ${esc(t.epic)} / ${esc(t.key)}</div>
    <h1>${esc(t.title)}</h1>
    <div class="byline">${avatar(crew, t.agent && t.agent.status)} <span>${esc(CREW_LABEL[crew])}${m.model ? ' · ' + esc(m.model) : ''}</span>
      <span class="lz ${LANE_TONE[t.lane]}">${esc(S.lanesById[t.lane])}</span> ${prBadge(t.pr)} ${t.lastAt ? `<span>Updated ${esc(ago(t.lastAt))}</span>` : ''}</div>
    <div class="panel ${panel[0]}">${panel[1]} <div><b>${panel[2]}.</b> ${esc(t.why || '')}</div></div>
    <table class="props">
      ${row('Task', `<code>${esc(t.id)}</code> · ${esc(t.kind)}`)}
      ${row('Epic', esc(t.epic))}
      ${row('Crewmate', t.agent ? `${esc(t.agent.name)} in herdr pane <code>${esc(m.pane)}</code> (${esc(t.agent.status)})` : m.harness ? esc(m.harness) : '')}
      ${row('Delivery', m.mode ? `${esc(m.mode)}${m.yolo === 'on' ? ' + yolo' : ''}` : '')}
      ${row('Branch', t.branch && !t.unassigned ? `<code>${esc(t.branch)}</code>${t.merged ? ' <span class="lz green">merged</span>' : ''}` : '')}
      ${row('Worktree', m.worktree ? `<code>${esc(m.worktree)}</code>` : '')}
      ${row('Pull request', t.pr ? `<a href="${esc(t.pr.url)}" target="_blank" rel="noopener">${esc(t.pr.url)}</a>${t.pr.review ? ' · ' + esc(t.pr.review) : ''}` : '')}
      ${row('Owns', t.card && t.card.owns && t.card.owns.length ? t.card.owns.map((o) => `<code>${esc(o)}</code>`).join(' ') : '')}
      ${row('Card status', t.card ? esc(t.card.status || '') + (t.card.fit ? ` · fit ${esc(t.card.fit)}` : '') : '')}
    </table>
    ${timeline.length ? `<h2>Timeline</h2><ul class="timeline">${timeline.map((x) => `<li class="${esc(x.cls)}"><div>${x.html}</div><div class="tm">${x.at ? esc(new Date(x.at * 1000).toLocaleString()) : ''}</div></li>`).join('')}</ul>` : ''}
    ${d.cardDoc ? `<h2>Card spec</h2><div class="md">${md(d.cardDoc)}</div>` : ''}
    ${d.report ? `<h2>Report</h2><div class="md">${md(d.report)}</div>` : ''}
    ${d.brief ? `<h2>Crewmate brief</h2><div class="md">${md(d.brief)}</div>` : ''}
    ${d.inbox && d.inbox.length ? `<h2>First mate messages</h2>${d.inbox.slice().reverse().map((x) => `<div class="msg"><div class="tm muted">${x.at ? esc(new Date(x.at * 1000).toLocaleString()) : ''} ${x.handled ? '· handled' : '· <b>unread</b>'}</div>${esc(x.body)}</div>`).join('')}` : ''}
  </div>`;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  $('#drawer').scrollTop = 0;
}
function closeDrawer() {
  S.openTask = null;
  syncHash();
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
}

// ---------- wiring ----------
document.addEventListener('click', (ev) => {
  const t = ev.target;
  const btn = t.closest('button');
  if (btn && btn.dataset.view) { S.view = btn.dataset.view; store.set('view', S.view); return render(); }
  if (btn && btn.dataset.space != null) { S.space = btn.dataset.space || null; store.set('space', S.space); renderActivity(); return render(); }
  if (btn && btn.dataset.harness != null) { S.harness = btn.dataset.harness || null; store.set('harness', S.harness); return render(); }
  if (btn && btn.dataset.group) { S.group = btn.dataset.group; store.set('group', S.group); return render(); }
  if (btn && btn.dataset.expand) { S.expanded.add(btn.dataset.expand); return render(); }
  if (btn && btn.hasAttribute('data-close')) return closeDrawer();
  if (t.closest('a')) return;
  const epic = t.closest('[data-epic]');
  if (epic) { const [repo] = epic.dataset.epic.split('::'); S.space = repo; S.group = 'epic'; S.view = 'board'; store.set('space', repo); store.set('group', 'epic'); store.set('view', 'board'); return render(); }
  const item = t.closest('[data-id]');
  if (item && item.closest('#drawer') == null) openTask(item.dataset.id);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === 'Enter' && document.activeElement && document.activeElement.classList.contains('card')) openTask(document.activeElement.dataset.id);
  if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
});
$('#scrim').addEventListener('click', closeDrawer);
$('#q').addEventListener('input', (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });
setInterval(() => document.querySelectorAll('[data-at]').forEach((el) => { el.textContent = ago(Number(el.dataset.at)); }), 30000);

function connect() {
  const live = $('#live');
  const es = new EventSource('/events');
  es.addEventListener('open', () => { live.classList.add('on'); $('#liveText').textContent = 'Live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); $('#liveText').textContent = 'Reconnecting…'; });
  es.addEventListener('board', (m) => {
    const first = !S.board;
    S.board = JSON.parse(m.data);
    if (first && S.space === null && S.board.repos.length) {
      // Default to the space where the fleet is busiest.
      const recent = (r) => Math.max(0, ...S.board.tasks.filter((t) => t.repo === r).map((t) => t.lastAt || 0));
      S.space = S.board.repos.slice().sort((a, b) => recent(b) - recent(a))[0];
    }
    if (S.space && !S.board.repos.includes(S.space)) S.space = null;
    if (first && S.openTask) openTask(S.openTask);
    $('#liveText').textContent = `Live · herdr ${S.board.herdr.ok ? 'on' : 'off'}`;
    render();
  });
  es.addEventListener('history', (m) => {
    S.events = JSON.parse(m.data);
    S.lastSeq = S.events.reduce((a, e) => Math.max(a, e.seq), 0);
    renderActivity();
    if (S.view === 'log') render();
  });
  es.addEventListener('events', (m) => addEvents(JSON.parse(m.data)));
}
// `#snap=1` renders once from the JSON API with no live stream (used for headless screenshots).
if (HASH.get('snap')) {
  Promise.all([fetch('/api/board').then((r) => r.json()), fetch('/api/events').then((r) => r.json())]).then(([b, ev]) => {
    S.board = b;
    S.events = ev;
    if (!S.space) S.space = b.repos[0] || null;
    $('#live').classList.add('on');
    $('#liveText').textContent = `Live · herdr ${b.herdr.ok ? 'on' : 'off'}`;
    render();
    renderActivity();
    if (S.openTask) openTask(S.openTask);
  });
} else connect();
