import { Chessground } from 'https://cdn.jsdelivr.net/npm/@lichess-org/chessground@10.4.2/dist/chessground.min.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const S = {}; // state of the review view

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || r.statusText);
  }
  return r.json();
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('sc.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sc.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = p => (p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
const turnOf = fen => (fen.split(' ')[1] === 'w' ? 'white' : 'black');
const moveLabel = p => `${p.move_number}${p.color === 'white' ? '.' : '...'}${p.san}`;

// SAN tokens inside free text, highlighted as moves (text nodes only: LLM output is never HTML).
const SAN_RE = /(\d+\.(?:\.\.)?\s?)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?|[a-h][1-8](?:=[QRBN])?)[+#]?[!?]*/g;
function richText(text) {
  const out = [];
  let last = 0;
  for (const m of (text || '').matchAll(SAN_RE)) {
    const before = text[m.index - 1];
    if (before && /[\w'’]/.test(before)) continue; // part of a word
    out.push(text.slice(last, m.index), el('span', { class: 'mv' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const JUDGEMENTS = {
  best: { label: 'Migliore', icon: '★' },
  excellent: { label: 'Ottima', icon: '!' },
  good: { label: 'Buona', icon: '✓' },
  inaccuracy: { label: 'Imprecisione', icon: '?!' },
  mistake: { label: 'Errore', icon: '?' },
  blunder: { label: 'Errore grave', icon: '??' },
};

const ROLES = {
  best: { label: 'Migliore', brush: 'best' },
  simple: { label: 'Più semplice', brush: 'simple' },
  tricky: { label: 'Più insidiosa', brush: 'tricky' },
};

const KINDS = {
  mistake: { icon: '✦', label: 'Errore da rivedere', short: 'errore' },
  choice: { icon: '◆', label: 'Scelta pratica', short: 'scelta' },
};

function tcLabel(tc) {
  if (!tc) return '';
  if (tc.includes('/')) return `${Math.round(+tc.split('/')[1] / 86400)} g/mossa`;
  const [base, inc] = tc.split('+').map(Number);
  const min = base >= 60 ? `${Math.round(base / 60)}` : `${base}s`;
  return inc ? `${min}|${inc}` : `${min} min`;
}

function whenLabel(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days <= 0) return 'oggi';
  if (days === 1) return 'ieri';
  if (days < 7) return `${days} giorni fa`;
  return new Date(ts * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

function spinner() {
  return el('span', { class: 'dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
}

// A soft wooden "tock" for moves, synthesised so no audio files are needed.
let audio;
function tock(san) {
  if (!store.get('sound', true)) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    const capture = san?.includes('x');
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(capture ? 520 : 360, t);
    osc.frequency.exponentialRampToValueAtTime(capture ? 170 : 130, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(capture ? 0.28 : 0.2, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  } catch { /* audio unavailable */ }
}

// ---------------------------------------------------------------- theme

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('theme', null));
$('#theme-toggle').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme(next);
});

// ---------------------------------------------------------------- router

let cleanup = () => {};
window.addEventListener('hashchange', route);
route();

function route() {
  cleanup();
  cleanup = () => {};
  const m = location.hash.match(/^#\/game\/(\w+)(?:\/(\d+))?/);
  if (m) renderReview(m[1], m[2] ? Number(m[2]) : 0);
  else renderHome();
}

// ---------------------------------------------------------------- home

async function renderHome() {
  const app = $('#app');
  const cfg = await api('/api/config').catch(() => ({}));
  let user = store.get('user', '') || cfg.username || '';
  let tc = store.get('tc', 'rapid');

  const input = el('input', { class: 'input', value: user, placeholder: 'username Chess.com', autocomplete: 'off', 'aria-label': 'Username Chess.com' });
  const list = el('div', { class: 'game-list' });
  const chips = el('div', { class: 'chips' });
  const TCS = [['rapid', 'Rapid'], ['blitz', 'Blitz'], ['bullet', 'Bullet'], ['daily', 'Daily'], ['', 'Tutte']];

  function drawChips() {
    chips.replaceChildren(...TCS.map(([v, label]) =>
      el('button', { class: 'chip' + (v === tc ? ' on' : ''), onclick: () => { tc = v; store.set('tc', v); drawChips(); load(); } }, label)));
  }

  async function load() {
    user = input.value.trim();
    store.set('user', user);
    if (!user) {
      list.replaceChildren(el('p', { class: 'muted' }, 'Scrivi il tuo username per vedere le partite.'));
      return;
    }
    list.replaceChildren(...[1, 2, 3, 4].map(() => el('div', { class: 'game-row skeleton' })));
    try {
      const games = await api(`/api/games?user=${encodeURIComponent(user)}&time_class=${tc}`);
      if (!games.length) {
        list.replaceChildren(el('p', { class: 'muted' }, 'Nessuna partita trovata con questo filtro.'));
        return;
      }
      list.replaceChildren(...games.map(gameRow));
    } catch (e) {
      list.replaceChildren(el('p', { class: 'error' }, e.message));
    }
  }

  const how = (role, title, text) => el('div', { class: `how ${role}` },
    el('span', { class: `pill ${role}` }, title), el('p', {}, text));

  drawChips();
  app.replaceChildren(
    el('section', { class: 'hero' },
      el('h1', {}, 'Le tue partite, spiegate con calma'),
      el('p', { class: 'muted' }, 'Rivediamo insieme gli errori e le scelte pratiche: per ogni momento chiave ti mostro tre strade.')),
    el('section', { class: 'how-grid' },
      how('best', 'Migliore', 'La mossa più forte secondo Stockfish.'),
      how('simple', 'Più semplice', 'Cede al massimo 0,6 pedoni alla migliore, ma è facile da portare avanti al tuo livello.'),
      how('tricky', 'Più insidiosa', "Cede al massimo 1 pedone, in cambio di più occasioni di errore per l'avversario.")),
    el('section', { class: 'card' },
      el('form', { class: 'user-form', onsubmit: e => { e.preventDefault(); load(); } },
        input, el('button', { class: 'btn primary', type: 'submit' }, 'Carica')),
      chips,
      list),
  );
  load();
}

function gameRow(g) {
  const result = { win: ['V', 'Vittoria'], loss: ['S', 'Sconfitta'], draw: ['=', 'Patta'] }[g.result];
  const r = g.review;
  const side = r
    ? [el('span', { class: 'tag ok' }, `precisione ${r.accuracy?.toFixed(1) ?? '–'}`),
      el('span', { class: 'muted small' },
        [r.mistakes ? `${KINDS.mistake.icon} ${r.mistakes}` : null, r.choices ? `${KINDS.choice.icon} ${r.choices}` : null].filter(Boolean).join('  ') || 'nessun momento critico')]
    : [el('span', { class: 'tag' }, 'da analizzare'), el('span', { class: 'muted small' }, `tu ${g.user_rating}`)];
  return el('a', { class: `game-row r-${g.result}`, href: `#/game/${g.id}` },
    el('span', { class: 'result-badge', title: result[1] }, result[0]),
    el('span', { class: 'game-main' },
      el('span', { class: 'game-title' },
        el('span', { class: `piece-dot ${g.user_color}`, title: g.user_color === 'white' ? 'giocavi col Bianco' : 'giocavi col Nero' }),
        'vs ', el('b', {}, g.opponent), el('span', { class: 'muted' }, ` (${g.opponent_rating})`)),
      el('span', { class: 'game-sub muted' }, [g.opening, tcLabel(g.time_control), whenLabel(g.end_time)].filter(Boolean).join(' · '))),
    el('span', { class: 'game-side' }, ...side),
  );
}

// ---------------------------------------------------------------- review state

function positionFen(i) {
  return i === 0 ? S.startFen : S.plies[i - 1].fen_after;
}

function currentFen() {
  const v = S.variation;
  if (!v) return positionFen(S.cur);
  return v.idx === 0 ? positionFen(v.base) : v.moves[v.idx - 1].fen;
}

function currentHistory() {
  const v = S.variation;
  const base = v ? v.base : S.cur;
  const moves = S.plies.slice(0, base).map(p => p.uci);
  if (v) moves.push(...v.moves.slice(0, v.idx).map(m => m.uci));
  return moves;
}

function lastMove() {
  const v = S.variation;
  if (v && v.idx > 0) {
    const m = v.moves[v.idx - 1];
    return [m.uci.slice(0, 2), m.uci.slice(2, 4)];
  }
  const i = v ? v.base : S.cur;
  if (i === 0) return undefined;
  const u = S.plies[i - 1].uci;
  return [u.slice(0, 2), u.slice(2, 4)];
}

function criticalAt(i) {
  return S.review?.critical?.[String(i)] || null;
}

function kindOf(p) {
  return p.critical ? (p.critical_kind || 'mistake') : null;
}

function moments() {
  return S.plies.filter(p => p.critical);
}

// Advice for the position on the board: a key moment of the review, or an
// on-demand analysis of any position (including variations).
function currentAdvice() {
  if (!S.variation) {
    const c = criticalAt(S.cur);
    if (c) return { ...c, critical: true };
  }
  return S.analyses.get(currentHistory().join(' ')) || null;
}

function dests(fen) {
  const chess = new Chess(fen);
  const map = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!map.has(m.from)) map.set(m.from, []);
    map.get(m.from).push(m.to);
  }
  return map;
}

// ---------------------------------------------------------------- review view

async function renderReview(id, startPly = 0) {
  const app = $('#app');
  Object.assign(S, {
    id, user: store.get('user', ''), review: null, cur: 0, variation: null, analyses: new Map(),
    job: null, posJob: null, narrJob: null, hint: null, sel: null, autoplay: null, alive: true,
  });
  cleanup = () => { S.alive = false; clearInterval(S.autoplay); };

  app.replaceChildren(el('div', { class: 'card loading' }, spinner(), ' Apro la partita…'));
  let game;
  try {
    game = await api(`/api/games/${id}?user=${encodeURIComponent(S.user)}`);
  } catch (e) {
    app.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error' }, e.message), el('a', { class: 'btn', href: '#/' }, '← Torna alle partite')));
    return;
  }
  S.meta = game.summary;
  S.user = S.meta.username || S.user;
  S.startFen = game.start_fen;
  S.plies = game.plies;
  S.orientation = S.meta.user_color;
  S.cur = Math.min(startPly, S.plies.length);
  buildLayout(app);

  try {
    setReview(await api(`/api/reviews/${id}`));
  } catch {
    runReviewJob();
  }
  update();
}

function setReview(review) {
  S.review = review;
  S.plies = review.plies;
  S.dom.summary.replaceChildren();
  buildMoveList();
  buildGraph();
}

async function pollJob(job, onTick) {
  while (S.alive && job.status !== 'done' && job.status !== 'error') {
    onTick(job);
    await sleep(job.kind === 'position' ? 1000 : 1500);
    job = await api(`/api/jobs/${job.id}`);
  }
  return job;
}

async function runReviewJob() {
  try {
    const job = await pollJob(await post(`/api/reviews/${S.id}?user=${encodeURIComponent(S.user)}`), j => { S.job = j; updateCoach(); });
    S.job = job;
    if (S.alive && job.status === 'done') setReview(job.result);
  } catch (e) {
    S.job = { status: 'error', error: e.message };
  }
  update();
}

async function runPositionJob() {
  const key = currentHistory().join(' ');
  const userTurn = turnOf(currentFen()) === S.meta.user_color;
  const body = {
    start_fen: S.startFen,
    moves: currentHistory(),
    user_elo: userTurn ? S.meta.user_maia_elo : S.meta.opp_maia_elo,
    opp_elo: userTurn ? S.meta.opp_maia_elo : S.meta.user_maia_elo,
  };
  try {
    const job = await pollJob(await post('/api/positions', body), j => { S.posJob = { key, job: j }; updateCoach(); });
    S.posJob = { key, job };
    if (job.status === 'done') S.analyses.set(key, job.result);
  } catch (e) {
    S.posJob = { key, job: { status: 'error', error: e.message } };
  }
  update();
}

async function runNarrationJob() {
  try {
    const job = await pollJob(await post(`/api/reviews/${S.id}/narrations`), j => { S.narrJob = j; updateCoach(); });
    S.narrJob = null;
    if (job.status === 'done') setReview(job.result);
  } catch (e) {
    S.narrJob = { status: 'error', error: e.message };
  }
  update();
}

function buildLayout(app) {
  S.dom = {};
  const d = S.dom;
  d.top = el('div', { class: 'player' });
  d.bottom = el('div', { class: 'player' });
  d.evalFill = el('div', { class: 'evalbar-fill' });
  d.evalLabel = el('span', { class: 'evalbar-label' });
  d.evalbar = el('div', { class: 'evalbar', title: 'Valutazione (Stockfish)' }, d.evalFill, d.evalLabel);
  d.cg = el('div', { class: 'cg-host' });
  d.legend = el('div', { class: 'legend' });
  d.coach = el('div', { class: 'coach', 'aria-live': 'polite' });
  d.summary = el('div', { class: 'summary' });
  d.counts = el('div', { class: 'counts-wrap' });
  d.momentChips = el('div', { class: 'moment-chips' });
  d.graph = el('div', { class: 'graph' });
  d.moves = el('div', { class: 'moves' });
  d.sound = el('button', { class: 'icon-btn', title: 'Suono delle mosse', 'aria-label': 'Suono delle mosse', onclick: toggleSound });
  const tab = (key, label) => el('button', { class: 'tab', role: 'tab', onclick: () => setTab(key) }, label);
  d.tabs = { coach: tab('coach', 'Allenatore'), moves: tab('moves', 'Mosse') };
  d.panes = {
    coach: el('div', { class: 'pane', role: 'tabpanel' }, d.coach),
    moves: el('div', { class: 'pane', role: 'tabpanel' }, d.counts, d.moves,
      el('p', { class: 'muted tiny keys' }, 'Tasti: ← → mosse · N/P momenti chiave · 1/2/3 proposte · F gira · Esc torna alla partita')),
  };
  d.panesBox = el('div', { class: 'panes' }, d.panes.coach, d.panes.moves);
  S.tab = store.get('tab', 'coach');

  const btn = (label, title, fn, cls = 'icon-btn') => el('button', { class: cls, title, 'aria-label': title, onclick: fn }, label);
  const controls = el('div', { class: 'controls' },
    el('div', { class: 'ctrl-group' },
      btn('⏮', 'Inizio (Home)', () => go(0)),
      btn('◀', 'Indietro (←)', () => step(-1)),
      btn('▶', 'Avanti (→)', () => step(1)),
      btn('⏭', 'Fine (End)', () => go(S.plies.length))),
    el('div', { class: 'ctrl-group' },
      btn('◀ Momento', 'Momento chiave precedente (P)', () => jumpMoment(-1), 'icon-btn wide'),
      btn('Momento ▶', 'Momento chiave successivo (N)', () => jumpMoment(1), 'icon-btn wide')),
    el('div', { class: 'ctrl-group' },
      btn('⇅', 'Gira la scacchiera (F)', flip),
      d.sound));

  const opening = [S.meta.opening, tcLabel(S.meta.time_control), whenLabel(S.meta.end_time)].filter(Boolean).join(' · ');
  app.replaceChildren(
    el('div', { class: 'review' },
      el('section', { class: 'board-col' },
        d.top,
        el('div', { class: 'board-wrap' }, d.evalbar, el('div', { class: 'board' }, d.cg)),
        d.bottom,
        controls,
        d.legend),
      el('section', { class: 'side-col card' },
        el('div', { class: 'side-head' },
          el('div', { class: 'side-top' },
            el('a', { class: 'back', href: '#/' }, '← partite'),
            S.meta.url ? el('a', { class: 'back', href: S.meta.url, target: '_blank', rel: 'noopener' }, 'su Chess.com ↗') : null),
          el('div', { class: 'side-title' },
            el('b', {}, `${S.user} vs ${S.meta.opponent}`),
            el('span', { class: 'muted small' }, opening)),
          d.summary,
          d.graph,
          d.momentChips),
        el('div', { class: 'tabs', role: 'tablist' }, d.tabs.coach, d.tabs.moves),
        d.panesBox)),
  );

  const faded = (key, color) => ({ key, color, opacity: 0.32, lineWidth: 8 });
  S.cg = Chessground(d.cg, {
    orientation: S.orientation,
    coordinates: true,
    animation: { enabled: true, duration: 180 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: onBoardMove } },
    premovable: { enabled: false },
    drawable: {
      enabled: true,
      visible: true,
      brushes: {
        best: { key: 'best', color: '#4f8a4a', opacity: 0.9, lineWidth: 12 },
        simple: { key: 'simple', color: '#3f7cac', opacity: 0.9, lineWidth: 12 },
        tricky: { key: 'tricky', color: '#d98a2b', opacity: 0.9, lineWidth: 12 },
        bestFaded: faded('bestFaded', '#4f8a4a'),
        simpleFaded: faded('simpleFaded', '#3f7cac'),
        trickyFaded: faded('trickyFaded', '#d98a2b'),
        played: { key: 'played', color: '#b9473f', opacity: 0.5, lineWidth: 8 },
        hint: { key: 'hint', color: '#4f8a4a', opacity: 0.6, lineWidth: 9 },
      },
    },
  });
  const onResize = () => S.cg.redrawAll();
  const onKey = e => {
    if (e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft') step(-1);
    else if (k === 'arrowright') step(1);
    else if (k === 'home') go(0);
    else if (k === 'end') go(S.plies.length);
    else if (k === 'f') flip();
    else if (k === 'n') jumpMoment(1);
    else if (k === 'p') jumpMoment(-1);
    else if (['1', '2', '3'].includes(k)) selectGroup(Number(k) - 1);
    else if (k === 'escape' && S.variation) go(S.variation.base);
    else return;
    e.preventDefault();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);
  const prev = cleanup;
  cleanup = () => { prev(); window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey); };
  updateSoundButton();
  updateTabs();
  buildMoveList();
}

function toggleSound() {
  store.set('sound', !store.get('sound', true));
  updateSoundButton();
}

function updateSoundButton() {
  S.dom.sound.textContent = store.get('sound', true) ? '🔈' : '🔇';
}

// ---------------------------------------------------------------- navigation

function stopAutoplay() {
  clearInterval(S.autoplay);
  S.autoplay = null;
}

function go(i, { silent = false } = {}) {
  stopAutoplay();
  const target = Math.max(0, Math.min(S.plies.length, i));
  if (!silent && !S.variation && Math.abs(target - S.cur) === 1) {
    tock(S.plies[Math.min(target, S.cur)]?.san);
  }
  S.variation = null;
  S.hint = null;
  S.sel = null;
  S.cur = target;
  update();
}

function step(delta) {
  stopAutoplay();
  const v = S.variation;
  if (v) {
    const idx = v.idx + delta;
    if (idx < 0) return go(v.base);
    if (idx > v.moves.length) return;
    v.idx = idx;
    if (delta > 0) tock(v.moves[idx - 1]?.san);
    S.hint = null;
    return update();
  }
  go(S.cur + delta);
}

function jumpMoment(dir) {
  const list = moments().map(p => p.ply);
  if (!list.length) return;
  const here = S.variation ? S.variation.base : S.cur;
  const target = dir > 0 ? list.find(p => p > here) : [...list].reverse().find(p => p < here);
  if (target === undefined) return;
  setTab('coach');
  go(target, { silent: true });
}

// Distinct candidate moves of a position: when "simple" or "tricky" is also the
// best move, the roles share one entry instead of repeating it.

function flip() {
  S.orientation = S.orientation === 'white' ? 'black' : 'white';
  S.cg.set({ orientation: S.orientation });
  update();
}

function onBoardMove(orig, dest) {
  stopAutoplay();
  const chess = new Chess(currentFen());
  let mv;
  try { mv = chess.move({ from: orig, to: dest, promotion: 'q' }); } catch { return update(); }
  const uci = mv.from + mv.to + (mv.promotion || '');
  tock(mv.san);
  // Playing the game's own next move just walks the main line.
  if (!S.variation && S.plies[S.cur]?.uci === uci) return go(S.cur + 1, { silent: true });
  if (!S.variation) S.variation = { base: S.cur, moves: [], idx: 0, label: 'La tua variante' };
  const v = S.variation;
  v.moves = v.moves.slice(0, v.idx);
  v.moves.push({ uci, san: mv.san, fen: chess.fen() });
  v.idx = v.moves.length;
  S.hint = null;
  S.sel = null;
  update();
}

function playLine(ucis, label, fromFen = null) {
  stopAutoplay();
  // Lines start from the position on the board, or (for "what happens after
  // your move") from the main-line position before it.
  const base = S.variation ? S.variation.base : S.cur;
  const startFen = fromFen || currentFen();
  const prefix = S.variation && !fromFen ? S.variation.moves.slice(0, S.variation.idx) : [];
  const chess = new Chess(startFen);
  const moves = [];
  for (const u of ucis) {
    try {
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      moves.push({ uci: u, san: mv.san, fen: chess.fen() });
    } catch { break; }
  }
  if (!moves.length) return;
  S.variation = { base, moves: prefix.concat(moves), idx: prefix.length, label };
  S.autoplay = setInterval(() => {
    const v = S.variation;
    if (!v || v.idx >= v.moves.length) return stopAutoplay();
    v.idx += 1;
    tock(v.moves[v.idx - 1].san);
    update();
  }, 850);
  update();
}

// ---------------------------------------------------------------- rendering

function update() {
  if (!S.cg) return;
  const fen = currentFen();
  const turn = turnOf(fen);
  const chess = new Chess(fen);
  S.cg.set({
    fen,
    turnColor: turn,
    lastMove: lastMove(),
    check: chess.inCheck() ? turn : false,
    movable: { color: turn, dests: dests(fen) },
  });
  drawShapes();
  updatePlayers();
  updateEvalbar();
  updateMoveList();
  updateGraph();
  updateSummary();
  updateMomentChips();
  updateCoach();
}

function drawShapes() {
  const out = [];
  const used = new Set();
  const advice = currentAdvice();
  if (advice) {
    const groups = adviceGroups(advice);
    const sel = S.sel ?? defaultGroup(groups, advice.kind);
    groups.forEach((g, i) => {
      const role = g.roles[0];
      out.push({ orig: g.c.uci.slice(0, 2), dest: g.c.uci.slice(2, 4), brush: i === sel ? ROLES[role].brush : `${ROLES[role].brush}Faded` });
      g.roles.forEach(r => used.add(r));
    });
    const played = advice.critical ? advice.facts.played?.uci : null;
    if (played && !groups.some(g => g.c.uci === played)) {
      out.push({ orig: played.slice(0, 2), dest: played.slice(2, 4), brush: 'played' });
      used.add('played');
    }
  }
  if (S.hint) {
    out.push({ orig: S.hint.slice(0, 2), dest: S.hint.slice(2, 4), brush: 'hint' });
    used.add('best');
  }
  S.cg.setAutoShapes(out);
  const labels = { best: 'Migliore', simple: 'Più semplice', tricky: 'Più insidiosa', played: 'La tua mossa' };
  S.dom.legend.replaceChildren(...[...used].map(r => el('span', {}, el('i', { class: `sw ${r}` }), labels[r])));
}

function updatePlayers() {
  const g = S.meta;
  const userColor = g.user_color;
  const oppColor = userColor === 'white' ? 'black' : 'white';
  const row = (color, name, rating, you) => [
    el('span', { class: `piece-dot ${color}` }), el('b', {}, name), el('span', { class: 'muted' }, `(${rating})`),
    you ? el('span', { class: 'tag' }, 'tu') : null,
  ].filter(Boolean);
  const user = row(userColor, S.user, g.user_rating, true);
  const opp = row(oppColor, g.opponent, g.opponent_rating, false);
  const userBottom = S.orientation === userColor;
  S.dom.bottom.replaceChildren(...(userBottom ? user : opp));
  S.dom.top.replaceChildren(...(userBottom ? opp : user));
}

function updateEvalbar() {
  const bar = S.dom.evalbar;
  bar.classList.toggle('flipped', S.orientation === 'black');
  bar.classList.toggle('stale', !!S.variation || !S.review);
  const i = S.variation ? S.variation.base : S.cur;
  const p = S.review && i > 0 ? S.plies[i - 1] : null;
  const win = p ? p.white_win : 50;
  S.dom.evalFill.style.height = `${win}%`;
  S.dom.evalLabel.textContent = p ? p.white_eval.replace('+', '') : '';
  S.dom.evalLabel.classList.toggle('on-white', win >= 50);
}

function buildMoveList() {
  if (!S.dom) return;
  const rows = [];
  S.moveEls = [];
  for (let i = 0; i < S.plies.length; i += 2) {
    const w = S.plies[i];
    const b = S.plies[i + 1];
    rows.push(el('div', { class: 'move-row' },
      el('span', { class: 'move-no' }, `${w.move_number}.`),
      moveCell(w), b ? moveCell(b) : el('span')));
  }
  S.dom.moves.replaceChildren(...rows);
}

function moveCell(p) {
  const j = p.judgement && JUDGEMENTS[p.judgement];
  const showIcon = j && ['best', 'inaccuracy', 'mistake', 'blunder'].includes(p.judgement);
  const kind = kindOf(p);
  const cell = el('button', {
    class: `move j-${p.judgement || 'none'}${kind ? ` critical k-${kind}` : ''}`,
    title: j ? j.label : null,
    onclick: () => go(p.ply + 1, { silent: true }),
  },
  el('span', { class: 'san' }, p.san),
  showIcon ? el('span', { class: 'j-icon' }, j.icon) : null,
  kind ? el('span', { class: 'crit', title: KINDS[kind].label }, KINDS[kind].icon) : null);
  S.moveEls[p.ply] = cell;
  return cell;
}

function updateMoveList() {
  const active = S.variation ? S.variation.base - 1 : S.cur - 1;
  S.moveEls?.forEach((cell, i) => cell.classList.toggle('active', i === active));
  const cell = S.moveEls?.[active];
  if (cell && S.tab === 'moves') {
    const box = S.dom.panesBox;
    const top = cell.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - box.clientHeight / 2;
  }
}

function buildGraph() {
  const n = S.plies.length;
  if (!S.review || !n) return;
  const W = 600, H = 80;
  const y = p => H - (p.white_win / 100) * H;
  const pts = [[0, H / 2], ...S.plies.map((p, i) => [((i + 1) / n) * W, y(p)])];
  const area = `M0,${H} ` + pts.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(' ') + ` L${W},${H} Z`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Andamento della valutazione: clicca per saltare a una mossa');
  // Key moments are drawn at the position before the user's move (x = ply).
  svg.innerHTML = `<rect class="g-black" width="${W}" height="${H}"/><path class="g-white" d="${area}"/>`
    + `<line class="g-mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>`
    + moments().map(p => {
      const prev = p.ply > 0 ? S.plies[p.ply - 1] : { white_win: 50 };
      return `<circle class="g-crit k-${kindOf(p)}" cx="${(p.ply / n) * W}" cy="${y(prev)}" r="4.5"/>`;
    }).join('')
    + `<line class="g-cursor" x1="0" y1="0" x2="0" y2="${H}"/>`;
  S.dom.graphCard.hidden = false;
  svg.addEventListener('click', e => {
    const r = svg.getBoundingClientRect();
    go(Math.round(((e.clientX - r.left) / r.width) * n), { silent: true });
  });
  S.dom.graph.replaceChildren(svg);
}

function updateGraph() {
  const line = S.dom.graph.querySelector('.g-cursor');
  if (!line) return;
  const i = S.variation ? S.variation.base : S.cur;
  const x = (i / S.plies.length) * 600;
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
}

function updateSummary() {
  const r = S.review;
  if (!r) { S.dom.summary.replaceChildren(); S.dom.counts.replaceChildren(); return; }
  if (S.dom.summary.childElementCount) return;
  const userColor = r.game.user_color;
  const oppColor = userColor === 'white' ? 'black' : 'white';
  const acc = c => (r.accuracy[c] == null ? '–' : r.accuracy[c].toFixed(1));
  const counts = color => {
    const c = {};
    for (const p of r.plies) if (p.color === color) c[p.judgement] = (c[p.judgement] || 0) + 1;
    return c;
  };
  const cu = counts(userColor), co = counts(oppColor);
  S.dom.summary.replaceChildren(
    el('div', { class: 'accuracy' },
      el('span', { class: 'acc' }, el('span', { class: 'acc-num' }, acc(userColor)), el('span', { class: 'muted small' }, 'la tua precisione')),
      el('span', { class: 'acc' }, el('span', { class: 'acc-num soft' }, acc(oppColor)), el('span', { class: 'muted small' }, S.meta.opponent))));
  S.dom.counts.replaceChildren(
    el('div', { class: 'counts' },
      el('div', { class: 'count-row head muted' }, el('span', { class: 'n' }, 'tu'), el('span'), el('span'), el('span', { class: 'n' }, 'avv.')),
      ...Object.entries(JUDGEMENTS).map(([k, j]) => el('div', { class: `count-row j-${k}` },
        el('span', { class: 'n' }, cu[k] || 0),
        el('span', { class: 'j-icon' }, j.icon), el('span', { class: 'lbl' }, j.label),
        el('span', { class: 'n soft' }, co[k] || 0)))));
}

function updateMomentChips() {
  const list = moments();
  if (!S.review) { S.dom.momentChips.replaceChildren(); return; }
  if (!list.length) {
    S.dom.momentChips.replaceChildren(el('p', { class: 'muted small' }, 'Nessun momento critico: partita pulita!'));
    return;
  }
  const here = S.variation ? null : S.cur;
  S.dom.momentChips.replaceChildren(
    el('div', { class: 'chips scroll' }, ...list.map(p => {
      const k = kindOf(p);
      return el('button', {
        class: `chip moment k-${k}${here === p.ply ? ' on' : ''}`,
        title: KINDS[k].label,
        onclick: () => { setTab('coach'); go(p.ply, { silent: true }); },
      }, `${KINDS[k].icon} ${moveLabel(p)}`);
    })));
  S.dom.momentChips.querySelector('.chip.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// One candidate at a time: a selector with the distinct moves, and the card of the
// selected one. Three stacked cards pushed everything off screen.

// ---------------------------------------------------------------- coach

function updateCoach() {
  const c = S.dom.coach;
  if (!S.review) {
    c.replaceChildren(...reviewProgress());
    return;
  }
  const parts = [];
  if (S.variation) parts.push(variationBanner());
  const advice = currentAdvice();
  if (advice?.critical) parts.push(...criticalView(advice));
  else if (advice) parts.push(...optionsView(advice));
  else if (!S.variation && S.cur === 0) parts.push(...introView());
  else {
    parts.push(...moveInfo());
    parts.push(analyseButton());
  }
  c.replaceChildren(...parts);
}

function coachHead(title, sub, cls = '') {
  return el('div', { class: `coach-head ${cls}` },
    el('span', { class: 'coach-avatar', 'aria-hidden': 'true' }, '♞'),
    el('div', {}, el('h3', {}, title), sub ? el('span', { class: 'muted small' }, sub) : null));
}

function progressBar(fraction, message) {
  return el('div', { class: 'progress' },
    el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: `width:${Math.max(3, Math.round(fraction * 100))}%` })),
    el('span', { class: 'muted small' }, spinner(), ' ', message));
}

function reviewProgress() {
  const job = S.job;
  if (job?.status === 'error') {
    return [coachHead('Qualcosa è andato storto'), el('p', { class: 'error' }, job.error || 'Errore'),
      el('button', { class: 'btn', onclick: () => { S.job = null; runReviewJob(); } }, 'Riprova')];
  }
  const msg = job?.message || 'In coda';
  const f = job?.fraction || 0;
  const stage = msg.startsWith('Scrivo') ? 2 : msg.startsWith('Analizzo') ? 1 : msg.startsWith('Valuto') ? 0 : -1;
  const steps = ['Valuto tutte le mosse', 'Analizzo i momenti chiave', 'Scrivo le spiegazioni'];
  let eta = 'Ci vogliono pochi minuti';
  if (f > 0.05 && job?.elapsed) {
    const left = (job.elapsed / f) * (1 - f);
    eta = left > 90 ? `Ancora circa ${Math.round(left / 60)} minuti` : left > 30 ? 'Ancora un minuto o poco più' : 'Quasi fatto';
  }
  return [
    coachHead('Sto studiando la tua partita', eta),
    el('ol', { class: 'steps' }, ...steps.map((s, i) =>
      el('li', { class: i < stage ? 'done' : i === stage ? 'now' : '' }, el('span', { class: 'step-dot' }, i < stage ? '✓' : i + 1), s))),
    progressBar(f, msg),
    el('p', { class: 'muted small' }, 'Intanto puoi scorrere le mosse e muovere i pezzi sulla scacchiera.'),
  ];
}

function variationBanner() {
  const v = S.variation;
  const sans = v.moves.map((m, i) => el('button', {
    class: 'var-move' + (i === v.idx - 1 ? ' active' : ''),
    onclick: () => { stopAutoplay(); v.idx = i + 1; update(); },
  }, m.san));
  return el('div', { class: 'variation' },
    el('div', { class: 'var-head' }, el('b', {}, v.label || 'Variante'),
      el('button', { class: 'btn small', onclick: () => go(v.base, { silent: true }) }, '↩ Torna alla partita')),
    el('div', { class: 'var-moves' }, ...sans));
}

function introView() {
  const list = moments();
  const nm = list.filter(p => kindOf(p) === 'mistake').length;
  const nc = list.filter(p => kindOf(p) === 'choice').length;
  const parts = [];
  if (nm) parts.push(`${nm} ${nm === 1 ? 'errore da rivedere' : 'errori da rivedere'}`);
  if (nc) parts.push(`${nc} ${nc === 1 ? 'scelta pratica' : 'scelte pratiche'}`);
  return [
    coachHead('Pronti a ripassare?', 'Usa ← → oppure N per il prossimo momento chiave'),
    el('p', {}, list.length ? `Ho trovato ${parts.join(' e ')}.` : 'Nessun momento critico: partita pulita!'),
    list.length ? el('div', { class: 'moment-list' }, ...list.map(p => {
      const k = kindOf(p);
      const j = JUDGEMENTS[p.judgement];
      const c = criticalAt(p.ply);
      const note = k === 'mistake' ? `${j?.label || ''} · serviva ${c?.facts.best.san || p.best_san}` : alternativesNote(c);
      return el('button', { class: `moment-row k-${k}`, onclick: () => go(p.ply, { silent: true }) },
        el('span', { class: 'moment-icon' }, KINDS[k].icon),
        el('span', { class: 'mv' }, moveLabel(p)),
        el('span', { class: 'muted small' }, note));
    })) : null,
    list.length ? el('button', { class: 'btn primary', onclick: () => jumpMoment(1) }, 'Inizia dal primo momento ▶') : null,
  ];
}

function alternativesNote(c) {
  if (!c) return '';
  const f = c.facts;
  const notes = [];
  if (!f.same?.simple_is_best) notes.push(`più semplice ${f.simple.san}`);
  if (!f.same?.tricky_is_best) notes.push(`più insidiosa ${f.tricky.san}`);
  return notes.join(' · ');
}

function moveInfo() {
  if (S.variation) return [coachHead('Esplora', 'Muovi i pezzi per provare altre idee')];
  const i = S.cur;
  const p = S.plies[i - 1];
  const j = JUDGEMENTS[p.judgement] || { label: '', icon: '' };
  const mine = p.color === S.meta.user_color;
  const who = mine ? 'Hai giocato' : `${S.meta.opponent} ha giocato`;
  const out = [coachHead(`${who} ${moveLabel(p)}`, null),
    el('div', { class: 'verdict' },
      el('span', { class: `badge j-${p.judgement}` }, el('span', { class: 'j-icon' }, j.icon), j.label),
      el('span', { class: 'muted small' }, `valutazione ${p.white_eval} (Bianco)`))];
  if (p.uci !== p.best_uci && ['inaccuracy', 'mistake', 'blunder'].includes(p.judgement)) {
    out.push(el('p', {}, 'Meglio era ', el('span', { class: 'mv' }, p.best_san), '. ',
      el('button', { class: 'link', onclick: () => { go(i - 1, { silent: true }); S.hint = p.best_uci; drawShapes(); } }, 'Mostramela')));
  }
  if (p.critical) {
    const k = kindOf(p);
    out.push(el('button', { class: `btn soft k-${k}`, onclick: () => { setTab('coach'); go(i - 1, { silent: true }); } }, `${KINDS[k].icon} Rivedi questo momento`));
  }
  return out;
}

function analyseButton() {
  const key = currentHistory().join(' ');
  const pj = S.posJob?.key === key ? S.posJob.job : null;
  if (pj && pj.status !== 'done' && pj.status !== 'error') {
    return progressBar(pj.fraction || 0, pj.message || 'In coda');
  }
  const fen = currentFen();
  if (new Chess(fen).isGameOver()) return el('p', { class: 'muted small' }, 'Partita finita.');
  const side = turnOf(fen) === S.meta.user_color ? 'te' : S.meta.opponent;
  return el('div', { class: 'analyse' },
    pj?.status === 'error' ? el('p', { class: 'error small' }, pj.error) : null,
    el('button', { class: 'btn soft', onclick: runPositionJob }, `Analizza questa posizione`),
    el('span', { class: 'muted small' }, `muove ${side} · circa 15 secondi`));
}

function stat(label, value, title) {
  return el('span', { class: 'stat', title }, el('span', { class: 'muted' }, label), el('b', {}, value));
}

function playedLineAction(f) {
  const line = f.played?.line?.uci;
  if (!line?.length) return null;
  const fen = currentFen();
  return () => playLine(line, `Dopo la tua ${f.played.move}`, fen);
}

function criticalView(advice) {
  const f = advice.facts;
  const n = advice.narration || {};
  const kind = advice.kind || 'mistake';
  const p = S.plies[S.cur];
  const j = JUDGEMENTS[p.judgement] || { label: '' };
  const out = [coachHead(`${KINDS[kind].icon} ${KINDS[kind].label}`, `Mossa ${moveLabel(p)}`, `k-${kind}`)];
  out.push(el('div', { class: 'compare' },
    el('div', { class: 'cmp played' }, el('span', { class: 'muted small' }, 'hai giocato'),
      el('span', {}, el('b', { class: 'mv' }, f.played.move), ' ', el('span', { class: `badge j-${p.judgement}` }, j.label)),
      el('span', { class: 'small' }, `${f.played.eval} per te`)),
    el('div', { class: 'cmp best' }, el('span', { class: 'muted small' }, 'la migliore'),
      el('b', { class: 'mv' }, f.best.move), el('span', { class: 'small' }, `${f.best.eval} per te`))));
  const roles = f.played.roles || [];
  if (kind === 'choice' && roles.length && !roles.includes('best')) {
    out.push(el('p', { class: 'praise' }, `Bella scelta: era proprio la ${roles.map(r => ROLES[r].label.toLowerCase()).join(' e la ')}.`));
  }
  if (n.summary) out.push(el('p', { class: 'summary-text' }, ...richText(n.summary)));
  if (f.same?.only_one_candidate) {
    out.push(el('p', { class: 'muted small' }, "Qui c'era una sola mossa buona: niente alternative entro il margine."));
  }
  out.push(...optionsSection(advice, { playedLine: kind === 'mistake' ? playedLineAction(f) : null }));
  out.push(narrationFooter(n));
  return out;
}

function optionsView(advice) {
  const f = advice.facts;
  const n = advice.narration || {};
  const out = [coachHead('Le tue opzioni', `Muove il ${f.side} · Elo ${f.user_elo} contro ${f.opponent_elo}`)];
  if (n.summary) out.push(el('p', { class: 'summary-text' }, ...richText(n.summary)));
  if (f.same?.only_one_candidate) out.push(el('p', { class: 'muted small' }, "Qui c'è una sola mossa buona."));
  out.push(...optionsSection(advice));
  out.push(narrationFooter(n, false));
  return out;
}

function narrationFooter(n, canRegenerate = true) {
  const nj = S.narrJob;
  const source = n.source === 'template' ? 'Spiegazioni automatiche (LLM non disponibile)'
    : n.source ? `Spiegazioni di ${n.source} sui dati di Stockfish e Maia` : '';
  return el('div', { class: 'footnote muted tiny' },
    source,
    canRegenerate && nj && nj.status !== 'error'
      ? el('span', {}, ' · ', spinner(), ` ${nj.message || 'riscrivo…'}`)
      : canRegenerate ? el('button', { class: 'link tiny', onclick: runNarrationJob }, ' · riscrivi le spiegazioni') : null,
    nj?.status === 'error' ? el('span', { class: 'error' }, ` ${nj.error}`) : null);
}

function setTab(key) {
  S.tab = key;
  store.set('tab', key);
  updateTabs();
  if (key === 'moves') updateMoveList();
}

function updateTabs() {
  for (const k of ['coach', 'moves']) {
    S.dom.tabs[k].classList.toggle('on', S.tab === k);
    S.dom.tabs[k].setAttribute('aria-selected', String(S.tab === k));
    S.dom.panes[k].hidden = S.tab !== k;
  }
}

function roleGroups(f) {
  const groups = [];
  for (const role of ['best', 'simple', 'tricky']) {
    const c = f[role];
    if (!c) continue;
    const g = groups.find(x => x.c.uci === c.uci);
    if (g) g.roles.push(role);
    else groups.push({ c, roles: [role] });
  }
  return groups;
}

function adviceGroups(advice) {
  const f = advice.facts;
  return roleGroups(f.same?.only_one_candidate ? { best: f.best } : f);
}

// For a practical choice open on the alternative (that is the point of the
// moment); for a mistake open on the best move.

function defaultGroup(groups, kind) {
  if (kind === 'choice' && groups.length > 1) return 1;
  return 0;
}

function selectGroup(i) {
  const advice = currentAdvice();
  if (!advice) return;
  if (i < 0 || i >= adviceGroups(advice).length) return;
  S.sel = i;
  drawShapes();
  updateCoach();
}

function optionsSection(advice, { playedLine = null } = {}) {
  const groups = adviceGroups(advice);
  const n = advice.narration || {};
  if (S.sel == null || S.sel >= groups.length) S.sel = defaultGroup(groups, advice.kind);
  const out = [];
  if (groups.length > 1) {
    out.push(el('div', { class: 'role-tabs', role: 'tablist' }, ...groups.map((g, i) =>
      el('button', {
        class: `role-tab ${g.roles[0]}${i === S.sel ? ' on' : ''}`,
        role: 'tab',
        'aria-selected': String(i === S.sel),
        title: `Tasto ${i + 1}`,
        onclick: () => selectGroup(i),
      },
      el('span', { class: 'role-names' }, g.roles.map(r => ROLES[r].label).join(' · ')),
      el('span', { class: 'role-move' }, el('b', { class: 'mv' }, g.c.san), el('span', { class: 'muted' }, ` ${g.c.eval}`))))));
  }
  out.push(groupCard(groups[S.sel], n, playedLine));
  return out;
}

function groupCard({ c, roles }, n, playedLine) {
  const [primary, ...others] = roles;
  const traps = roles.includes('tricky') ? c.traps : null;
  return el('div', { class: `advice ${primary}` },
    el('div', { class: 'advice-head' },
      ...roles.map(r => el('span', { class: `pill ${r}` }, ROLES[r].label)),
      el('b', { class: 'mv' }, c.move),
      el('span', { class: 'eval', title: 'Valutazione dal tuo punto di vista' }, c.eval, el('small', {}, ' per te'))),
    n[primary] ? el('p', {}, ...richText(n[primary])) : null,
    ...others.map(r => (n[r] ? el('p', { class: 'secondary' }, ...richText(n[r])) : null)),
    el('div', { class: 'stats' },
      stat('al tuo livello', c.at_your_level, 'Valutazione attesa se continui a giocare al tuo livello'),
      stat('contro un umano', c.vs_human, 'Valutazione attesa contro un avversario reale del suo livello'),
      stat('naturale', pct(c.naturalness), 'Quanti giocatori del tuo livello la sceglierebbero'),
      c.opponent_error_prob > 0 ? stat('errore avv.', pct(c.opponent_error_prob), "Probabilità che l'avversario risponda con un errore") : null),
    el('div', { class: 'advice-actions' },
      el('button', { class: 'link', onclick: () => playLine(c.line.uci, `${ROLES[primary].label}: ${c.move}`) }, '▶ Guarda la linea'),
      traps?.[0]?.punishment_uci
        ? el('button', { class: 'link', onclick: () => playLine([c.uci, traps[0].reply_uci, traps[0].punishment_uci], `Trappola: ${c.move}`) }, '⚑ Guarda la trappola')
        : null,
      playedLine && primary === 'best'
        ? el('button', { class: 'link warn', onclick: playedLine }, '↯ Cosa succedeva dopo la tua mossa')
        : null));
}
