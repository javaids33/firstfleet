'use strict';
// Harbor mode: the fleet as ships. Backlog is the shipyard, dispatch is the slipway,
// development is open sea, blockers are storms, review is the lighthouse, merged is the harbor.
// Ships are persistent DOM nodes so a lane change becomes a visible voyage across the scene.

const Harbor = (() => {
  const ZONES = {
    backlog:  { x0: 0.012, x1: 0.118, y0: 0.31, y1: 0.97, label: 'Shipyard', icon: '🔨', blurb: 'plans waiting to be built' },
    selected: { x0: 0.125, x1: 0.205, y0: 0.31, y1: 0.97, label: 'Slipway', icon: '🪵', blurb: 'crew boarding' },
    blocked:  { x0: 0.25,  x1: 0.56,  y0: 0.30, y1: 0.45, label: 'Storm', icon: '🌩️', blurb: 'needs help' },
    dev:      { x0: 0.23,  x1: 0.585, y0: 0.49, y1: 0.97, label: 'Open sea', icon: '⛵', blurb: 'being built' },
    review:   { x0: 0.60,  x1: 0.755, y0: 0.42, y1: 0.97, label: 'Lighthouse', icon: '🗼', blurb: 'waiting for inspection' },
    done:     { x0: 0.775, x1: 0.99,  y0: 0.31, y1: 0.97, label: 'Fleet harbor', icon: '⚓', blurb: 'shipped' },
  };
  const SHIP_W = 104;
  const SHIP_H = 84;
  const ARRIVE = { selected: '🪵 Launching', dev: '⛵ Set sail!', blocked: '🌩️ Storm!', review: '🗼 Inspect me', done: '⚓ Docked!', backlog: '🔨 Back to yard' };

  let scene = null;
  let shipsEl = null;
  const ships = new Map(); // id -> { el, lane }
  let lastBoard = null;

  const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };
  const shortName = (t) => {
    let s = String(t.title || t.key).split(/[:(—–]/)[0].trim();
    if (s.length > 24) s = s.slice(0, 23).trimEnd() + '…';
    return s || t.key;
  };
  const crewName = (t) => CREW_LABEL[crewOf(t.actor && t.actor.harness)] || 'Crew';

  function shipSvg() {
    return `<svg viewBox="0 0 80 58" class="ship-svg" aria-hidden="true">
      <path class="wake" d="M2 47 Q14 43 26 47 T50 47" />
      <rect class="mast" x="39" y="5" width="2.4" height="35" rx="1" />
      <path class="flag" d="M40.5 5 L40.5 0.5 L50 2.8 Z" />
      <path class="sail main" d="M42.5 8 Q60 22 66 37 L42.5 37 Z" />
      <path class="sail jib" d="M38 12 Q26 26 19 37 L38 37 Z" />
      <path class="hull" d="M6 39 L75 39 Q71 48 63 52 L18 52 Q10 48 6 39 Z" />
      <path class="stripe" d="M9 42.5 L72 42.5" />
      <circle class="port" cx="26" cy="46.5" r="1.6" /><circle class="port" cx="40" cy="46.5" r="1.6" /><circle class="port" cx="54" cy="46.5" r="1.6" />
    </svg>`;
  }

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
      <div class="hud">
        <div class="headline"></div>
        <div class="waters"></div>
      </div>
      <div class="ships"></div>
      <div class="overflow"></div>
    </div>`;
    scene = el.querySelector('.harbor');
    shipsEl = scene.querySelector('.ships');
    ships.clear();
    scene.addEventListener('click', (e) => {
      const w = e.target.closest('[data-water]');
      if (w) { e.stopPropagation(); S.space = w.dataset.water || null; store.set('space', S.space); render(); renderActivity(); }
    });
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
      // Open sea fills from the lighthouse side, so older voyages sit closer to port.
      const fromRight = lane === 'dev' || lane === 'blocked' || lane === 'review';
      const c = i % cols, r = Math.floor(i / cols);
      const col = fromRight ? cols - 1 - c : c;
      const jx = lane === 'dev' || lane === 'blocked' ? (hash(t.id) - 0.5) * Math.min(dx * 0.5, 40) : 0;
      const jy = lane === 'dev' ? (hash(t.id + 'y') - 0.5) * Math.min(dy * 0.4, 20) : 0;
      pos.set(t.id, { x: x0 + col * dx + jx, y: y0 + r * dy + jy });
    });
    return { pos, hidden: list.length - shown.length, cap };
  }

  function laneOrder(lane) {
    return (a, b) => {
      if (lane === 'dev' || lane === 'blocked' || lane === 'review') return (a.firstAt || 0) - (b.firstAt || 0) || a.id.localeCompare(b.id);
      if (lane === 'done') return (b.lastAt || 0) - (a.lastAt || 0) || a.id.localeCompare(b.id);
      return laneSort(lane)(a, b);
    };
  }

  function update(el) {
    if (!S.board) return;
    if (!scene || !el.contains(scene)) build(el);
    lastBoard = S.board;
    const tasks = visibleTasks();
    const rect = scene.getBoundingClientRect();
    const by = {};
    for (const l of Object.keys(ZONES)) by[l] = tasks.filter((t) => t.lane === l).sort(laneOrder(l));

    const placed = new Map();
    const overflow = [];
    for (const lane of Object.keys(ZONES)) {
      const { pos, hidden } = layout(lane, by[lane], rect);
      for (const [id, p] of pos) placed.set(id, { ...p, lane });
      if (hidden > 0) {
        const z = ZONES[lane];
        overflow.push(`<div class="more-ships" style="left:${z.x1 * rect.width - SHIP_W}px;top:${z.y1 * rect.height - 30}px">+${hidden} more</div>`);
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
        div.innerHTML = `<div class="bob">${shipSvg()}</div><div class="bubble"></div><div class="plate"><b></b><span></span></div>`;
        div.style.transform = `translate(${p.x}px, ${p.y}px)`;
        shipsEl.appendChild(div);
        setTimeout(() => div.classList.remove('launching'), 900);
        s = { el: div, lane: p.lane };
        ships.set(id, s);
      } else if (s.lane !== p.lane) {
        voyage(s.el, ARRIVE[p.lane]);
        s.lane = p.lane;
      }
      s.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      s.el.style.zIndex = String(10 + Math.round(p.y));
      s.el.className = s.el.className.replace(/\b(crew|lane|agent)-\S+/g, '').trim() + ` crew-${crew} lane-${p.lane} agent-${agent || 'none'}`;
      s.el.title = `${t.title}\n${crewName(t)}${t.actor && t.actor.model ? ' · ' + t.actor.model : ''}\n${S.lanesById[t.lane]}: ${t.why || ''}`;
      s.el.querySelector('.plate b').textContent = shortName(t);
      s.el.querySelector('.plate span').textContent = p.lane === 'backlog' ? (t.unassigned ? 'plan' : 'queued') : `${crewName(t)}${t.pr ? ' · PR #' + t.pr.number : ''}`;
    }

    renderLabels(by, rect);
    renderHud(tasks);
  }

  function voyage(el, text) {
    el.classList.add('voyage');
    const b = el.querySelector('.bubble');
    b.textContent = text || '';
    b.classList.add('show');
    setTimeout(() => el.classList.remove('voyage'), 4200);
    setTimeout(() => b.classList.remove('show'), 6500);
  }

  function renderLabels(by, rect) {
    scene.querySelector('.zone-labels').innerHTML = Object.entries(ZONES).map(([lane, z]) => {
      const top = lane === 'blocked' ? z.y0 - 0.075 : lane === 'dev' ? z.y0 - 0.05 : 0.235;
      const left = lane === 'review' ? z.x0 + 0.005 : z.x0;
      return `<div class="zone-label zl-${lane}" title="${z.blurb}" style="left:${left * rect.width}px;top:${top * rect.height}px">
        <span class="zi">${z.icon}</span><b>${z.label}</b><span class="zn">${by[lane].length}</span></div>`;
    }).join('');
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
    scene.querySelector('.headline').innerHTML = `<div class="h1">${rowing ? `<span class="rowing"></span>${rowing} crewmate${rowing === 1 ? ' is' : 's are'} building <em>${esc(where)}</em>` : `The fleet is resting in <em>${esc(where)}</em>`}</div>
      <div class="h2">${bits.join(' · ')}</div>`;
    const repos = S.board.repos || [];
    scene.querySelector('.waters').innerHTML = [`<button data-water="" class="${!S.space ? 'on' : ''}">All waters</button>`,
      ...repos.map((r) => `<button data-water="${esc(r)}" class="${S.space === r ? 'on' : ''}">${esc(r)}</button>`)].join('');
  }

  // Plain-language captain's log lines.
  function friendly(e) {
    const t = lastBoard && lastBoard.tasks.find((x) => x.id === e.task);
    const name = t ? `“${shortName(t)}”` : e.key;
    const crew = CREW_LABEL[crewOf(e.actor)] || e.actor || 'Crew';
    if (e.type === 'moved') {
      if (e.to === 'dev') return ['⛵', `${crew} set sail on ${name}`];
      if (e.to === 'selected') return ['🪵', `${crew} is boarding ${name}`];
      if (e.to === 'review') return ['🗼', `${name} reached the lighthouse. Waiting for the lead's inspection.`];
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

  function onResize() { if (scene && document.body.contains(scene)) update(scene.parentElement); }
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(onResize, 120); });

  return { update, friendly, voyage: (id, text) => { const s = ships.get(id); if (s) voyage(s.el, text); } };
})();
