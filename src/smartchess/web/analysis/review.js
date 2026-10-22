// Game review: find the user's critical positions and analyse them in depth. Port of
// review.py plus review_json. This runs on the main thread and hands the heavy work to a
// `runner` ({run(type, task) -> Promise}, the worker pool or, in tests, one engine).

import { DEFAULT_SETTINGS } from './practical.js';
import { MOMENT_LABELS, markPlayedOptions } from './facts.js';
import { Pos } from './position.js';
import { toMaiaElo } from './ratings.js';
import { MATE_CP, formatCp, marginWin, winPct } from './winprob.js';

// A move that loses this many win% points is reviewed as a mistake.
const MISTAKE_LOSS = 6;
// A practical choice is kept only if the simple or tricky move beats the best move by
// this many win% points at the user's level or against a human.
const CHOICE_GAIN = 3;
// Win% of the best move for a position to be considered for a practical choice.
const CHOICE_WIN_RANGE = [15, 85];
const DEFAULT_ELO = toMaiaElo(1400, 'chess.com');

export const REVIEW_SETTINGS = {
  maxMistakes: 5, maxChoices: 5, choicePool: 6, skipPlies: 6, prepassDepth: 14, prepassNodes: 2_500_000,
};

function judgement(loss, isBest) {
  if (isBest) return 'best';
  if (loss < 2) return 'excellent';
  if (loss < 6) return 'good';
  if (loss < 12) return 'inaccuracy';
  if (loss < 20) return 'mistake';
  return 'blunder';
}

const accuracyOf = loss => Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

/**
 * game: {startFen, moves: [uci], headers: {White, Black, WhiteElo, ...}}
 * players: {user: 'white'|'black', userElo, oppElo}
 * Returns the review as the web UI expects it.
 */
export async function reviewGame({ game, runner, players, progress = () => {}, forcePlies = [], settings = {}, limits = {} }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const r = { ...REVIEW_SETTINGS, ...limits };
  const color = players.user;
  const threshold = marginWin(Math.max(s.marginCp, s.trickyMarginCp));

  // Positions of the game, each before its move, with history.
  const positions = [Pos.fromFen(game.startFen)];
  for (const uci of game.moves) positions.push(positions[positions.length - 1].pushUci(uci));
  const n = game.moves.length;
  const solved = [];

  // Pass 1: every position, so that each move gets an eval and a judgement.
  let done = 0;
  const quick = await Promise.all(positions.map(async (pos, ply) => {
    const task = {
      startFen: game.startFen, moves: game.moves.slice(0, ply), depth: r.prepassDepth, nodes: r.prepassNodes,
      multipv: ply < n && pos.turn === color ? s.multipv : 1,
      policy: ply < n && pos.turn === color ? { userElo: players.userElo, oppElo: players.oppElo } : null,
    };
    // The final position only needs its eval, unless the game ended there.
    if (ply === n && pos.isGameOver()) return null;
    const out = await runner.run('quick', task);
    progress(`Evaluating every move: ${++done}/${n + 1}`, 0.2 * done / (n + 1));
    return out;
  }));
  const finalCp = quick[n] ? quick[n].lines[0].cp : (positions[n].result().winner !== null ? -MATE_CP : 0);

  const plies = [];
  for (let ply = 0; ply < n; ply++) {
    const lines = quick[ply].lines;
    plies.push({ ply, pos: positions[ply], uci: game.moves[ply], best: lines[0], lines, policy: quick[ply].policy, cpAfter: 0 });
  }
  plies.forEach((info, i) => {
    // The eval after a move is the next position's eval, seen from the mover.
    info.cpAfter = -(i + 1 < n ? plies[i + 1].best.cp : finalCp);
    info.bestWin = winPct(info.best.cp);
    info.loss = info.uci === info.best.uci ? 0 : Math.max(0, info.bestWin - winPct(info.cpAfter));
  });

  // Pick the user's positions worth a full practical analysis.
  const mistakes = [];
  const pool = [];
  for (const info of plies) {
    if (info.pos.turn !== color || info.ply < r.skipPlies || !(info.bestWin > 3 && info.bestWin < 97)) continue; // decided positions teach little
    if (info.loss >= MISTAKE_LOSS) {
      mistakes.push(info);
      continue;
    }
    // Practical choices only matter while the game is open.
    if (!(info.bestWin > CHOICE_WIN_RANGE[0] && info.bestWin < CHOICE_WIN_RANGE[1])) continue;
    const alternatives = info.lines.filter(line => info.bestWin - winPct(line.cp) <= threshold);
    if (alternatives.length < 2 || alternatives.every(line => line.cp === info.best.cp)) continue; // a single option, or a dead draw
    const bestNat = info.policy[info.best.uci] ?? 0;
    if (bestNat >= 0.3) continue;
    // The more natural an alternative is compared to the best move, and the more balanced
    // the position, the more likely a practical choice exists.
    const balance = 1 - Math.abs(info.bestWin - 50) / 50;
    pool.push([(Math.max(...alternatives.map(l => info.policy[l.uci] ?? 0)) - bestNat) * balance, info]);
  }
  mistakes.sort((a, b) => b.loss - a.loss);
  const topMistakes = mistakes.slice(0, r.maxMistakes);
  const poolInfos = pool.sort((a, b) => b[0] - a[0]).slice(0, r.choicePool).map(([, info]) => info);
  // Demo games can name moments that must be shown, whatever the heuristics say.
  const chosen = new Set([...topMistakes, ...poolInfos].map(i => i.ply));
  const forced = plies.filter(p => forcePlies.includes(p.ply) && !chosen.has(p.ply));
  const todo = [...topMistakes.map(info => ({ info, kind: 'mistake' })), ...[...poolInfos, ...forced].map(info => ({ info, kind: 'choice' }))];

  let analysed = 0;
  progress(`Analysing the key moments: 0/${todo.length}`, 0.2);
  const deep = await Promise.all(todo.map(async ({ info, kind }) => {
    const out = await runner.run('deep', {
      startFen: game.startFen, moves: game.moves.slice(0, info.ply), played: info.uci, kind, players,
    });
    progress(`Analysing the key moments: ${++analysed}/${todo.length}`, 0.2 + 0.75 * analysed / todo.length);
    return { info, kind, ...out };
  }));

  const kept = []; // mistakes, and practical options the user played
  const choices = [];
  for (const d of deep) {
    const { roles } = d;
    const played = d.info.uci;
    if (d.kind === 'mistake' && played !== roles.best) {
      // The quick pass saw a loss, but the deep search counts the played move among the
      // options: the user made a practical choice, not a mistake.
      if (played === roles.simple || played === roles.tricky) d.kind = 'choice';
      kept.push(d);
      continue;
    }
    // A "mistake" that the deep search finds best was misjudged by the quick pass: like
    // any choice, it stays only if the alternatives have something to say.
    d.kind = 'choice';
    if (!forcePlies.includes(d.info.ply)) {
      const differs = roles.simple !== roles.best || roles.tricky !== roles.best;
      if (!differs || d.gain < CHOICE_GAIN) continue;
    }
    choices.push(d);
  }
  choices.sort((a, b) => b.gain - a.gain);
  const critical = [...kept, ...choices.slice(0, r.maxChoices)].sort((a, b) => a.info.ply - b.info.ply);

  progress('Writing the explanations', 0.95);
  return buildReviewJson({ game, players, plies, critical });
}

function accuracy(plies, color) {
  const values = plies.filter(p => p.pos.turn === color).map(p => accuracyOf(p.loss));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function buildReviewJson({ game, players, plies, critical }) {
  const kinds = new Map(critical.map(d => [d.info.ply, d.kind]));
  const h = game.headers ?? {};
  const out = {
    game: {
      white: h.White ?? '?', black: h.Black ?? '?', white_elo: h.WhiteElo ?? '', black_elo: h.BlackElo ?? '',
      result: h.Result ?? '', date: h.Date ?? '', link: h.Link ?? '',
      start_fen: game.startFen, user_color: players.user, user_elo: players.userElo, opp_elo: players.oppElo,
    },
    accuracy: { white: accuracy(plies, 'white'), black: accuracy(plies, 'black') },
    plies: plies.map(info => {
      const b = info.pos;
      const whiteCp = b.turn === 'white' ? info.cpAfter : -info.cpAfter;
      return {
        ply: info.ply,
        san: b.sanUci(info.uci),
        uci: info.uci,
        color: b.turn,
        move_number: b.fullmoves,
        fen_before: b.fen(),
        fen_after: b.pushUci(info.uci).fen(),
        best_san: b.sanUci(info.best.uci),
        best_uci: info.best.uci,
        white_cp: whiteCp,
        white_eval: formatCp(whiteCp),
        white_win: Number(winPct(whiteCp).toFixed(1)),
        judgement: judgement(info.loss, info.uci === info.best.uci),
        loss: Number(info.loss.toFixed(1)),
        critical: kinds.has(info.ply),
        critical_kind: kinds.get(info.ply) ?? null,
      };
    }),
    critical: {},
  };
  for (const d of critical) {
    d.facts.moment = MOMENT_LABELS[d.kind] ?? null;
    out.critical[String(d.info.ply)] = {
      kind: d.kind,
      facts: d.facts,
      narration: { summary: '', ...d.drafts, source: 'template', drafts: d.drafts },
    };
  }
  return markPlayedOptions(out);
}

export { DEFAULT_ELO };
