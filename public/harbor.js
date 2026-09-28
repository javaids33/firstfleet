'use strict';
// Harbor mode: the fleet as ships. Backlog is the shipyard, dispatch is the slipway,
// development is open sea, blockers are storms, review is the lighthouse, merged is the harbor.
// Ships are persistent DOM nodes so a lane change becomes a visible voyage across the scene.

const Harbor = (() => {
  const ZONES = {
    backlog:  { x0: 0.012, x1: 0.118, y0: 0.33, y1: 0.915, label: 'Shipyard', icon: '🔨', blurb: 'Planned, not started yet' },
    selected: { x0: 0.125, x1: 0.205, y0: 0.33, y1: 0.915, label: 'Slipway', icon: '🪵', blurb: 'Agent just picked it up' },
    blocked:  { x0: 0.25,  x1: 0.56,  y0: 0.31, y1: 0.45, label: 'Storm', icon: '🌩️', blurb: 'Stuck, needs a hand' },
    dev:      { x0: 0.23,  x1: 0.585, y0: 0.50, y1: 0.915, label: 'Open sea', icon: '⛵', blurb: 'Agent is building it now' },
    review:   { x0: 0.60,  x1: 0.755, y0: 0.43, y1: 0.915, label: 'Lighthouse', icon: '🗼', blurb: 'Finished, waiting for review' },
    done:     { x0: 0.775, x1: 0.99,  y0: 0.33, y1: 0.915, label: 'Fleet harbor', icon: '⚓', blurb: 'Merged and shipped' },
  };
  const JOURNEY = ['backlog', 'selected', 'dev', 'review', 'done'];
  const SHIP_W = 104;
  const SHIP_H = 84;
  const ARRIVE = { selected: '🪵 Boarding', dev: '⛵ Set sail!', blocked: '🌩️ Storm!', review: '🗼 Inspect me', done: '⚓ Docked!', backlog: '🔨 Back to the yard' };
  const STALE_SEC = 30 * 60;

  let scene = null;
  let shipsEl = null;
  const ships = new Map(); // id -> { el, lane, x, y }
  let lastBoard = null;
  let mobilePrev = new Map();

  const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };
  const shortName = (t) => {
    let s = String(t.title || t.key).split(/[:(—–]/)[0].trim();
    if (s.length > 24) s = s.slice(0, 23).trimEnd() + '…';
    return s || t.key;
  };
  const crewName = (t) => CREW_LABEL[crewOf(t.actor && t.actor.harness)] || 'Crew';
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const becalmed = (t) => t.lane === 'dev' && !(t.agent && t.agent.status === 'working') && t.lastAt && Date.now() / 1000 - t.lastAt > STALE_SEC;
  const dur = (sec) => {
    if (!sec) return '';
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.round((d % 3600) / 60)}m`;
    return `${Math.round(d / 86400)}d`;
  };

  function shipSvg(extra = '') {
    return `<svg viewBox="0 0 80 58" class="ship-svg" aria-hidden="true">
      <path class="wake" d="M2 47 Q14 43 26 47 T50 47" />
      <rect class="mast" x="39" y="5" width="2.4" height="35" rx="1" />
      <path class="flag" d="M40.5 5 L40.5 0.5 L50 2.8 Z" />
      <path class="sail main" d="M42.5 8 Q60 22 66 37 L42.5 37 Z" />
      <path class="sail jib" d="M38 12 Q26 26 19 37 L38 37 Z" />
      <path class="hull" d="M6 39 L75 39 Q71 48 63 52 L18 52 Q10 48 6 39 Z" />
      <path class="stripe" d="M9 42.5 L72 42.5" />
      <circle class="port" cx="26" cy="46.5" r="1.6" /><circle class="port" cx="40" cy="46.5" r="1.6" /><circle class="port" cx="54" cy="46.5" r="1.6" />
      ${extra}
    </svg>`;
  }

  // ---------- desktop scene ----------
  function build(el) {
    el.innerHTML = `<div class="harbor" id="harbor">
      <div class="sky"><div class="sun"></div><div class="cloud c1"></div><div class="cloud c2"></div><div class="cloud c3"></div><div class="stars"></div></div>
      <div class="sea"><div class="waves w1"></div><div class="waves w2"></div><div class="waves w3"></div></div>
      <div class="land yard"><div class="crane"></div><div class="ramp"></div></div>
      <div class="storm"><div class="storm-cloud"></div><div class="rain"></div><div class="bolt"></div></div>
      <div class="rock"></div>
      <svg class="lighthouse" viewBox="0 0 60 140" aria-hidden="true">
        <path class="lh-beam" d="M30 22 L-160 0 L-160 44 Z" />
        <path class="lh-beam b2" d="M30 22 L220 0 L220 44 Z" />
        <rect x="20" y="12" width="20" height="16" rx="2" class="lh-lamp" />
        <path d="M17 12 L30 3 L43 12 Z" class="lh-roof" />
        <path d="M19 28 L41 28 L46 130 L14 130 Z" class="lh-tower" />
        <path d="M17.5 50 L42.5 50 L43.4 64 L16.6 64 Z M16 86 L44 86 L44.9 100 L15.1 100 Z" class="lh-band" />
      </svg>
      <div class="land port"><div class="pier p1"></div><div class="pier p2"></div><div class="pier p3"></div><div class="town"></div></div>
      <div class="zone-labels"></div>
      <div class="hud"><div class="headline"></div><div class="waters"></div></div>
      <div class="flagship" data-role="firstmate" role="button" tabindex="0"></div>
      <div class="harbormaster" data-role="lead" role="button" tabindex="0"></div>
      <div class="ships"></div>
      <div class="fx"></div>
      <div class="overflow"></div>
      <div class="journey"></div>
      <div class="manifest" hidden></div>
    </div>`;
    scene = el.querySelector('.harbor');
    shipsEl = scene.querySelector('.ships');
    ships.clear();
    scene.addEventListener('click', (e) => {
      const w = e.target.closest('[data-water]');
      if (w) { e.stopPropagation(); S.space = w.dataset.water || null; store.set('space', S.space); render(); renderActivity(); return; }
      const z = e.target.closest('[data-zone]');
      if (z) { e.stopPropagation(); openZone(z.dataset.zone); return; }
      const r = e.target.closest('[data-role]');
      if (r) { e.stopPropagation(); openConsole(r.dataset.role); }
    });
    shipsEl.addEventListener('mouseover', (e) => { const s = e.target.closest('.ship'); if (s) showManifest(s); });
    shipsEl.addEventListener('mouseleave', hideManifest);
    shipsEl.addEventListener('mouseout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.ship')) hideManifest(); });
  }

  function layout(lane, list, rect) {
    const z = ZONES[lane];
    const W = rect.width, H = rect.height;
    const x0 = z.x0 * W, x1 = z.x1 * W - SHIP_W, y0 = z.y0 * H, y1 = z.y1 * H - SHIP_H;
    const cols = Math.max(1, Math.floor((x1 - x0) / (SHIP_W * 0.92)) + 1);
    const rows = Math.max(1, Math.floor((y1 - y0) / (SHIP_H * 0.9)) + 1);
    const cap = cols * rows;
    const shown = list.length > cap ? list.slice(0, cap - 1) : list;
    const pos = new Map();
    const dx = cols > 1 ? (x1 - x0) / (cols - 1) : 0;
    const dy = rows > 1 ? (y1 - y0) / (rows - 1) : 0;
    shown.forEach((t, i) => {
      // Open sea fills from the lighthouse side, so the longest voyages sit closest to port.
      const fromRight = lane === 'dev' || lane === 'blocked' || lane === 'review';
      const c = i % cols, r = Math.floor(i / cols);
      const col = fromRight ? cols - 1 - c : c;
      const jx = lane === 'dev' || lane === 'blocked' ? (hash(t.id) - 0.5) * Math.min(dx * 0.5, 40) : 0;
      const jy = lane === 'dev' ? (hash(t.id + 'y') - 0.5) * Math.min(dy * 0.4, 20) : 0;
      pos.set(t.id, { x: x0 + col * dx + jx, y: y0 + r * dy + jy });
    });
    return { pos, hidden: list.length - shown.length };
  }

  function laneOrder(lane) {
    return (a, b) => {
      if (lane === 'dev' || lane === 'blocked' || lane === 'review') return (a.firstAt || 0) - (b.firstAt || 0) || a.id.localeCompare(b.id);
      if (lane === 'done') return (b.lastAt || 0) - (a.lastAt || 0) || a.id.localeCompare(b.id);
      return laneSort(lane)(a, b);
    };
  }

  function byLane(tasks) {
    const by = {};
    for (const l of Object.keys(ZONES)) by[l] = tasks.filter((t) => t.lane === l).sort(laneOrder(l));
    return by;
  }

  function update(el) {
    if (!S.board) return;
    lastBoard = S.board;
    if (isMobile()) return updateMobile(el);
    if (!scene || !el.contains(scene)) build(el);
    const tasks = visibleTasks();
    const rect = scene.getBoundingClientRect();
    const by = byLane(tasks);

    const placed = new Map();
    const overflow = [];
    for (const lane of Object.keys(ZONES)) {
      const { pos, hidden } = layout(lane, by[lane], rect);
      for (const [id, p] of pos) placed.set(id, { ...p, lane });
      if (hidden > 0) {
        const z = ZONES[lane];
        overflow.push(`<button class="more-ships" data-zone="${lane}" style="left:${z.x1 * rect.width - SHIP_W}px;top:${z.y1 * rect.height - 26}px">+${hidden} more · see all</button>`);
      }
    }
    scene.querySelector('.overflow').innerHTML = overflow.join('');

    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const [id, s] of ships) {
      if (!placed.has(id)) { s.el.classList.add('sinking'); setTimeout(() => s.el.remove(), 800); ships.delete(id); }
    }
    for (const [id, p] of placed) {
      const t = byId.get(id);
      let s = ships.get(id);
      const crew = crewOf(t.actor && t.actor.harness);
      const agent = t.agent ? t.agent.status : null;
      if (!s) {
        const div = document.createElement('div');
        div.className = 'ship launching';
        div.dataset.id = id;
        div.innerHTML = `<div class="bob">${shipSvg()}</div><div class="bubble"></div><div class="speech"></div><div class="zzz">💤</div><div class="plate"><b></b><span></span></div>`;
        div.style.transform = `translate(${p.x}px, ${p.y}px)`;
        shipsEl.appendChild(div);
        setTimeout(() => div.classList.remove('launching'), 900);
        s = { el: div, lane: p.lane, x: p.x, y: p.y };
        ships.set(id, s);
      } else if (s.lane !== p.lane) {
        voyage(s, p);
      } else if (!s.sailing) {
        s.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
      s.lane = p.lane; s.x = p.x; s.y = p.y;
      s.el.style.zIndex = String(10 + Math.round(p.y));
      s.el.className = s.el.className.replace(/\b(crew|lane|agent)-\S+|\bbecalmed\b/g, '').replace(/\s+/g, ' ').trim()
        + ` crew-${crew} lane-${p.lane} agent-${agent || 'none'}${becalmed(t) ? ' becalmed' : ''}`;
      s.el.setAttribute('aria-label', `${t.title}, ${ZONES[p.lane].label}, ${crewName(t)}`);
      s.el.querySelector('.plate b').textContent = shortName(t);
      s.el.querySelector('.plate span').textContent = p.lane === 'backlog' ? (t.unassigned ? 'plan' : 'queued') : `${crewName(t)}${t.pr ? ' · PR #' + t.pr.number : ''}`;
    }

    renderLabels(by, rect);
    renderJourney(by);
    renderCharacters(rect);
    renderHud(tasks);
  }

  // A lane change sails the ship along an arc, trailing foam, with an arrival effect.
  function voyage(s, p) {
    const el = s.el;
    const from = { x: s.x, y: s.y };
    const lift = Math.min(90, 30 + Math.abs(p.x - from.x) * 0.12);
    const mid = { x: (from.x + p.x) / 2, y: Math.min(from.y, p.y) - lift };
    s.sailing = true;
    el.classList.add('voyage');
    el.style.zIndex = '950';
    bubble(el, ARRIVE[p.lane]);
    const anim = el.animate([
      { transform: `translate(${from.x}px, ${from.y}px)` },
      { transform: `translate(${mid.x}px, ${mid.y}px)`, offset: 0.5 },
      { transform: `translate(${p.x}px, ${p.y}px)` },
    ], { duration: 3800, easing: 'cubic-bezier(.45,.05,.3,1)' });
    const fx = scene.querySelector('.fx');
    const trail = setInterval(() => {
      const r = el.getBoundingClientRect(), sr = scene.getBoundingClientRect();
      const f = document.createElement('i');
      f.className = 'foam';
      f.style.left = `${r.left - sr.left + 30 + Math.random() * 10}px`;
      f.style.top = `${r.top - sr.top + 44}px`;
      fx.appendChild(f);
      setTimeout(() => f.remove(), 1600);
    }, 90);
    anim.onfinish = () => {
      clearInterval(trail);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      el.classList.remove('voyage');
      s.sailing = false;
      arrive(el, p.lane);
    };
  }

  function arrive(el, lane) {
    const fx = scene.querySelector('.fx');
    const r = el.getBoundingClientRect(), sr = scene.getBoundingClientRect();
    const cx = r.left - sr.left + r.width / 2, cy = r.top - sr.top + 34;
    const ring = document.createElement('i');
    ring.className = 'splash';
    ring.style.left = `${cx}px`; ring.style.top = `${cy + 12}px`;
    fx.appendChild(ring);
    setTimeout(() => ring.remove(), 1200);
    if (lane === 'done') {
      const colors = ['#f2c14e', '#22a06b', '#d94c3d', '#4285f4', '#ffffff', '#d97757'];
      for (let i = 0; i < 22; i++) {
        const c = document.createElement('i');
        c.className = 'confetti';
        c.style.left = `${cx}px`; c.style.top = `${cy}px`;
        c.style.background = colors[i % colors.length];
        fx.appendChild(c);
        const a = (Math.PI * 2 * i) / 22, d = 40 + Math.random() * 50;
        c.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 30}px) rotate(${Math.random() * 540}deg)`, opacity: 0 }], { duration: 1400, easing: 'cubic-bezier(.2,.8,.3,1)' });
        setTimeout(() => c.remove(), 1400);
      }
    } else if (lane === 'blocked') {
      scene.classList.add('flash-storm');
      setTimeout(() => scene.classList.remove('flash-storm'), 700);
    } else if (lane === 'review') {
      scene.classList.add('flash-beacon');
      setTimeout(() => scene.classList.remove('flash-beacon'), 2400);
    }
  }

  function bubble(el, text, ms = 6500) {
    const b = el.querySelector('.bubble');
    if (!b || !text) return;
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('show'), ms);
  }

  function speak(el, text, ms = 7000) {
    const b = el.querySelector('.speech');
    if (!b || !text) return;
    b.textContent = text.length > 80 ? text.slice(0, 79) + '…' : text;
    b.classList.add('show');
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('show'), ms);
  }

  function renderLabels(by, rect) {
    scene.querySelector('.zone-labels').innerHTML = Object.entries(ZONES).map(([lane, z]) => {
      const top = lane === 'blocked' ? z.y0 - 0.08 : lane === 'dev' ? z.y0 - 0.065 : 0.235;
      const left = lane === 'review' ? z.x0 + 0.005 : z.x0;
      const maxw = Math.max(120, (z.x1 - z.x0) * rect.width - 6);
      return `<button class="zone-label zl-${lane}" data-zone="${lane}" style="left:${left * rect.width}px;top:${top * rect.height}px;max-width:${maxw}px">
        <span class="zl-top"><span class="zi">${z.icon}</span><b>${z.label}</b><span class="zn">${by[lane].length}</span></span>
        <small>${z.blurb}</small></button>`;
    }).join('');
  }

  function renderJourney(by) {
    const step = (l) => `<button class="step st-${l}" data-zone="${l}"><span>${ZONES[l].icon}</span><b>${ZONES[l].label}</b><em>${by[l].length}</em></button>`;
    scene.querySelector('.journey').innerHTML = `<span class="j-title">How a task sails</span>
      ${JOURNEY.map(step).join('<span class="j-arrow">→</span>')}
      <span class="j-sep"></span>${step('blocked')}
      <span class="j-key"><i class="k claude"></i>Claude <i class="k codex"></i>Codex <i class="k agy"></i>Antigravity <span class="k-wake">〰</span> typing <span>💤</span> quiet 30m+</span>`;
  }

  function renderCharacters(rect) {
    const roles = S.board.roles || {};
    const fm = roles.firstmate;
    const lead = roles.lead;
    const f = scene.querySelector('.flagship');
    f.style.left = `${0.205 * rect.width}px`;
    f.style.top = `${0.29 * rect.height}px`;
    const fmState = fm ? (fm.status === 'working' ? 'giving orders…' : fm.status) : 'not in herdr';
    f.className = `flagship role-${fm ? fm.status : 'none'}`;
    if (!f.firstChild) f.innerHTML = `<div class="bob">${shipSvg('<text x="44" y="30" class="fm-flag">FM</text>')}</div><div class="bubble"></div><div class="plate"><b>First mate</b><span></span></div>`;
    f.querySelector('.plate span').textContent = fmState;
    f.title = fm && fm.title ? `First mate: ${fm.title}` : 'First mate';
    const h = scene.querySelector('.harbormaster');
    h.style.left = `${0.695 * rect.width}px`;
    h.style.top = `${0.125 * rect.height}px`;
    h.className = `harbormaster role-${lead ? lead.status : 'none'}`;
    h.innerHTML = `<span class="hm-ico">🧑‍✈️</span><span><b>Lead</b><small>${lead ? (lead.status === 'working' ? 'reviewing…' : lead.status) : 'not found'}</small></span>`;
    h.title = lead && lead.title ? `Lead (harbor master): ${lead.title}` : 'Lead (harbor master)';
  }

  function renderHud(tasks) {
    const c = (l) => tasks.filter((t) => t.lane === l).length;
    const rowing = (S.board.agents || []).filter((a) => a.status === 'working').length;
    const where = S.space || 'every project';
    const bits = [];
    if (c('dev') + c('selected')) bits.push(`<b>${c('dev') + c('selected')}</b> at sea`);
    if (c('blocked')) bits.push(`<b class="warn">${c('blocked')}</b> caught in a storm`);
    if (c('review')) bits.push(`<b>${c('review')}</b> waiting at the lighthouse`);
    bits.push(`<b>${c('done')}</b> home in harbor`);
    const calm = tasks.filter(becalmed).length;
    if (calm) bits.push(`<b>${calm}</b> becalmed 💤`);
    scene.querySelector('.headline').innerHTML = headline(rowing, where, bits);
    scene.querySelector('.waters').innerHTML = waters();
  }

  const headline = (rowing, where, bits) => `<div class="h1">${rowing ? `<span class="rowing"></span>${rowing} agent${rowing === 1 ? ' is' : 's are'} working on <em>${esc(where)}</em>` : `The fleet is resting in <em>${esc(where)}</em>`}</div>
      <div class="h2">${bits.join(' · ')}</div>`;
  const waters = () => [`<button data-water="" class="${!S.space ? 'on' : ''}">All projects</button>`,
    ...(S.board.repos || []).map((r) => `<button data-water="${esc(r)}" class="${S.space === r ? 'on' : ''}">${esc(r)}</button>`)].join('');

  // ---------- ship manifest (hover card) ----------
  function manifestHtml(t) {
    const z = ZONES[t.lane];
    const crew = crewOf(t.actor && t.actor.harness);
    const inZone = t.lane === 'dev' && t.firstAt ? `at sea ${dur(t.firstAt)}` : t.lane === 'review' && t.lastAt ? `waiting ${dur(t.lastAt)}` : t.lane === 'done' && t.lastAt ? `docked ${ago(t.lastAt)}` : '';
    const latest = t.lane === 'backlog' ? (t.unassigned ? 'A plan on the lead\'s board. No agent assigned yet.' : 'Queued by the first mate. Sails when a crew slot frees up.') : (t.why || '');
    return `<div class="mf-top">${avatar(crew, t.agent && t.agent.status)}<div><b>${esc(t.title)}</b><small>${esc(crewName(t))}${t.actor && t.actor.model ? ' · ' + esc(t.actor.model) : ''}</small></div></div>
      <div class="mf-zone"><span>${z.icon} ${z.label}</span><em>${z.blurb}</em></div>
      ${latest ? `<p class="mf-latest">${becalmed(t) ? '💤 No news for a while. ' : ''}“${esc(latest.slice(0, 180))}”</p>` : ''}
      <div class="mf-facts">
        ${inZone ? `<span>⏱ ${esc(inZone)}</span>` : ''}
        ${t.lastAt ? `<span>📣 last report ${esc(ago(t.lastAt))}</span>` : ''}
        ${t.pr ? `<span>🔗 PR #${esc(t.pr.number)}${t.pr.state === 'MERGED' ? ' merged' : ''}</span>` : ''}
        ${t.inboxPending ? `<span>📜 ${t.inboxPending} unread order${t.inboxPending > 1 ? 's' : ''}</span>` : ''}
        ${t.agent ? `<span>🖥️ agent ${esc(t.agent.status)}</span>` : ''}
      </div>
      <div class="mf-hint">Click to open the full logbook${t.meta && t.meta.pane ? ' and live terminal' : ''}</div>`;
  }

  function showManifest(shipEl) {
    const t = lastBoard && lastBoard.tasks.find((x) => x.id === shipEl.dataset.id);
    if (!t) return;
    const m = scene.querySelector('.manifest');
    m.innerHTML = manifestHtml(t);
    m.hidden = false;
    const r = shipEl.getBoundingClientRect(), sr = scene.getBoundingClientRect();
    const w = 300;
    let left = r.left - sr.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(sr.width - w - 8, left));
    let top = r.top - sr.top - m.offsetHeight - 10;
    if (top < 8) top = r.bottom - sr.top + 8;
    m.style.left = `${left}px`; m.style.top = `${top}px`;
  }
  function hideManifest() { if (scene) scene.querySelector('.manifest').hidden = true; }

  // ---------- zone roster (everything in a zone, including overflow) ----------
  function openZone(lane) {
    const z = ZONES[lane];
    const list = byLane(visibleTasks())[lane];
    openPanel(`<div class="page">
      <button class="close" data-close aria-label="Close">×</button>
      <div class="crumbs">${esc(S.space || 'All projects')} / Harbor</div>
      <h1>${z.icon} ${z.label} <span class="muted" style="font-weight:400">${list.length}</span></h1>
      <div class="panel info">ℹ️ <div><b>${z.blurb}.</b> ${zoneExplain(lane)}</div></div>
      ${list.length ? `<ul class="roster">${list.map((t) => rosterRow(t)).join('')}</ul>` : '<div class="empty">Nobody here right now.</div>'}
    </div>`);
  }

  function zoneExplain(lane) {
    return {
      backlog: 'Cards on the lead\'s board and tasks the first mate has queued. They set sail when an agent picks them up.',
      selected: 'The first mate just spawned an agent with its own git worktree. It is reading the card and setting up.',
      dev: 'An agent is writing code and running tests. A foaming wake means it is typing right now.',
      blocked: 'The agent reported it is blocked or paused. It usually needs a decision from you or the lead.',
      review: 'The agent says it is done. A pull request or branch is waiting for the lead to review and merge.',
      done: 'Merged. The work is in the main branch.',
    }[lane];
  }

  function rosterRow(t) {
    const crew = crewOf(t.actor && t.actor.harness);
    return `<li data-id="${esc(t.id)}" class="crew-${crew}${becalmed(t) ? ' becalmed' : ''}">
      <span class="mini">${shipSvg()}</span>
      <div><b>${esc(t.title)}</b>
      <small>${esc(t.lane === 'backlog' ? (t.unassigned ? 'Plan · ' + (t.card && t.card.status || 'draft') : 'Queued') : crewName(t))}${t.pr ? ' · PR #' + esc(t.pr.number) : ''}${t.lastAt ? ' · ' + esc(ago(t.lastAt)) : ''}</small>
      ${t.lane !== 'backlog' && t.why ? `<p>${becalmed(t) ? '💤 ' : ''}${esc(t.why.slice(0, 160))}</p>` : ''}</div>
      <span class="key mono">${esc(t.key)}</span></li>`;
  }

  // ---------- first mate / lead console ----------
  function openConsole(role) {
    const r = (S.board.roles || {})[role];
    const control = role === 'firstmate' && S.board.remote && S.board.remote.control;
    const name = role === 'firstmate' ? 'First mate' : 'Lead (harbor master)';
    const blurb = role === 'firstmate'
      ? 'The first mate is the one agent you talk to. It dispatches the crew, supervises them, and reports back.'
      : 'The lead reviews finished work at the lighthouse and merges it into the harbor.';
    openPanel(`<div class="page console">
      <button class="close" data-close aria-label="Close">×</button>
      <div class="crumbs">Harbor / ${esc(name)}</div>
      <h1>${role === 'firstmate' ? '⛵' : '🧑‍✈️'} ${esc(name)}</h1>
      <div class="byline">${r ? `<span class="lz ${r.status === 'working' ? 'green' : r.status === 'idle' ? 'yellow' : 'blue'}">${esc(r.status)}</span> <span>${esc(r.title || '')}</span> <code>${esc(r.pane)}</code>` : '<span>Not found in herdr.</span>'}</div>
      <div class="panel info">ℹ️ <div>${blurb}</div></div>
      ${control ? `<form class="talk" id="talk">
        <label for="talkText"><b>Message your first mate</b> <small>It lands in the first mate's session exactly like typing at the keyboard.</small></label>
        <div class="chips">${['How is the fleet doing?', 'Anything blocked?', 'Which PRs are ready to merge?', 'Dispatch the next wave'].map((q) => `<button type="button" data-say="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <textarea id="talkText" rows="3" maxlength="4000" placeholder="Ahoy! …"></textarea>
        <div class="talk-row"><span id="talkStatus" class="muted"></span><button type="submit" class="send">Send to first mate</button></div>
      </form>` : role === 'firstmate' ? `<div class="panel warn">🔒 <div>Read-only. Start FirstFleet with <code>--allow-control</code> to message the first mate from here or your phone.</div></div>` : ''}
      ${r ? `<h2>🖥️ Live terminal</h2><pre class="term" data-pane="${esc(r.pane)}">Loading…</pre>` : ''}
    </div>`);
    const form = document.getElementById('talk');
    if (form) {
      form.addEventListener('click', (e) => { const b = e.target.closest('[data-say]'); if (b) { form.talkText.value = b.dataset.say; form.talkText.focus(); } });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = form.talkText.value.trim();
        if (!text) return;
        const st = document.getElementById('talkStatus');
        st.textContent = 'Sending…';
        try {
          const res = await fetch('/api/firstmate/prompt', { method: 'POST', headers: { 'content-type': 'application/json', 'x-firstfleet': '1' }, body: JSON.stringify({ text }) });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || res.statusText);
          st.textContent = '✓ Sent. Watch the terminal below for the reply.';
          form.talkText.value = '';
        } catch (err) { st.textContent = '✕ ' + err.message; }
      });
    }
    startTerminal();
  }

  // ---------- phone layout ----------
  const MOBILE_ORDER = ['dev', 'blocked', 'review', 'selected', 'done', 'backlog'];
  function updateMobile(el) {
    scene = null;
    const tasks = visibleTasks();
    const by = byLane(tasks);
    const rowing = (S.board.agents || []).filter((a) => a.status === 'working').length;
    const c = (l) => by[l].length;
    const bits = [];
    if (c('dev') + c('selected')) bits.push(`<b>${c('dev') + c('selected')}</b> at sea`);
    if (c('blocked')) bits.push(`<b class="warn">${c('blocked')}</b> in a storm`);
    if (c('review')) bits.push(`<b>${c('review')}</b> at the lighthouse`);
    bits.push(`<b>${c('done')}</b> in harbor`);
    const fm = (S.board.roles || {}).firstmate;
    const moved = new Set();
    for (const t of tasks) { const p = mobilePrev.get(t.id); if (p && p !== t.lane) moved.add(t.id); }
    mobilePrev = new Map(tasks.map((t) => [t.id, t.lane]));
    const limit = { done: 8, backlog: 8 };
    const section = (lane) => {
      const list = by[lane];
      if (!list.length && (lane === 'blocked' || lane === 'selected')) return '';
      const z = ZONES[lane];
      const shown = limit[lane] ? list.slice(0, limit[lane]) : list;
      return `<section class="m-zone mz-${lane}">
        <button class="m-zone-h" data-zone="${lane}"><span class="zi">${z.icon}</span><span><b>${z.label}</b><small>${z.blurb}</small></span><em>${list.length}</em></button>
        <ul class="roster">${shown.map((t) => rosterRow(t).replace('<li ', `<li ${moved.has(t.id) ? 'data-arrived="1" ' : ''}`)).join('')}</ul>
        ${list.length > shown.length ? `<button class="more" data-zone="${lane}">See all ${list.length}</button>` : ''}
      </section>`;
    };
    el.innerHTML = `<div class="mharbor">
      <div class="m-sea"><div class="waves w1"></div></div>
      <div class="m-head">${headline(rowing, S.space || 'every project', bits)}</div>
      <div class="m-waters">${waters()}</div>
      <button class="m-fm" data-role="firstmate">⛵ <span><b>First mate</b><small>${fm ? esc(fm.status === 'working' ? 'giving orders…' : fm.status) : 'not in herdr'}${S.board.remote && S.board.remote.control ? ' · tap to message' : ' · tap to watch'}</small></span><em>›</em></button>
      ${MOBILE_ORDER.map(section).join('')}
    </div>`;
    el.querySelectorAll('[data-arrived]').forEach((li) => li.classList.add('arrived'));
    const root = el.querySelector('.mharbor');
    root.addEventListener('click', (e) => {
      const w = e.target.closest('[data-water]');
      if (w) { e.stopPropagation(); S.space = w.dataset.water || null; store.set('space', S.space); render(); renderActivity(); return; }
      const z = e.target.closest('[data-zone]');
      if (z) { e.stopPropagation(); openZone(z.dataset.zone); return; }
      const r = e.target.closest('[data-role]');
      if (r) { e.stopPropagation(); openConsole(r.dataset.role); }
    });
  }

  // ---------- plain-language captain's log ----------
  function friendly(e) {
    const t = lastBoard && lastBoard.tasks.find((x) => x.id === e.task);
    const name = t ? `“${shortName(t)}”` : e.key;
    const crew = CREW_LABEL[crewOf(e.actor)] || e.actor || 'Crew';
    if (e.type === 'captain') return ['🧭', `You told the first mate${e.remote ? ' from your phone' : ''}: “${e.text}”`];
    if (e.type === 'moved') {
      if (e.to === 'dev') return ['⛵', `${crew} set sail on ${name}`];
      if (e.to === 'selected') return ['🪵', `${crew} is boarding ${name}`];
      if (e.to === 'review') return ['🗼', `${name} reached the lighthouse. Waiting for the lead's review.`];
      if (e.to === 'done') return ['⚓', `${name} docked in the fleet harbor!`];
      if (e.to === 'blocked') return ['🌩️', `${name} sailed into a storm${e.why ? ': ' + e.why : ''}`];
      return ['🔨', `${name} went back to the shipyard`];
    }
    if (e.type === 'created') return ['🔨', e.actor === 'lead' ? `The lead drew up plans for ${name}` : `The first mate queued ${name}`];
    if (e.type === 'message') return ['📜', `First mate sent orders to ${name}: ${e.text}`];
    if (e.type === 'status') {
      if (e.verb === 'done') return ['🎉', `${crew} finished ${name}${/pull\/\d+/.test(e.text) ? ' and opened a pull request' : ''}`];
      if (e.verb === 'blocked' || e.verb === 'paused') return ['🌩️', `${crew} is stuck on ${name}: ${e.text}`];
      if (e.verb === 'resolved') return ['🌤️', `${crew} got ${name} moving again`];
      return ['📣', `${crew} on ${name}: ${e.text}`];
    }
    return ['•', e.text];
  }

  // Live reactions on the scene: agents speak their status lines, orders arrive as scrolls.
  function onEvents(list) {
    if (!scene) return;
    for (const e of list) {
      const s = ships.get(e.task);
      if (e.type === 'status' && s) speak(s.el, `📣 ${e.text}`);
      else if (e.type === 'message' && s) speak(s.el, '📜 New orders from the first mate');
      else if (e.type === 'captain') { const f = scene.querySelector('.flagship'); if (f) bubble(f, '🧭 Orders received!'); }
    }
  }

  // Mobile browsers and screenshot tools fire resize without a size change; only relayout on a real one.
  let lastSize = `${window.innerWidth}x${window.innerHeight}`;
  function onResize() {
    const size = `${window.innerWidth}x${window.innerHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    if (S.view === 'harbor') { hideManifest(); render(); }
  }
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(onResize, 150); });

  return { update, friendly, onEvents, openZone, openConsole };
})();
