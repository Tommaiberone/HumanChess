// The app's "server" when there is none: it answers the same requests the frontend makes
// of the API (/api/games, /api/reviews, /api/jobs, ...) from the browser itself. Games come
// from Chess.com or Lichess, reviews are computed by the worker pool and kept in IndexedDB.

import { AnalysisPool } from './client.js';
import { markPlayedOptions } from './facts.js';
import { gameId, gameMoves, gamePlayers, gameSummary, parseGame } from './games.js';
import { reviewGame } from './review.js';
import { fetchChesscom, fetchLichess, pgnId, pgnRecord, SourceError } from './sources.js';
import { Storage, reviewKey } from './storage.js';

const fail = (message, status) => Object.assign(new Error(message), { status });

/** What the game list shows about a finished review. */
function brief(review) {
  const kinds = Object.values(review.critical).map(c => c.kind ?? 'mistake');
  return {
    accuracy: review.accuracy[review.game.user_color],
    mistakes: kinds.filter(k => k === 'mistake').length,
    choices: kinds.filter(k => k === 'choice').length,
  };
}

async function keepAwake() {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

export function createBackend({ base, demosUrl, llmUrl = '', poolOptions = {} }) {
  const storage = new Storage();
  const pool = new AnalysisPool({ base, ...poolOptions });
  const jobs = new Map();
  let demos = null;
  let idleTimer = null;

  async function demoList() {
    if (!demos) {
      try {
        demos = await (await fetch(demosUrl)).json();
      } catch {
        demos = [];
      }
    }
    return demos;
  }

  async function rawGame(id) {
    const stored = await storage.get('games', id);
    if (stored) return stored;
    const demo = (await demoList()).find(d => gameId(d.game) === id);
    if (demo) return demo.game;
    throw fail('Game not found: reload the list', 404);
  }

  async function findReview(id, color) {
    const stored = await storage.get('reviews', reviewKey(id, color));
    if (stored) return stored;
    const demo = (await demoList()).find(d => gameId(d.game) === id);
    return demo && demo.game.user_color === color ? markPlayedOptions(demo.review) : null;
  }

  // -- jobs -----------------------------------------------------------------

  const snapshot = job => ({
    id: job.id, kind: job.kind, status: job.status, message: job.message, fraction: job.fraction,
    result: job.result, error: job.error, notice: job.notice ?? null, elapsed: job.started ? Math.round((Date.now() - job.started) / 100) / 10 : 0,
  });

  function startJob(id, kind, work) {
    const existing = jobs.get(id);
    if (existing && existing.status === 'running') return snapshot(existing);
    const job = { id, kind, status: 'running', message: 'Preparing the analysis', fraction: 0, result: null, error: null, started: Date.now() };
    jobs.set(id, job);
    clearTimeout(idleTimer);
    (async () => {
      const lock = await keepAwake();
      try {
        await pool.start((message, fraction) => { job.message = message; job.fraction = fraction * 0.05; });
        job.started = Date.now();
        job.result = await work(job);
        job.status = 'done';
        job.fraction = 1;
        job.message = 'Done';
      } catch (e) {
        job.status = 'error';
        job.error = e.message || String(e);
      } finally {
        lock?.release?.().catch?.(() => {});
        // Free the memory of the engines once nobody has asked for a while.
        idleTimer = setTimeout(() => pool.close(), 3 * 60_000);
      }
    })();
    return snapshot(job);
  }

  const progress = job => (message, fraction) => { job.message = message; job.fraction = fraction; };

  // -- routes ---------------------------------------------------------------

  async function listGames({ user, source, timeClass, limit }) {
    const out = [];
    const seen = new Set();
    const add = async (g, demo = false) => {
      const summary = gameSummary(g, user || '');
      if (seen.has(summary.id)) return;
      seen.add(summary.id);
      const review = await findReview(summary.id, summary.user_color);
      summary.review = review ? brief(review) : null;
      summary.demo = demo || summary.demo;
      out.push(summary);
    };
    for (const d of await demoList()) {
      if (!timeClass || d.game.time_class === timeClass) await add(d.game, true);
    }
    for (const g of await storage.all('games')) if (g.source === 'pgn') await add(g);
    if (user) {
      const fetch = source === 'lichess' ? fetchLichess : fetchChesscom;
      const games = await fetch(user, limit, timeClass);
      for (const g of games) {
        await storage.put('games', gameId(g), g); // always the fresh record: a stored one may predate a fix
        await add(g);
      }
    }
    return out;
  }

  async function review(id, user, redo) {
    const raw = await rawGame(id);
    const summary = gameSummary(raw, user || '');
    const color = summary.user_color;
    return { raw, summary, color, existing: redo ? null : await findReview(id, color) };
  }

  async function startReview(id, user) {
    const { raw, summary, color, existing } = await review(id, user, false);
    if (existing) {
      const job = { id: `review-${id}`, kind: 'review', status: 'done', message: 'Done', fraction: 1, result: existing, error: null, started: 0 };
      jobs.set(job.id, job);
      return snapshot(job);
    }
    return startJob(`review-${id}`, 'review', async job => {
      const parsed = parseGame(raw.pgn);
      const players = gamePlayers(parsed.headers, color);
      const result = await reviewGame({
        game: parsed, runner: pool, players, forcePlies: raw.key_plies ?? [], progress: progress(job),
      });
      result.game.id = id;
      result.game.opening = summary.opening;
      await storage.put('reviews', reviewKey(id, color), result);
      return result;
    });
  }

  // "Rewrite with AI": the facts of each key moment go to the explanation proxy, one request
  // each. Past a limit or on any failure the template explanations stay.
  async function startNarration(id, user) {
    if (!llmUrl) throw fail('AI explanations are not available on this site', 404);
    const { color, existing } = await review(id, user, false);
    if (!existing) throw fail('No review', 404);
    const job = { id: `narrate-${id}`, kind: 'narrate', status: 'running', message: 'Writing the explanations', fraction: 0, result: null, error: null, started: Date.now() };
    jobs.set(job.id, job);
    (async () => {
      try {
        const items = Object.values(existing.critical);
        let written = 0;
        let stopped = null;
        let busy = 0; // consecutive "busy" answers: the service is saturated, so stop asking
        for (const [i, item] of items.entries()) {
          job.message = `Writing the explanations ${i + 1}/${items.length}`;
          job.fraction = i / items.length;
          const drafts = item.narration?.drafts;
          if (!drafts) continue;
          let response;
          try {
            response = await fetch(llmUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ facts: item.facts, drafts }),
            });
          } catch {
            stopped = 'Could not reach the explanation service';
            break;
          }
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            stopped = data.error || `The explanation service answered ${response.status}`;
            if (response.status === 429 || response.status === 403) break;
            if (++busy >= 2) break;
            continue; // a busy model: the template stays for this moment, try the next one
          }
          busy = 0;
          item.narration = { summary: data.summary ?? '', best: data.best, simple: data.simple, tricky: data.tricky, source: data.source, drafts };
          written++;
        }
        if (written) await storage.put('reviews', reviewKey(id, color), existing);
        if (!written && stopped) throw new Error(stopped);
        if (stopped && written < items.length) job.notice = `The AI is busy: ${written} of ${items.length} rewritten, the rest keep the data-based text. Try again in a minute.`;
        job.result = existing;
        job.status = 'done';
        job.fraction = 1;
        job.message = 'Done';
      } catch (e) {
        job.status = 'error';
        job.error = e.message || String(e);
      }
    })();
    return snapshot(job);
  }

  async function startPosition(body) {
    const id = `position-${Date.now().toString(36)}`;
    return startJob(id, 'position', async job => {
      job.message = 'Analysing the position';
      job.fraction = 0.3;
      return pool.run('position', {
        startFen: body.start_fen, moves: body.moves, userElo: body.user_elo, oppElo: body.opp_elo,
      });
    });
  }

  async function addPgn(body) {
    const text = String(body.pgn ?? '').trim();
    if (text.length > 200_000) throw fail('That PGN is too long', 413);
    let parsed;
    try {
      parsed = parseGame(text);
    } catch (e) {
      throw fail(e.message, 400);
    }
    const id = await pgnId(text);
    const color = body.user_color === 'black' ? 'black' : 'white';
    await storage.put('games', id, pgnRecord(text, parsed.headers, id, color));
    return { id };
  }

  async function api(path, opts = {}) {
    const url = new URL(path, location.origin);
    const method = (opts.method ?? 'GET').toUpperCase();
    const p = url.pathname;
    const user = url.searchParams.get('user') ?? '';
    try {
      if (p === '/api/config') return { username: '', browser: true };
      if (p === '/api/games' && method === 'GET') {
        return await listGames({
          user: user.trim(), source: url.searchParams.get('source') ?? 'chess.com',
          timeClass: url.searchParams.get('time_class') ?? '', limit: 30,
        });
      }
      let m = p.match(/^\/api\/games\/(\w+)$/);
      if (m) return gameMoves(await rawGame(m[1]), user);
      m = p.match(/^\/api\/reviews\/(\w+)$/);
      if (m && method === 'GET') {
        const { existing } = await review(m[1], user, false);
        if (!existing) throw fail('No review', 404);
        return existing;
      }
      if (m && method === 'POST') return await startReview(m[1], user);
      m = p.match(/^\/api\/reviews\/(\w+)\/narrations$/);
      if (m && method === 'POST') return await startNarration(m[1], user);
      m = p.match(/^\/api\/jobs\/([\w-]+)$/);
      if (m) {
        const job = jobs.get(m[1]);
        if (!job) throw fail('Unknown job', 404);
        return snapshot(job);
      }
      if (p === '/api/positions' && method === 'POST') return await startPosition(JSON.parse(opts.body));
      if (p === '/api/pgn' && method === 'POST') return await addPgn(JSON.parse(opts.body));
    } catch (e) {
      if (e instanceof SourceError) throw Object.assign(new Error(e.message), { status: e.status });
      throw e;
    }
    throw fail('Not available in the browser version', 404);
  }

  return { api, storage, pool };
}
