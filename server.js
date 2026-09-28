#!/usr/bin/env node
// FirstFleet - a Jira/Confluence-style live board for a firstmate fleet.
// Zero dependencies. Strictly read-only over the firstmate home and projects.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const FM_HOME = path.resolve(argVal('--home', process.env.FM_HOME || path.join(__dirname, '..', 'firstmate')));
const PORT = Number(argVal('--port', process.env.PORT || 4777));
const HOST = argVal('--host', process.env.HOST || '127.0.0.1');
const TICK_MS = Number(process.env.FF_TICK_MS || 2000);
const GH_EVERY_MS = Number(process.env.FF_GH_MS || 45000);
const USE_GH = !args.includes('--no-gh');
const USE_HERDR = !args.includes('--no-herdr');

const STATE = path.join(FM_HOME, 'state');
const DATA = path.join(FM_HOME, 'data');
const PUBLIC = path.join(__dirname, 'public');

// Lanes, in board order. Each maps to the crewmate lifecycle firstmate runs.
const LANES = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'selected', name: 'Selected for Dev' },
  { id: 'dev', name: 'In Development' },
  { id: 'blocked', name: 'Blocked' },
  { id: 'review', name: 'In Review / QA' },
  { id: 'done', name: 'Done' },
];
const LANE_NAME = Object.fromEntries(LANES.map((l) => [l.id, l.name]));

// ---------- small fs helpers ----------
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const ls = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function kv(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function frontmatter(text) {
  if (!text || !text.startsWith('---')) return { fm: {}, body: text || '' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const fm = {};
  let lastKey = null;
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      lastKey = m[1];
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      fm[lastKey] = v === '' ? [] : v;
    } else if (lastKey && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(line.replace(/^\s*-\s+/, '').trim());
    }
  }
  return { fm, body: text.slice(end + 4).replace(/^\n/, '') };
}

// ---------- firstmate readers ----------
function parseBacklog() {
  const text = read(path.join(DATA, 'backlog.md')) || '';
  const items = [];
  let section = null;
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { section = h[1].trim().toLowerCase(); cur = null; continue; }
    const m = line.match(/^- \[( |x)\] (\S+) - (.*)$/);
    if (m) {
      const rest = m[3];
      const title = rest.replace(/\s*\((repo|kind):[^)]*\)/g, '').replace(/\s*\((since|done) [^)]*\)/g, '').trim();
      cur = {
        id: m[2],
        checked: m[1] === 'x',
        section,
        title,
        repo: (rest.match(/\(repo: ([^)]+)\)/) || [])[1] || null,
        kind: (rest.match(/\(kind: ([^)]+)\)/) || [])[1] || 'ship',
        since: (rest.match(/\(since ([^)]+)\)/) || [])[1] || null,
        doneAt: (rest.match(/\(done ([^)]+)\)/) || [])[1] || null,
        note: '',
      };
      items.push(cur);
      continue;
    }
    if (cur && /^\s{2,}\S/.test(line)) cur.note += (cur.note ? ' ' : '') + line.trim();
  }
  return items;
}

function parseStatus(id) {
  const text = read(path.join(STATE, `${id}.status`));
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^([\w-]+)\s*(?:\[at=(\d+)\])?:\s*(.*)$/);
    if (!m) return { verb: 'note', at: null, text: line };
    return { verb: m[1].toLowerCase(), at: m[2] ? Number(m[2]) : null, text: m[3] };
  });
}

function parseInbox(id) {
  const dir = path.join(STATE, `${id}.inbox`);
  if (!isDir(dir)) return { pending: 0, messages: [] };
  const msgs = [];
  const take = (file, handled) => {
    const raw = read(file) || '';
    const [head, ...bodyParts] = raw.split('\n--\n');
    const h = kv(head);
    let at = h.at ? Math.floor(Date.parse(h.at) / 1000) : null;
    const base = path.basename(file);
    const tsFromName = base.match(/^(\d{9,})-/);
    if (!at && tsFromName) at = Number(tsFromName[1]);
    msgs.push({ file: base, handled, at, body: (bodyParts.join('\n--\n') || raw).trim().slice(0, 4000) });
  };
  let pending = 0;
  for (const f of ls(dir)) {
    if (f.endsWith('.msg')) { pending++; take(path.join(dir, f), false); }
  }
  for (const f of ls(path.join(dir, 'handled'))) if (f.endsWith('.msg')) take(path.join(dir, 'handled', f), true);
  msgs.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { pending, messages: msgs };
}

function taskIdsInState() {
  const ids = new Set();
  for (const f of ls(STATE)) {
    const m = f.match(/^([a-z0-9][\w-]*)\.(meta|status)$/i);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// ---------- project card boards (the lead's cards/*.md) ----------
const projectCache = new Map();
function projectDir(repo) {
  if (!repo) return null;
  const p = path.join(FM_HOME, 'projects', repo);
  return isDir(p) ? real(p) : null;
}

function loadCards(repo) {
  const dir = projectDir(repo);
  if (!dir) return new Map();
  const cards = new Map();
  for (const sub of ['cards', path.join('board', 'cards')]) {
    const cdir = path.join(dir, sub);
    for (const f of ls(cdir)) {
      if (!f.endsWith('.md') || /^(DISPATCH|README|TEMPLATE|PROTOCOL)\.md$/i.test(f)) continue;
      const file = path.join(cdir, f);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      const key = `${repo}:${file}`;
      const cached = projectCache.get(key);
      let card;
      if (cached && cached.mtime === mtime) card = cached.card;
      else {
        const { fm } = frontmatter(read(file));
        card = {
          id: fm.id || f.replace(/\.md$/, ''),
          title: fm.title || f.replace(/\.md$/, ''),
          wave: fm.wave != null && fm.wave !== '' ? String(fm.wave) : null,
          tier: fm.tier || null,
          size: fm.size || null,
          fit: fm.fit || null,
          status: fm.status || null,
          owns: Array.isArray(fm.owns) ? fm.owns : fm.owns ? [fm.owns] : [],
          depends: Array.isArray(fm.depends) ? fm.depends : [],
          merged: fm.merged || null,
          file,
          createdMs: mtime,
        };
        projectCache.set(key, { mtime, card });
      }
      cards.set(card.id, card);
    }
  }
  return cards;
}

function epicFor(card, cardId) {
  if (card && card.wave) return `Wave ${card.wave}`;
  const id = (card && card.id) || cardId;
  if (id) {
    const m = id.match(/^([A-Z][A-Z0-9]*)-/);
    if (m) return m[1];
  }
  return 'General';
}

// ---------- git + gh ----------
function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: 15000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

const merges = new Map(); // repo -> Set(branch)
async function refreshMerges(repos) {
  for (const repo of repos) {
    const dir = projectDir(repo);
    if (!dir) continue;
    const { stdout } = await run('git', ['-C', dir, 'log', '--all', '--merges', '--format=%s', '-400']);
    const set = new Set();
    for (const s of stdout.split('\n')) {
      for (const m of s.matchAll(/(fm\/[\w.-]+)/g)) set.add(m[1]);
    }
    merges.set(repo, set);
  }
}

const prs = new Map(); // url -> pr info
let lastGh = 0;
async function refreshPRs(slugs) {
  if (!USE_GH || Date.now() - lastGh < GH_EVERY_MS) return;
  lastGh = Date.now();
  for (const slug of slugs) {
    const { ok, stdout } = await run('gh', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '100',
      '--json', 'number,state,url,title,headRefName,mergedAt,reviewDecision,isDraft,statusCheckRollup,updatedAt']);
    if (!ok) continue;
    try {
      for (const pr of JSON.parse(stdout)) {
        const checks = pr.statusCheckRollup || [];
        const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion || c.state)).length;
        const pending = checks.filter((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING').length;
        prs.set(pr.url, {
          number: pr.number, state: pr.state, url: pr.url, title: pr.title, branch: pr.headRefName,
          mergedAt: pr.mergedAt, review: pr.reviewDecision || null, draft: pr.isDraft,
          checks: { total: checks.length, failing, pending },
        });
      }
    } catch {}
  }
}

// ---------- herdr ----------
let herdr = { ok: false, agents: [], workspaces: [], at: 0 };
async function refreshHerdr() {
  if (!USE_HERDR) return;
  // `herdr api snapshot` can exit non-zero while still printing a full snapshot.
  const { stdout } = await run('herdr', ['api', 'snapshot']);
  try {
    const snap = JSON.parse(stdout).result.snapshot;
    herdr = { ok: true, agents: snap.agents || [], workspaces: snap.workspaces || [], at: Date.now() };
  } catch {
    herdr = { ...herdr, ok: false };
  }
}

// ---------- board model ----------
function laneFor(t) {
  if (t.backlogSection === 'done' || t.checked) return { lane: 'done', why: 'Closed in backlog' };
  if (t.pr && t.pr.state === 'MERGED') return { lane: 'done', why: `PR #${t.pr.number} merged` };
  if (t.merged) return { lane: 'done', why: `Merged ${t.branch} locally` };
  if (t.pr && t.pr.state === 'CLOSED') return { lane: 'done', why: `PR #${t.pr.number} closed` };
  const v = t.last && t.last.verb;
  if (v && /^(blocked|needs-decision|decision|failed|error|stuck|paused|hold|on-hold)$/.test(v)) return { lane: 'blocked', why: t.last.text };
  if (v === 'done') return { lane: 'review', why: t.pr ? `PR #${t.pr.number} awaiting lead review` : 'Branch ready for lead review' };
  if (v && /^(working|resolved|started|progress)$/.test(v)) return { lane: 'dev', why: t.last.text };
  if (t.meta && t.agent && t.agent.status === 'working') return { lane: 'dev', why: 'Agent working; no status report yet' };
  if (t.meta) return { lane: 'selected', why: 'Crewmate spawned, setting up worktree' };
  if (t.backlogSection === 'in flight') return { lane: 'selected', why: 'Dispatched' };
  return { lane: 'backlog', why: t.backlogSection === 'queued' ? 'Queued by first mate' : 'On the lead\'s board' };
}

function actorFor(t) {
  const harness = (t.meta && t.meta.harness) || t.fit || null;
  const model = t.meta && t.meta.model;
  return { harness, model };
}

const reachedDev = new Set(); // task ids already seen In Development
let model = null;
let events = [];
let seq = 0;
const MAX_EVENTS = 800;
const seenStatus = new Map(); // id -> count of status lines seen
const seenInbox = new Map(); // id -> Set(files)
const seenAgentStatus = new Map(); // pane -> status
let booted = false;

function pushEvent(ev) {
  ev.seq = ++seq;
  ev.at = ev.at || Math.floor(Date.now() / 1000);
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  return ev;
}

async function buildModel() {
  const backlog = parseBacklog();
  const ids = new Set([...backlog.map((b) => b.id), ...taskIdsInState()]);
  const byId = new Map(backlog.map((b) => [b.id, b]));
  const agentsByPane = new Map(herdr.agents.map((a) => [a.pane_id, a]));

  const repos = new Set(backlog.map((b) => b.repo).filter(Boolean));
  const cardsByRepo = new Map();
  for (const r of repos) cardsByRepo.set(r, loadCards(r));

  const tasks = [];
  const linkedCards = new Set();
  const slugs = new Set();

  for (const id of ids) {
    const b = byId.get(id) || {};
    const meta = kv(read(path.join(STATE, `${id}.meta`)));
    const hasMeta = Object.keys(meta).length > 0;
    const repo = b.repo || (meta.project ? path.basename(meta.project) : null);
    const status = parseStatus(id);
    const last = status[status.length - 1] || null;
    const busy = kv((read(path.join(STATE, `${id}.busy-state`)) || '').replace(/^v1\s+/, '').split(/\s+/).join('\n'));
    const inbox = parseInbox(id);
    const title = b.title || id;
    const cardId = ((title + ' ' + (b.note || '')).match(/card\s+(?:cards\/)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/) || [])[1] || null;
    const cards = cardsByRepo.get(repo) || new Map();
    const card = cardId ? cards.get(cardId) : null;
    if (card) linkedCards.add(`${repo}:${card.id}`);

    let prUrl = meta.pr || null;
    if (!prUrl) for (const s of status) { const m = s.text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/); if (m) prUrl = m[0]; }
    if (prUrl) { const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/); if (m) slugs.add(m[1]); }
    const pr = prUrl ? (prs.get(prUrl) || { url: prUrl, number: Number(prUrl.split('/').pop()), state: 'OPEN', checks: null }) : null;
    const branch = meta.branch || `fm/${id}`;
    const merged = !!(merges.get(repo) && merges.get(repo).has(branch));

    const agent = meta.herdr_pane_id ? agentsByPane.get(meta.herdr_pane_id) : null;
    const t = {
      id, key: card ? card.id : id.toUpperCase(), title: card ? card.title : title, taskTitle: title,
      repo, kind: b.kind || meta.kind || 'ship', backlogSection: b.section || (hasMeta ? 'in flight' : null),
      checked: !!b.checked, since: b.since || null, doneAt: b.doneAt || null, note: b.note || '',
      card: card ? { id: card.id, wave: card.wave, fit: card.fit, owns: card.owns, status: card.status, size: card.size, tier: card.tier } : null,
      epic: epicFor(card, cardId), fit: card && card.fit,
      meta: hasMeta ? {
        harness: meta.harness, model: meta.model, effort: meta.effort, mode: meta.mode, yolo: meta.yolo,
        worktree: meta.worktree, backend: meta.backend, window: meta.window, pane: meta.herdr_pane_id,
      } : null,
      branch, merged, pr, last, statusCount: status.length,
      firstAt: status[0] && status[0].at, lastAt: last && last.at,
      busy: busy.state ? { state: busy.state, source: busy.source, event: busy.event, ts: Number(busy.ts) || null } : null,
      agent: agent ? { status: agent.agent_status, name: agent.agent, title: agent.terminal_title_stripped || null } : null,
      inboxPending: inbox.pending, inboxTotal: inbox.messages.length,
    };
    Object.assign(t, laneFor(t));
    if (t.lane === 'dev') reachedDev.add(id);
    else if (t.lane === 'selected' && reachedDev.has(id)) Object.assign(t, { lane: 'dev', why: 'Agent between turns' });
    t.actor = actorFor(t);
    tasks.push(t);
  }

  // Cards on the lead's board that no crewmate has picked up yet are the true backlog.
  const epics = new Map();
  const addEpic = (repo, name) => {
    const k = `${repo}::${name}`;
    if (!epics.has(k)) epics.set(k, { key: k, repo, name, total: 0, done: 0, active: 0, review: 0, blocked: 0, cards: 0, cardsDone: 0 });
    return epics.get(k);
  };
  for (const [repo, cards] of cardsByRepo) {
    for (const card of cards.values()) {
      const e = addEpic(repo, epicFor(card));
      e.cards++;
      if (/^(done|merged|shipped)$/i.test(card.status || '')) e.cardsDone++;
      if (linkedCards.has(`${repo}:${card.id}`)) continue;
      if (/^(done|merged|shipped|dropped|cancelled)$/i.test(card.status || '')) continue;
      tasks.push({
        id: `card:${repo}:${card.id}`, key: card.id, title: card.title, repo, kind: 'card', lane: 'backlog',
        why: `Card on the lead's board (${card.status || 'draft'})`, epic: epicFor(card), fit: card.fit,
        card: { id: card.id, wave: card.wave, fit: card.fit, owns: card.owns, status: card.status, size: card.size, tier: card.tier },
        actor: { harness: card.fit, model: null }, createdAt: Math.floor(card.createdMs / 1000), unassigned: true,
      });
    }
  }
  for (const t of tasks) {
    const e = addEpic(t.repo, t.epic);
    e.total++;
    if (t.lane === 'done') e.done++;
    else if (t.lane === 'dev' || t.lane === 'selected') e.active++;
    else if (t.lane === 'review') e.review++;
    else if (t.lane === 'blocked') e.blocked++;
  }

  return { tasks, epics: [...epics.values()], repos: [...repos], slugs: [...slugs] };
}

function diffAndEmit(prev, next) {
  const out = [];
  const prevById = new Map(prev ? prev.tasks.map((t) => [t.id, t]) : []);
  for (const t of next.tasks) {
    const p = prevById.get(t.id);
    if (!p && prev) {
      out.push(pushEvent({
        type: 'created', task: t.id, key: t.key, repo: t.repo, lane: t.lane,
        actor: t.unassigned ? 'lead' : 'firstmate',
        text: t.unassigned ? `Lead added ${t.key} to the backlog` : `First mate queued ${t.key}`,
      }));
    } else if (p && p.lane !== t.lane) {
      out.push(pushEvent({
        type: 'moved', task: t.id, key: t.key, repo: t.repo, from: p.lane, to: t.lane,
        actor: t.lane === 'done' || t.lane === 'backlog' ? 'lead' : (t.actor.harness || 'crewmate'),
        text: `${t.key} moved ${LANE_NAME[p.lane]} → ${LANE_NAME[t.lane]}`, why: t.why,
      }));
    }
  }
  return out;
}

function harvestLogEvents(tasks, quiet) {
  const out = [];
  for (const t of tasks) {
    if (t.unassigned) continue;
    const status = parseStatus(t.id);
    const seen = seenStatus.get(t.id) || 0;
    for (let i = seen; i < status.length; i++) {
      const s = status[i];
      const ev = { type: 'status', task: t.id, key: t.key, repo: t.repo, actor: t.actor.harness || 'crewmate', verb: s.verb, text: s.text, at: s.at || undefined };
      if (quiet) { ev.seq = ++seq; events.push(ev); } else out.push(pushEvent(ev));
    }
    seenStatus.set(t.id, status.length);

    const inbox = parseInbox(t.id);
    const set = seenInbox.get(t.id) || new Set();
    for (const m of inbox.messages) {
      const k = m.file + (m.handled ? ':h' : '');
      if (set.has(k) || set.has(m.file) || set.has(m.file + ':h')) { set.add(k); continue; }
      set.add(k);
      const first = m.body.split('\n').find((l) => l.trim()) || '';
      const ev = { type: 'message', task: t.id, key: t.key, repo: t.repo, actor: 'firstmate', text: first.slice(0, 220), at: m.at || undefined };
      if (quiet) { ev.seq = ++seq; events.push(ev); } else out.push(pushEvent(ev));
    }
    seenInbox.set(t.id, set);
  }
  if (quiet) {
    events.sort((a, b) => (a.at || 0) - (b.at || 0));
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    events.forEach((e, i) => { e.seq = i + 1; });
    seq = events.length;
  }
  return out;
}

function fleetAgents() {
  const wsById = new Map(herdr.workspaces.map((w) => [w.workspace_id, w]));
  return herdr.agents.map((a) => ({
    pane: a.pane_id, agent: a.agent, name: a.name || null, status: a.agent_status,
    title: a.terminal_title_stripped || null, workspace: (wsById.get(a.workspace_id) || {}).label || a.workspace_id,
    cwd: a.foreground_cwd || a.cwd,
  }));
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

function snapshot() {
  return {
    home: FM_HOME, lanes: LANES, generated: Date.now(), herdr: { ok: herdr.ok, at: herdr.at },
    tasks: model ? model.tasks : [], epics: model ? model.epics : [], repos: model ? model.repos : [],
    agents: fleetAgents(),
  };
}

let ticking = false;
let lastSig = '';
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshHerdr();
    const next = await buildModel();
    await refreshMerges(next.repos);
    await refreshPRs(next.slugs);
    const final = await buildModel();
    const newEvents = booted ? harvestLogEvents(final.tasks, false) : harvestLogEvents(final.tasks, true);
    newEvents.push(...(booted ? diffAndEmit(model, final) : []));
    model = final;
    booted = true;
    const snap = snapshot();
    const sig = JSON.stringify({ t: snap.tasks, a: snap.agents, e: snap.epics });
    if (sig !== lastSig || newEvents.length) {
      lastSig = sig;
      broadcast('board', snap);
      if (newEvents.length) broadcast('events', newEvents);
    }
  } catch (err) {
    console.error('[firstfleet] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

// ---------- detail endpoint ----------
function taskDetail(id) {
  const t = model && model.tasks.find((x) => x.id === id);
  if (!t) return null;
  const detail = { task: t };
  if (!t.unassigned) {
    detail.status = parseStatus(id);
    detail.brief = read(path.join(DATA, id, 'brief.md'));
    detail.report = read(path.join(DATA, id, 'report.md'));
    detail.inbox = parseInbox(id).messages.slice(-25);
  }
  if (t.card) {
    const dir = projectDir(t.repo);
    const cards = loadCards(t.repo);
    const c = cards.get(t.card.id);
    if (c) detail.cardDoc = frontmatter(read(c.file)).body;
    if (dir) detail.projectDir = dir;
  }
  detail.events = events.filter((e) => e.task === id).slice(-60);
  return detail;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`retry: 2000\n\n`);
    res.write(`event: board\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(events.slice(-300))}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (url.pathname === '/api/board') return json(snapshot());
  if (url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0);
    return json(events.filter((e) => e.seq > since));
  }
  if (url.pathname.startsWith('/api/task/')) {
    const d = taskDetail(decodeURIComponent(url.pathname.slice('/api/task/'.length)));
    return d ? json(d) : json({ error: 'not found' }, 404);
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

if (!isDir(STATE)) {
  console.error(`[firstfleet] no firstmate state at ${STATE}. Pass --home <firstmate checkout> or set FM_HOME.`);
  process.exit(1);
}

// Wake early on filesystem changes; the interval is the backstop.
let debounce = null;
const poke = () => { clearTimeout(debounce); debounce = setTimeout(tick, 250); };
for (const dir of [STATE, DATA]) {
  try { fs.watch(dir, { recursive: true }, poke); } catch { try { fs.watch(dir, poke); } catch {} }
}
setInterval(tick, TICK_MS);

tick().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`[firstfleet] watching ${FM_HOME}`);
    console.log(`[firstfleet] board at http://${HOST}:${PORT}  (${model.tasks.length} cards, herdr ${herdr.ok ? 'live' : 'off'})`);
  });
});
