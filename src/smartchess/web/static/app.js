import { Chessground } from './dist/chessground.js';
import { Chess } from './dist/chess.js';

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

// "browser" mode (the public site): there is no server. Games come straight from
// Chess.com or Lichess, and Stockfish and Maia run in this page's own workers
// (static/dist, built by `npm run build`). "server" mode talks to the Python API.
const BROWSER = document.querySelector('meta[name="smartchess-mode"]')?.content === 'browser';
// The explanation proxy (infra/app, llm_lambda.py): without it the browser version has only template explanations.
const LLM_URL = document.querySelector('meta[name="smartchess-llm"]')?.content || '';

let backend = null;
async function browserBackend() {
  if (!backend) {
    const { createBackend } = await import('./dist/backend.js');
    backend = createBackend({ base: new URL('./dist/', import.meta.url), demosUrl: new URL('./demos.json', import.meta.url), llmUrl: LLM_URL });
  }
  return backend;
}

async function api(path, opts) {
  if (BROWSER) return (await browserBackend()).api(path, opts);
  const r = await fetch(path, opts);
  // The session ended (password changed or cookie gone): back to the sign-in page.
  if (r.status === 401) location.href = '/login';
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.detail || r.statusText), { status: r.status });
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

// Move classifications. At key moments a move that is one of the three options
// is judged "simple" or "tricky" by the backend, never as an inaccuracy.
const JUDGEMENTS = {
  best: { label: 'Best', phrase: 'is the best move' },
  simple: { label: 'Simplest', phrase: 'is the simplest move' },
  tricky: { label: 'Trickiest', phrase: 'is the trickiest move' },
  excellent: { label: 'Excellent', phrase: 'is excellent' },
  good: { label: 'Good', phrase: 'is good' },
  inaccuracy: { label: 'Inaccuracy', phrase: 'is an inaccuracy' },
  mistake: { label: 'Mistake', phrase: 'is a mistake' },
  blunder: { label: 'Blunder', phrase: 'is a blunder' },
};

// Chess.com-style badges: a colored disc with a white glyph (star, shield for the
// simplest move, bolt for the trickiest, check, or punctuation).
const GLYPHS = {
  best: '<path d="M10 3.8l1.53 4.1 4.37.18-3.43 2.72 1.17 4.22L10 12.6l-3.64 2.42 1.17-4.22-3.43-2.72 4.37-.18z"/>',
  simple: '<path d="M10 3.7l5.3 2v4c0 3.3-2.2 5.6-5.3 6.6-3.1-1-5.3-3.3-5.3-6.6v-4z"/>',
  tricky: '<path d="M11.4 3.4L5.6 11.1h3.7l-1 5.5 6.1-7.9h-3.9z"/>',
  good: '<path class="stroke" d="M5.7 10.3l2.9 2.9 5.7-6.2"/>',
};
const MARKS = { excellent: '!', inaccuracy: '?!', mistake: '?', blunder: '??' };

function jIcon(key, cls = '') {
  const e = el('span', { class: `j-icon j-${key} ${cls}`, title: JUDGEMENTS[key]?.label });
  const mark = MARKS[key];
  const glyph = GLYPHS[key]
    || `<text x="10" y="${mark.length > 1 ? 13.6 : 14.4}" font-size="${mark.length > 1 ? 9.5 : 12.5}">${mark}</text>`;
  e.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/>${glyph}</svg>`;
  return e;
}

const ROLES = {
  best: { label: 'Best', brush: 'best' },
  simple: { label: 'Simplest', brush: 'simple' },
  tricky: { label: 'Trickiest', brush: 'tricky' },
};

// Facts written before the switch to English say "bianco"/"nero".
const SIDES = { white: 'White', black: 'Black', bianco: 'White', nero: 'Black' };

const KINDS = {
  mistake: { icon: '✦', label: 'Mistake to review', short: 'mistake' },
  choice: { icon: '◆', label: 'Practical choice', short: 'choice' },
};

function tcLabel(tc) {
  if (!tc) return '';
  if (tc.includes('/')) return `${Math.round(+tc.split('/')[1] / 86400)} d/move`;
  const [base, inc] = tc.split('+').map(Number);
  const min = base >= 60 ? `${Math.round(base / 60)}` : `${base}s`;
  return inc ? `${min}|${inc}` : `${min} min`;
}

function whenLabel(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
  // The review fills the window: the footer would only get in the way.
  document.body.classList.toggle('in-review', /^#\/game\//.test(location.hash));
  $('#app').classList.remove('home');
  const m = location.hash.match(/^#\/game\/(\w+)(?:\/(\d+))?/);
  if (m) renderReview(m[1], m[2] ? Number(m[2]) : 0);
  else if (location.hash === '#/about') renderAbout();
  else renderHome();
}

// ---------------------------------------------------------------- about

const REPO = 'https://github.com/Tommaiberone/SmartChess';

function renderAbout() {
  const app = $('#app');
  const section = (title, ...kids) => el('section', { class: 'card about' }, el('h2', {}, title), ...kids);
  const ext = (href, label) => el('a', { href, target: '_blank', rel: 'noopener' }, label);
  const clear = async () => {
    if (!confirm('Delete the reviews and games saved in this browser?')) return;
    try { localStorage.clear(); } catch { /* blocked */ }
    try { indexedDB.deleteDatabase('smartchess'); await caches.delete('smartchess-models-v1'); } catch { /* nothing saved */ }
    location.hash = '#/';
    location.reload();
  };
  app.replaceChildren(
    el('section', { class: 'hero' }, el('h1', {}, 'About SmartChess'),
      el('p', { class: 'muted' }, 'A game review that asks what a player like you can actually play, not only what a computer would.')),
    section('How it works',
      el('p', {}, 'For each key moment of your game you get three moves. ', el('b', {}, 'Best'), ' is what Stockfish plays. ',
        el('b', {}, 'Simplest'), ' is the move, within 0.6 pawns of the best, that you can keep up at your own level. ',
        el('b', {}, 'Trickiest'), ' is the move, within 1 pawn, that scores best against a real opponent of their level.'),
      el('p', {}, 'Stockfish is the objective judge. Maia-3, a neural network trained on millions of human games, predicts which moves players of a given rating actually play. A search combines the two, and every explanation is written from those numbers.'),
      el('p', { class: 'muted small' }, 'This is a beta. The rating conversion from Chess.com to the Maia scale is approximate, and results come from a light version of the engines (Stockfish 19 lite, Maia-3 5M) so that they run in your browser.')),
    section('Privacy',
      el('p', {}, 'There is no account, no tracking and no cookie. The analysis runs on your device, in your browser: your games are downloaded from Chess.com or Lichess by your own browser and are never sent to this site or anywhere else.'),
      el('p', {}, 'Reviews are saved only in this browser, so you do not wait twice. The first visit downloads about 37 MB of engine files, which are then cached.'),
      LLM_URL ? el('p', {}, 'The one exception is optional: if you press "rewrite with AI" under a review, the facts of each key moment (the position, the moves, the evaluations; no names, no account) are sent to a small proxy of this site and from there to Groq, which writes the explanations in prose. Nothing is sent unless you press it.') : null,
      el('button', { class: 'btn small', onclick: clear }, 'Delete everything saved in this browser')),
    section('Open source',
      el('p', {}, 'SmartChess is free software under the ', ext('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU AGPL v3'), ': ',
        ext(REPO, 'source code'), '. It is built on ', ext('https://stockfishchess.org', 'Stockfish'), ' (GPL-3.0, WebAssembly build by ',
        ext('https://github.com/nmrugg/stockfish.js', 'stockfish.js'), '), ', ext('https://github.com/CSSLab/maia3', 'Maia-3'),
        ' (AGPL-3.0), ', ext('https://github.com/lichess-org/chessops', 'chessops'), ', ', ext('https://github.com/lichess-org/chessground', 'Chessground'),
        ' and ', ext('https://onnxruntime.ai', 'ONNX Runtime Web'), '.'),
      el('p', { class: 'muted small' }, 'Not affiliated with Chess.com or Lichess.')),
    el('p', {}, el('a', { class: 'btn', href: '#/' }, '← Back to games')),
  );
}

// ---------------------------------------------------------------- home

async function renderHome() {
  const app = $('#app');
  const cfg = await api('/api/config').catch(() => ({}));
  let user = store.get('user', '') || cfg.username || '';
  let tc = store.get('tc', 'rapid');
  let source = store.get('source', 'chess.com');

  const input = el('input', { class: 'input', value: user, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const list = el('div', { class: 'game-list' });
  const chips = el('div', { class: 'chips' });
  const sources = el('div', { class: 'chips sources' });
  const TCS = [['rapid', 'Rapid'], ['blitz', 'Blitz'], ['bullet', 'Bullet'], ['daily', 'Daily'], ['', 'All']];
  const SOURCES = [['chess.com', 'Chess.com'], ['lichess', 'Lichess']];

  function drawChips() {
    chips.replaceChildren(...TCS.map(([v, label]) =>
      el('button', { class: 'chip' + (v === tc ? ' on' : ''), type: 'button', onclick: () => { tc = v; store.set('tc', v); drawChips(); load(); } }, label)));
    sources.replaceChildren(...SOURCES.map(([v, label]) =>
      el('button', { class: 'chip' + (v === source ? ' on' : ''), type: 'button', onclick: () => { source = v; store.set('source', v); drawChips(); load(); } }, label)));
    const label = `${source === 'lichess' ? 'Lichess' : 'Chess.com'} username`;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
  }

  async function load() {
    user = input.value.trim();
    store.set('user', user);
    // The public site has demo games to show before anyone types a name.
    if (!user && !BROWSER) {
      list.replaceChildren(el('p', { class: 'muted' }, 'Enter your username to see your games.'));
      return;
    }
    list.replaceChildren(...[1, 2, 3, 4].map(() => el('div', { class: 'game-row skeleton' })));
    try {
      const games = await api(`/api/games?user=${encodeURIComponent(user)}&time_class=${tc}&source=${encodeURIComponent(source)}`);
      if (!games.length) {
        list.replaceChildren(el('p', { class: 'muted' }, 'No games found with this filter.'));
        return;
      }
      const rows = games.map(gameRow);
      if (!user) rows.push(el('p', { class: 'muted small' }, 'Enter your username above to review your own games.'));
      list.replaceChildren(...rows);
    } catch (e) {
      list.replaceChildren(el('p', { class: 'error' }, e.message));
    }
  }

  const how = (role, title, text) => el('div', { class: `how ${role}` },
    el('span', { class: `pill ${role}` }, title), el('p', {}, text));

  drawChips();
  const form = el('form', { class: 'user-form', onsubmit: e => { e.preventDefault(); load(); } },
    input, el('button', { class: 'btn primary', type: 'submit' }, 'Load'));
  // On a phone the three explanations fold away, so the form and the games are on the first screen.
  const howGrid = el('section', { class: 'how-grid' },
    how('best', 'Best', 'The strongest move according to Stockfish.'),
    how('simple', 'Simplest', 'Gives up at most 0.6 pawns to the best move, but is easy to follow up at your level.'),
    how('tricky', 'Trickiest', 'Gives up at most 1 pawn, in exchange for more chances for the opponent to go wrong.'));
  const howBlock = matchMedia('(max-width: 760px)').matches
    ? el('details', { class: 'card how-details' }, el('summary', {}, 'What are the three moves?'), howGrid)
    : howGrid;
  app.classList.add('home');
  app.replaceChildren(
    el('section', { class: 'hero' },
      el('h1', {}, 'Your games, explained calmly'),
      el('p', { class: 'muted' }, 'Mistakes and practical choices, reviewed together: at every key moment you get three options.'),
      BROWSER ? el('p', { class: 'muted small privacy-note' }, '🔒 The analysis runs on your device: your games never leave it.') : null),
    howBlock,
    el('section', { class: 'card games-card' }, BROWSER ? sources : null, form, chips, list),
    BROWSER ? pgnPanel() : null,
  );
  load();
}

// A game from anywhere else: paste its PGN and say which side is you.
function pgnPanel() {
  const text = el('textarea', { class: 'input pgn', rows: '6', placeholder: 'Paste the PGN here: 1. e4 e5 2. Nf3 Nc6 …', 'aria-label': 'PGN' });
  const side = el('select', { class: 'input', 'aria-label': 'Your side' },
    el('option', { value: 'white' }, 'I played White'), el('option', { value: 'black' }, 'I played Black'));
  const error = el('p', { class: 'error small', hidden: true });
  const go = async e => {
    e.preventDefault();
    error.hidden = true;
    try {
      const { id } = await post('/api/pgn', { pgn: text.value, user_color: side.value });
      location.hash = `#/game/${id}`;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
  return el('details', { class: 'card pgn-card' },
    el('summary', {}, 'Have the game as a PGN? Paste it'),
    el('form', { onsubmit: go }, text, el('div', { class: 'pgn-row' }, side, el('button', { class: 'btn primary', type: 'submit' }, 'Review this game')), error));
}

function gameRow(g) {
  const result = { win: ['W', 'Win'], loss: ['L', 'Loss'], draw: ['=', 'Draw'] }[g.result];
  const r = g.review;
  const side = r
    ? [el('span', { class: 'tag ok' }, `accuracy ${r.accuracy?.toFixed(1) ?? '–'}`),
      el('span', { class: 'muted small' },
        [r.mistakes ? `${KINDS.mistake.icon} ${r.mistakes}` : null, r.choices ? `${KINDS.choice.icon} ${r.choices}` : null].filter(Boolean).join('  ') || 'no critical moments')]
    : [el('span', { class: 'tag' }, 'not reviewed'), el('span', { class: 'muted small' }, `you ${g.user_rating}`)];
  return el('a', { class: `game-row r-${g.result}${g.demo ? ' demo' : ''}`, href: `#/game/${g.id}` },
    el('span', { class: 'result-badge', title: result[1] }, result[0]),
    el('span', { class: 'game-main' },
      g.demo && g.title ? el('span', { class: 'demo-title' }, el('span', { class: 'tag demo' }, 'demo'), g.title) : null,
      el('span', { class: 'game-title' },
        el('span', { class: `piece-dot ${g.user_color}`, title: g.user_color === 'white' ? 'you had White' : 'you had Black' }),
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
    job: null, posJob: null, narrJob: null, hint: null, sel: null, autoplay: null, alive: true, cg: null,
  });
  cleanup = () => {
    S.alive = false;
    clearInterval(S.autoplay);
    // Chessground keeps redrawing its arrows when its element goes away, and prints NaN errors.
    S.cg?.destroy();
    S.cg = null;
  };

  app.replaceChildren(el('div', { class: 'card loading' }, spinner(), ' Opening the game…'));
  let game;
  try {
    game = await api(`/api/games/${id}?user=${encodeURIComponent(S.user)}`);
  } catch (e) {
    app.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error' }, e.message), el('a', { class: 'btn', href: '#/' }, '← Back to games')));
    return;
  }
  S.meta = game.summary;
  S.user = S.meta.username || S.user;
  S.startFen = game.start_fen;
  S.plies = game.plies;
  S.orientation = S.meta.user_color;
  S.cur = Math.min(startPly, S.plies.length);
  buildLayout(app);

  // Only a game without a review starts one: any other failure is shown as is.
  let review = null;
  try {
    review = await api(`/api/reviews/${id}?user=${encodeURIComponent(S.user)}`);
  } catch (e) {
    if (e.status === 404) runReviewJob();
    else S.job = { status: 'error', error: e.message };
  }
  if (review) setReview(review);
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
  d.evalbar = el('div', { class: 'evalbar', title: 'Evaluation (Stockfish)' }, d.evalFill, d.evalLabel);
  d.cg = el('div', { class: 'cg-host' });
  // Outside .board, whose overflow is hidden: a badge may stick out past the edge.
  d.badges = el('div', { class: 'board-badges', 'aria-hidden': 'true' });
  d.legend = el('div', { class: 'legend' });
  d.coach = el('div', { class: 'coach', 'aria-live': 'polite' });
  d.summary = el('div', { class: 'summary' });
  d.graph = el('div', { class: 'graph' });
  d.moves = el('div', { class: 'moves' });
  d.sound = el('button', { class: 'icon-btn hide-compact', title: 'Move sounds', 'aria-label': 'Move sounds', onclick: toggleSound });
  const tab = (key, label) => el('button', { class: 'tab', role: 'tab', onclick: () => setTab(key) }, label);
  d.tabs = { coach: tab('coach', 'Coach'), moves: tab('moves', 'Moves') };
  d.panes = {
    coach: el('div', { class: 'pane', role: 'tabpanel' }, d.coach),
    moves: el('div', { class: 'pane', role: 'tabpanel' }, d.moves,
      el('p', { class: 'muted tiny keys' }, 'Keys: ← → moves · N/P key moments · 1/2/3 options · F flip · Esc back to the game')),
  };
  d.panesBox = el('div', { class: 'panes' }, d.panes.coach, d.panes.moves);
  S.tab = store.get('tab', 'coach');

  const btn = (label, title, fn, cls = 'icon-btn') => el('button', { class: cls, title, 'aria-label': title, onclick: fn }, label);
  const controls = el('div', { class: 'controls' },
    el('div', { class: 'ctrl-group' },
      btn('⏮', 'Start (Home)', () => go(0), 'icon-btn hide-compact'),
      btn('◀', 'Back (←)', () => step(-1)),
      btn('▶', 'Forward (→)', () => step(1)),
      btn('⏭', 'Last move (End)', () => go(S.plies.length), 'icon-btn hide-compact')),
    el('div', { class: 'ctrl-group' },
      btn('◀ Moment', 'Previous key moment (P)', () => jumpMoment(-1), 'icon-btn wide'),
      btn('Moment ▶', 'Next key moment (N)', () => jumpMoment(1), 'icon-btn wide')),
    el('div', { class: 'ctrl-group' },
      btn('⇅', 'Flip the board (F)', flip),
      btn('☰', 'Move list', () => setTab(S.tab === 'moves' ? 'coach' : 'moves'), 'icon-btn compact-only'),
      d.sound));

  const opening = [S.meta.opening, tcLabel(S.meta.time_control), whenLabel(S.meta.end_time)].filter(Boolean).join(' · ');
  app.replaceChildren(
    el('div', { class: 'review' },
      el('section', { class: 'board-col' },
        el('a', { class: 'back back-compact compact-only', href: '#/' }, '← games'),
        d.top,
        el('div', { class: 'board-wrap' }, d.evalbar,
          el('div', { class: 'board-frame' }, el('div', { class: 'board' }, d.cg), d.badges)),
        d.bottom,
        controls,
        d.legend),
      el('section', { class: 'side-col card' },
        el('div', { class: 'side-head' },
          el('div', { class: 'side-top' },
            el('a', { class: 'back', href: '#/' }, '← games'),
            S.meta.url ? el('a', { class: 'back', href: S.meta.url, target: '_blank', rel: 'noopener' }, 'on Chess.com ↗') : null),
          el('div', { class: 'side-title' },
            S.meta.demo ? el('span', { class: 'demo-title' }, el('span', { class: 'tag demo' }, 'demo'), S.meta.title || '') : null,
            el('b', {}, `${S.user} vs ${S.meta.opponent}`),
            el('span', { class: 'muted small' }, opening)),
          d.summary,
          d.graph),
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
  const onResize = () => {
    const was = isCompact();
    fitBoard();
    if (was !== isCompact()) { S.sel = null; update(); }
  };
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
  fitBoard();
}

// Chessground rounds the board down to a multiple of 8 device pixels, which left a
// strip of empty frame on the right and bottom. Size the frame to that same
// multiple so the squares fill it exactly, whatever the display scaling.
function fitBoard() {
  const review = $('.review');
  if (!review) return;
  const w = innerWidth, h = innerHeight;
  // Phones: the whole review fits one screen. Portrait stacks the board over the panel;
  // a short landscape window puts them side by side.
  const portrait = w <= 760;
  const land = !portrait && w > h && h <= 520;
  review.classList.toggle('compact', portrait || land);
  review.classList.toggle('land', land);
  document.body.classList.toggle('compact-review', portrait || land);
  let target;
  if (portrait) target = Math.max(206, Math.min(w - 32, h - 500, 480));
  else if (land) target = Math.max(200, h - 90);
  else {
    const side = Math.min(460, Math.max(360, w * 0.32));
    target = w <= 1020 ? w - 70 : Math.min(h - 225, w - side - 120, 820);
  }
  const dpr = devicePixelRatio || 1;
  // Chessground rounds the board down to a multiple of 8 device pixels, which left a
  // strip of empty frame on the right and bottom. Size the frame to that same multiple.
  const size = Math.floor((Math.max(portrait || land ? 200 : 300, target) * dpr) / 8) * 8 / dpr;
  review.style.setProperty('--board', `${size}px`);
  S.cg?.redrawAll();
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
  if (!S.variation) S.variation = { base: S.cur, moves: [], idx: 0, label: 'Your variation' };
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
  // A job that finishes after the user left the game must not draw on a board that is gone.
  if (!S.cg || !S.alive) return;
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
  updateMoveBadge();
  updatePlayers();
  updateEvalbar();
  updateMoveList();
  updateGraph();
  updateSummary();
  updateCoach();
}

function drawShapes() {
  const out = [];
  const used = new Set();
  const advice = currentAdvice();
  if (advice) {
    const groups = adviceGroups(advice);
    const sel = S.sel ?? defaultSel(groups, advice);
    const playedUci = advice.critical ? advice.facts.played?.uci : null;
    // The arrow of the selected card is the strong one ("your move" lights it if it is an option too).
    const selected = sel === -1 ? playedUci : isCompact() ? compactRoles(advice)[sel]?.c.uci : groups[sel]?.c.uci;
    const lit = groups.findIndex(g => g.c.uci === selected);
    groups.forEach((g, i) => {
      const role = g.roles[0];
      out.push({ orig: g.c.uci.slice(0, 2), dest: g.c.uci.slice(2, 4), brush: i === lit ? ROLES[role].brush : `${ROLES[role].brush}Faded` });
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
  const labels = { best: 'Best', simple: 'Simplest', tricky: 'Trickiest', played: 'Your move' };
  S.dom.legend.replaceChildren(...[...used].map(r => el('span', {}, el('i', { class: `sw ${r}` }), labels[r])));
}

// The class of the move that led to the position, on its destination square, as on
// chess.com. Variations carry no classes, so they show none.
function updateMoveBadge() {
  const i = S.variation ? 0 : S.cur;
  const p = S.review && i > 0 ? S.plies[i - 1] : null;
  if (!p || !JUDGEMENTS[p.judgement]) {
    S.dom.badges.replaceChildren();
    return;
  }
  const file = p.uci.charCodeAt(2) - 97;
  const rank = Number(p.uci[3]) - 1;
  const white = S.orientation === 'white';
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  const badge = jIcon(p.judgement, 'on-board');
  // Top-right corner of the square, sticking out a little as on chess.com.
  badge.style.left = `${(col + 0.66) * 12.5}%`;
  badge.style.top = `${(row - 0.1) * 12.5}%`;
  S.dom.badges.replaceChildren(badge);
}

function updatePlayers() {
  const g = S.meta;
  const userColor = g.user_color;
  const oppColor = userColor === 'white' ? 'black' : 'white';
  const row = (color, name, rating, you) => [
    el('span', { class: `piece-dot ${color}` }), el('b', {}, name), el('span', { class: 'muted' }, `(${rating})`),
    you ? el('span', { class: 'tag' }, 'you') : null,
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
  const kind = kindOf(p);
  const cell = el('button', {
    class: `move j-${p.judgement || 'none'}${kind ? ` critical k-${kind}` : ''}`,
    title: j ? j.label : null,
    onclick: () => go(p.ply + 1, { silent: true }),
  },
  j ? jIcon(p.judgement, 'sm') : null,
  el('span', { class: 'san' }, p.san),
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
  svg.setAttribute('aria-label', 'Evaluation over the game: click to jump to a move');
  // Key moments are drawn at the position before the user's move (x = ply).
  svg.innerHTML = `<rect class="g-black" width="${W}" height="${H}"/><path class="g-white" d="${area}"/>`
    + `<line class="g-mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>`
    + moments().map(p => {
      const prev = p.ply > 0 ? S.plies[p.ply - 1] : { white_win: 50 };
      return `<circle class="g-crit k-${kindOf(p)}" cx="${(p.ply / n) * W}" cy="${y(prev)}" r="4.5"/>`;
    }).join('')
    + `<line class="g-cursor" x1="0" y1="0" x2="0" y2="${H}"/>`;
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
  if (!r) { S.dom.summary.replaceChildren(); return; }
  if (S.dom.summary.childElementCount) return;
  const userColor = r.game.user_color;
  const oppColor = userColor === 'white' ? 'black' : 'white';
  const acc = c => (r.accuracy[c] == null ? '–' : r.accuracy[c].toFixed(1));
  S.dom.summary.replaceChildren(
    el('div', { class: 'accuracy', title: 'Accuracy (Lichess formula)' },
      el('span', { class: 'acc' }, el('span', { class: 'acc-num' }, acc(userColor)), el('span', { class: 'muted small' }, 'you')),
      el('span', { class: 'acc' }, el('span', { class: 'acc-num soft' }, acc(oppColor)), el('span', { class: 'muted small' }, S.meta.opponent))));
}

// How many moves of each class both players made; the simple and tricky rows only
// show up when the user played such a move.
function qualityTable() {
  const r = S.review;
  const userColor = r.game.user_color;
  const counts = mine => {
    const c = {};
    for (const p of r.plies) if ((p.color === userColor) === mine) c[p.judgement] = (c[p.judgement] || 0) + 1;
    return c;
  };
  const cu = counts(true), co = counts(false);
  const keys = Object.keys(JUDGEMENTS).filter(k => !['simple', 'tricky'].includes(k) || cu[k]);
  return el('div', { class: 'quality' },
    el('div', { class: 'q-row head muted' }, el('span', {}, 'Move quality'), el('span', { class: 'n' }, 'you'), el('span', { class: 'n' }, 'opp.')),
    ...keys.map(k => el('div', { class: 'q-row' },
      el('span', { class: 'q-label' }, jIcon(k, 'sm'), JUDGEMENTS[k].label),
      el('span', { class: 'n' }, cu[k] || 0),
      el('span', { class: 'n soft' }, co[k] || 0))));
}

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
    return [coachHead('Something went wrong'), el('p', { class: 'error' }, job.error || 'Error'),
      el('button', { class: 'btn', onclick: route }, 'Retry')];
  }
  const msg = job?.message || 'Queued';
  const f = job?.fraction || 0;
  const stage = msg.startsWith('Writing') ? 2 : msg.startsWith('Analysing') ? 1 : msg.startsWith('Evaluating') ? 0 : -1;
  const steps = ['Evaluating every move', 'Analysing the key moments', 'Writing the explanations'];
  let eta = 'This takes a few minutes';
  if (f > 0.05 && job?.elapsed) {
    const left = (job.elapsed / f) * (1 - f);
    eta = left > 90 ? `About ${Math.round(left / 60)} minutes to go` : left > 30 ? 'A minute or so to go' : 'Almost done';
  }
  return [
    coachHead('Studying your game', eta),
    el('ol', { class: 'steps' }, ...steps.map((s, i) =>
      el('li', { class: i < stage ? 'done' : i === stage ? 'now' : '' }, el('span', { class: 'step-dot' }, i < stage ? '✓' : i + 1), s))),
    progressBar(f, msg),
    el('p', { class: 'muted small' }, 'Meanwhile you can step through the moves and move the pieces on the board.'),
  ];
}

function variationBanner() {
  const v = S.variation;
  const sans = v.moves.map((m, i) => el('button', {
    class: 'var-move' + (i === v.idx - 1 ? ' active' : ''),
    onclick: () => { stopAutoplay(); v.idx = i + 1; update(); },
  }, m.san));
  return el('div', { class: 'variation' },
    el('div', { class: 'var-head' }, el('b', {}, v.label || 'Variation'),
      el('button', { class: 'btn small', onclick: () => go(v.base, { silent: true }) }, '↩ Back to the game')),
    el('div', { class: 'var-moves' }, ...sans));
}

function introView() {
  const list = moments();
  const nm = list.filter(p => kindOf(p) === 'mistake').length;
  const nc = list.filter(p => kindOf(p) === 'choice').length;
  const parts = [];
  if (nm) parts.push(`${nm} ${nm === 1 ? 'mistake to review' : 'mistakes to review'}`);
  if (nc) parts.push(`${nc} ${nc === 1 ? 'practical choice' : 'practical choices'}`);
  return [
    coachHead('Ready to review?', 'Use ← → or N for the next key moment'),
    el('p', {}, list.length ? `I found ${parts.join(' and ')}.` : 'No critical moments: a clean game!'),
    list.length ? el('div', { class: 'moment-list' }, ...list.map(p => {
      const k = kindOf(p);
      const c = criticalAt(p.ply);
      const note = k === 'mistake' ? `best was ${c?.facts.best.san || p.best_san}` : alternativesNote(c);
      return el('button', { class: `moment-row k-${k}`, onclick: () => go(p.ply, { silent: true }) },
        el('span', { class: 'moment-icon', title: KINDS[k].label }, KINDS[k].icon),
        el('span', { class: 'moment-move' }, jIcon(p.judgement, 'sm'), el('span', { class: 'mv' }, moveLabel(p))),
        el('span', { class: 'muted small' }, note));
    })) : null,
    list.length ? el('button', { class: 'btn primary', onclick: () => jumpMoment(1) }, 'Start with the first moment ▶') : null,
    qualityTable(),
  ];
}

function alternativesNote(c) {
  if (!c) return '';
  const f = c.facts;
  const role = f.played?.roles?.[0];
  if (role && role !== 'best') return `you found the ${ROLES[role].label.toLowerCase()} move`;
  const notes = [];
  if (!f.same?.simple_is_best) notes.push(`simplest ${f.simple.san}`);
  if (!f.same?.tricky_is_best) notes.push(`trickiest ${f.tricky.san}`);
  return notes.join(' · ');
}

function moveInfo() {
  if (S.variation) return [coachHead('Explore', 'Move the pieces to try other ideas')];
  const i = S.cur;
  const p = S.plies[i - 1];
  const mine = p.color === S.meta.user_color;
  const out = [verdict(p, mine ? 'your move' : `${S.meta.opponent}'s move`, forUser(p.white_eval))];
  if (p.uci !== p.best_uci && ['inaccuracy', 'mistake', 'blunder'].includes(p.judgement)) {
    out.push(el('p', {}, 'Better was ', el('span', { class: 'mv' }, p.best_san), '. ',
      el('button', { class: 'link', onclick: () => { go(i - 1, { silent: true }); S.hint = p.best_uci; drawShapes(); } }, 'Show me')));
  }
  if (p.critical) {
    const k = kindOf(p);
    out.push(el('button', { class: `btn soft k-${k}`, onclick: () => { setTab('coach'); go(i - 1, { silent: true }); } }, `${KINDS[k].icon} Review this moment`));
  }
  return out;
}

function analyseButton() {
  const key = currentHistory().join(' ');
  const pj = S.posJob?.key === key ? S.posJob.job : null;
  if (pj && pj.status !== 'done' && pj.status !== 'error') {
    return progressBar(pj.fraction || 0, pj.message || 'Queued');
  }
  const fen = currentFen();
  if (new Chess(fen).isGameOver()) return el('p', { class: 'muted small' }, 'Game over.');
  const side = turnOf(fen) === S.meta.user_color ? 'you' : S.meta.opponent;
  return el('div', { class: 'analyse' },
    pj?.status === 'error' ? el('p', { class: 'error small' }, pj.error) : null,
    el('button', { class: 'btn soft', onclick: runPositionJob }, `Analyse this position`),
    el('span', { class: 'muted small' }, `to move: ${side} · about 15 seconds`));
}

// The headline of a move: its class badge, "14.h4 is the trickiest move", the eval.
function verdict(p, sub, evalText) {
  const j = JUDGEMENTS[p.judgement] || { phrase: '' };
  return el('div', { class: `verdict j-${p.judgement}` },
    jIcon(p.judgement, 'lg'),
    el('div', { class: 'verdict-text' },
      el('h3', {}, el('span', { class: 'mv' }, moveLabel(p)), ` ${j.phrase}`),
      sub ? el('span', { class: 'muted small' }, sub) : null),
    evalText ? el('span', { class: 'verdict-eval', title: 'Evaluation after the move, from your point of view' }, evalText) : null);
}

// An eval written from White's side ("+0.85", "#-3"), seen from the user's side.
function forUser(whiteEval) {
  if (S.meta.user_color === 'white' || !whiteEval) return whiteEval;
  if (whiteEval.startsWith('#')) return whiteEval.startsWith('#-') ? `#${whiteEval.slice(2)}` : `#-${whiteEval.slice(1)}`;
  const n = -parseFloat(whiteEval);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function playedLineAction(f) {
  const line = f.played?.line?.uci;
  if (!line?.length) return null;
  const fen = currentFen();
  return () => playLine(line, `After your ${f.played.move}`, fen);
}

function criticalView(advice) {
  const f = advice.facts;
  const n = advice.narration || {};
  const kind = advice.kind || 'mistake';
  const p = S.plies[S.cur];
  const list = moments();
  const idx = list.findIndex(m => m.ply === S.cur);
  const navBtn = (label, title, dir, off) => el('button', {
    class: 'icon-btn tiny', title, 'aria-label': title, disabled: off, onclick: () => jumpMoment(dir),
  }, label);
  const out = [
    el('div', { class: `moment-bar k-${kind}` },
      el('span', { class: 'moment-kind' }, `${KINDS[kind].icon} ${KINDS[kind].label}`),
      el('span', { class: 'moment-nav' },
        navBtn('◀', 'Previous key moment (P)', -1, idx <= 0),
        el('span', { class: 'muted small' }, `${idx + 1} of ${list.length}`),
        navBtn('▶', 'Next key moment (N)', 1, idx >= list.length - 1))),
    verdict(p, 'your move', f.played.eval),
  ];
  const afterYours = kind === 'mistake' ? playedLineAction(f) : null;
  if (!isCompact()) {
    if (n.summary) out.push(el('p', { class: 'summary-text' }, ...richText(n.summary)));
    if (afterYours) out.push(el('button', { class: 'link warn', onclick: afterYours }, '↯ See what happens after your move'));
  }
  if (!isCompact() && f.same?.only_one_candidate) {
    out.push(el('p', { class: 'muted small' }, 'There was only one good move here: no alternatives within the margin.'));
  }
  out.push(...optionsSection(advice));
  out.push(narrationFooter(n));
  return out;
}

function optionsView(advice) {
  const f = advice.facts;
  const n = advice.narration || {};
  const out = [coachHead('Your options', `${SIDES[f.side] || f.side} to move · Elo ${f.user_elo} vs ${f.opponent_elo}`)];
  if (n.summary) out.push(el('p', { class: 'summary-text' }, ...richText(n.summary)));
  if (f.same?.only_one_candidate) out.push(el('p', { class: 'muted small' }, 'There is only one good move here.'));
  out.push(...optionsSection(advice));
  out.push(narrationFooter(n, false));
  return out;
}

function narrationFooter(n, canRegenerate = !BROWSER || !!LLM_URL) {
  const nj = S.narrJob;
  const source = n.source === 'template' ? (BROWSER ? 'Explanations written from the Stockfish and Maia data' : 'Automatic explanations (LLM unavailable)')
    : n.source ? `Explanations by ${n.source}, based on Stockfish and Maia data` : '';
  return el('div', { class: 'footnote muted tiny' },
    source,
    canRegenerate && nj && nj.status !== 'error'
      ? el('span', {}, ' · ', spinner(), ` ${nj.message || 'rewriting…'}`)
      : canRegenerate ? el('button', {
        class: 'link tiny', onclick: runNarrationJob,
        title: BROWSER ? 'Sends the facts of each key moment (positions, moves, evaluations; no names) to an AI service' : null,
      }, BROWSER ? ' · rewrite with AI' : ' · rewrite the explanations') : null,
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

function defaultGroup(groups, kind, played) {
  // If you played the simplest or trickiest move, open on it; otherwise, for a
  // practical choice, on the alternative to the best move.
  const mine = played ? groups.findIndex(g => g.c.uci === played.uci && g.roles.some(r => r !== 'best')) : -1;
  if (mine >= 0) return mine;
  if (kind === 'choice' && groups.length > 1) return 1;
  return 0;
}

// Phones show the coach as cards: "your move" and the options are buttons, and only the
// chosen one explains itself, so the whole review fits one screen.
const isCompact = () => !!document.querySelector('.review.compact');

// One card per role (best, simplest, trickiest), even when two are the same move: each
// keeps its own short text, which is what makes everything fit.
function compactRoles(advice) {
  const f = advice.facts;
  return (f.same?.only_one_candidate ? ['best'] : ['best', 'simple', 'tricky']).map(role => ({ role, c: f[role] }));
}

// For a mistake the compact view opens on "your move" (-1): what went wrong comes first.
// Otherwise on the move you played if it is not the best, else on the first alternative.
function defaultSel(groups, advice) {
  if (!isCompact()) return defaultGroup(groups, advice.kind, advice.critical ? advice.facts.played : null);
  if (advice.critical && advice.kind === 'mistake') return -1;
  const roles = compactRoles(advice);
  const played = advice.critical ? advice.facts.played?.uci : null;
  const mine = roles.findIndex(r => r.role !== 'best' && r.c.uci === played);
  if (mine >= 0) return mine;
  const alt = roles.findIndex(r => r.role !== 'best' && r.c.uci !== roles[0].c.uci);
  return alt >= 0 && advice.kind === 'choice' ? alt : 0;
}

function selectGroup(i) {
  const advice = currentAdvice();
  if (!advice) return;
  const count = isCompact() ? compactRoles(advice).length : adviceGroups(advice).length;
  if (i >= count || i < (isCompact() && advice.critical ? -1 : 0)) return;
  S.sel = i;
  drawShapes();
  updateCoach();
}

// The distinct candidate moves as an accordion: one row each (badges, roles, move,
// eval) and only the selected one open with its explanation and numbers.
function optionsSection(advice) {
  const groups = adviceGroups(advice);
  const n = advice.narration || {};
  const played = advice.critical ? advice.facts.played : null;
  const count = isCompact() ? compactRoles(advice).length : groups.length;
  if (S.sel == null || S.sel >= count || (S.sel < 0 && !(isCompact() && advice.critical))) S.sel = defaultSel(groups, advice);
  if (isCompact()) {
    const rows = compactRoles(advice).map((r, i) => optionRow({ c: r.c, roles: [r.role] }, i, n, played?.uci));
    if (advice.critical) rows.unshift(youRow(advice));
    return [el('div', { class: 'options', style: `--n:${rows.length}` }, ...rows)];
  }
  return [
    el('div', { class: 'options-label' }, el('span', {}, groups.length > 1 ? 'Your options' : 'The move'),
      el('span', { class: 'muted' }, 'eval for you')),
    el('div', { class: 'options', style: `--n:${groups.length}` }, ...groups.map((g, i) => optionRow(g, i, n, played?.uci))),
  ];
}

// "Your move" as the first card of the compact view: what you played and what it meant.
function youRow(advice) {
  const f = advice.facts;
  const n = advice.narration || {};
  const open = S.sel === -1;
  const after = advice.kind === 'mistake' ? playedLineAction(f) : null;
  const head = el('button', { class: 'opt-head', 'aria-expanded': String(open), title: 'Your move', onclick: () => selectGroup(-1) },
    el('span', { class: 'opt-icons' }), el('span', { class: 'opt-roles' }, 'Your move'),
    el('span', { class: 'opt-move' }, el('b', { class: 'mv' }, f.played.san)), el('span', { class: 'opt-eval' }, f.played.eval));
  if (!open) return el('div', { class: 'opt you' }, head);
  return el('div', { class: 'opt you open' }, head,
    el('div', { class: 'opt-body' },
      n.summary ? el('p', {}, ...richText(n.summary)) : null,
      f.same?.only_one_candidate ? el('p', { class: 'muted' }, 'There was only one good move here: no alternatives within the margin.') : null,
      after ? el('button', { class: 'link warn', onclick: after }, '↯ See what happens after your move') : null));
}

function optionRow({ c, roles }, i, n, playedUci) {
  const open = i === S.sel;
  const [primary, ...others] = roles;
  const head = el('button', { class: 'opt-head', 'aria-expanded': String(open), title: `Key ${i + 1}`, onclick: () => selectGroup(i) },
    el('span', { class: 'opt-icons' }, ...roles.map(r => jIcon(r))),
    el('span', { class: 'opt-roles' }, roles.map(r => ROLES[r].label).join(' · ')),
    el('span', { class: 'opt-move' }, el('b', { class: 'mv' }, c.san), c.uci === playedUci ? el('span', { class: 'tag mine' }, 'yours') : null),
    el('span', { class: 'opt-eval' }, c.eval));
  if (!open) return el('div', { class: `opt ${primary}` }, head);
  const traps = roles.includes('tricky') ? c.traps : null;
  return el('div', { class: `opt ${primary} open` }, head,
    el('div', { class: 'opt-body' },
      n[primary] ? el('p', {}, ...richText(n[primary])) : null,
      ...others.map(r => (n[r] ? el('p', { class: 'secondary' }, ...richText(n[r])) : null)),
      el('div', { class: 'facts' },
        fact('At your level', c.at_your_level, 'Expected evaluation if you keep playing at your level'),
        fact('Vs a human', c.vs_human, 'Expected evaluation against a real opponent of their level'),
        fact('Found by', pct(c.naturalness), 'How many players at your level would choose it'),
        c.opponent_error_prob > 0 ? fact('Opponent errs', pct(c.opponent_error_prob), 'Chance that the opponent replies with a mistake') : null),
      el('div', { class: 'opt-actions' },
        el('button', { class: 'link', onclick: () => playLine(c.line.uci, `${ROLES[primary].label}: ${c.move}`) }, '▶ Show the line'),
        traps?.[0]?.punishment_uci
          ? el('button', { class: 'link', onclick: () => playLine([c.uci, traps[0].reply_uci, traps[0].punishment_uci], `Trap: ${c.move}`) }, '⚑ Show the trap')
          : null)));
}

function fact(label, value, title) {
  return el('div', { class: 'fact', title }, el('span', { class: 'muted' }, label), el('b', {}, value));
}
