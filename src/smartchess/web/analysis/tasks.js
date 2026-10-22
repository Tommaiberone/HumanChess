// The work one analysis worker does: a Stockfish and a Maia, and three kinds of task.
// Everything that goes in and out is plain JSON, so tasks cross the worker boundary.

import { drafts as templateDrafts } from './explain.js';
import { positionFacts } from './facts.js';
import { DEFAULT_SETTINGS, Searcher } from './practical.js';
import { Pos, moveUci, parseMove } from './position.js';
import { formatCp } from './winprob.js';

export function buildPos(startFen, moves) {
  let pos = Pos.fromFen(startFen);
  for (const uci of moves) pos = pos.pushUci(uci);
  return pos;
}

const lineJson = line => ({ uci: line.uci, cp: line.cp, pv: line.pv.map(moveUci) });

export class AnalysisEngine {
  constructor(stockfish, maia, settings = {}) {
    this.stockfish = stockfish;
    this.maia = maia;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  /** Start every task from a clean engine, so its result does not depend on what ran before. */
  async fresh() {
    await this.stockfish.newGame();
    if (this.maia.cache.size > 4000) this.maia.clear();
  }

  /**
   * The cheap look at one position of a game: Stockfish's best lines and, when asked,
   * how likely the human model finds each of them.
   * task: {startFen, moves, multipv, depth, nodes, policy: {userElo, oppElo} | null}
   */
  async quick(task) {
    await this.fresh();
    const pos = buildPos(task.startFen, task.moves);
    const lines = await this.stockfish.analyse(pos, { multipv: task.multipv, depth: task.depth, nodes: task.nodes });
    const out = { lines: lines.map(lineJson), policy: null };
    if (task.policy) {
      const policy = await this.maia.policy(pos, task.policy.userElo, task.policy.oppElo);
      const probs = new Map(policy.map(hm => [moveUci(hm.move), hm.prob]));
      out.policy = Object.fromEntries(lines.map(l => [l.uci, probs.get(l.uci) ?? 0]));
    }
    return out;
  }

  async analysePosition(pos, players) {
    return new Searcher(this.stockfish, this.maia, players, this.settings).analyse(pos);
  }

  /**
   * The full practical analysis of a position of the user's game.
   * task: {startFen, moves, played (uci), kind, players: {user, userElo, oppElo}}
   */
  async deep(task) {
    await this.fresh();
    const pos = buildPos(task.startFen, task.moves);
    const a = await this.analysePosition(pos, task.players);
    const played = parseMove(task.played);
    let playedLine = a.candidates.find(c => c.uci === task.played)?.line;
    if (!playedLine) {
      playedLine = (await this.stockfish.analyse(pos, {
        moves: [played], depth: this.settings.rootDepth, nodes: this.settings.rootNodes,
      }))[0];
    }
    const { best, simplest, trickiest } = a;
    return {
      bestCp: best.line.cp,
      playedCp: playedLine.cp,
      roles: { best: best.uci, simple: simplest.uci, tricky: trickiest.uci },
      gain: Math.max(simplest.simple - best.simple, trickiest.tricky - best.tricky),
      facts: positionFacts(a, played, playedLine.cp, playedLine.pv, task.kind),
      drafts: templateDrafts(a),
    };
  }

  /** Any position, with the side to move as "the user". task: {startFen, moves, userElo, oppElo} */
  async position(task) {
    await this.fresh();
    const pos = buildPos(task.startFen, task.moves);
    const a = await this.analysePosition(pos, { user: pos.turn, userElo: task.userElo, oppElo: task.oppElo });
    const drafts = templateDrafts(a);
    return {
      facts: positionFacts(a),
      narration: { summary: '', ...drafts, source: 'template', drafts },
      eval: formatCp(a.best.line.cp),
    };
  }

  async run(type, task) {
    if (!['quick', 'deep', 'position'].includes(type)) throw new Error(`Unknown task ${type}`);
    return this[type](task);
  }
}
