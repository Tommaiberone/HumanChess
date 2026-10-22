// Practical move selection. Port of practical.py.
//
// For a position where the user is to move, Stockfish gives the candidate moves that stay
// close to the best one (measured in win%): within `marginCp` for the simple move and
// within the wider `trickyMarginCp` for the tricky one. Each candidate is then scored by
// expectimax searches that differ only in who plays "perfectly":
//
//   objective  engine vs engine            -> plain Stockfish eval
//   simple     engine opponent, human user -> can *I* keep this up at my level?
//   tricky     human opponent, human user  -> what does it score against a real opponent?
//
// Human nodes are chance nodes weighted by Maia; engine nodes follow Stockfish's best move;
// leaves are Stockfish evals. All values are win% from the user's point of view.

import { topMoves } from './maia.js';
import { moveUci } from './position.js';
import { marginWin } from './winprob.js';

export const DEFAULT_SETTINGS = {
  marginCp: 60,
  trickyMarginCp: 100,
  multipv: 8,
  maxCandidates: 6,
  rootDepth: 18,
  rootNodes: 6_000_000,
  humanMass: 0.9,
  humanMaxMoves: 5,
  simplePlies: 4,
  trickyPlies: 2,
  // An opponent reply is a "mistake" when it hands the user this many win% points.
  errorDrop: 10,
};

const other = color => (color === 'white' ? 'black' : 'white');
// Python's round(x, 1) as a sort key.
const round1 = x => Number(x.toFixed(1));

export class Searcher {
  /** `players` is {user: 'white'|'black', userElo, oppElo}. */
  constructor(engine, human, players, settings = DEFAULT_SETTINGS) {
    this.engine = engine;
    this.human = human;
    this.players = players;
    this.settings = settings;
  }

  elo(color) {
    return color === this.players.user ? this.players.userElo : this.players.oppElo;
  }

  userWin(line, mover) {
    return mover === this.players.user ? line.win : 100 - line.win;
  }

  terminal(winner) {
    if (winner === null) return 50;
    return winner === this.players.user ? 100 : 0;
  }

  async humanMoves(pos) {
    const mover = pos.turn;
    const policy = await this.human.policy(pos, this.elo(mover), this.elo(other(mover)));
    return topMoves(policy, this.settings.humanMass, this.settings.humanMaxMoves);
  }

  // -- expectimax -----------------------------------------------------------

  async expand(pos, plies, humanSides) {
    const result = pos.result();
    if (result.over) return { pos, kind: 'terminal', value: this.terminal(result.winner), best: null, edges: [], covered: 1 };
    const mover = pos.turn;
    const best = await this.engine.best(pos);
    const bestValue = this.userWin(best, mover);
    if (plies === 0) return { pos, kind: 'leaf', value: bestValue, best, edges: [], covered: 1 };

    const hms = humanSides.has(mover) ? await this.humanMoves(pos) : [];
    if (!hms.length) {
      const edge = await this.edge(pos, best.move, 1, bestValue, plies, humanSides);
      return { pos, kind: 'engine', value: edge.value, best, edges: [edge], covered: 1 };
    }

    const evals = await this.engine.evaluateMoves(pos, hms.map(hm => hm.move));
    const edges = [];
    for (const hm of hms) {
      edges.push(await this.edge(pos, hm.move, hm.prob, this.userWin(evals.get(moveUci(hm.move)), mover), plies, humanSides));
    }
    const covered = edges.reduce((s, e) => s + e.prob, 0);
    let value;
    if (mover === this.players.user) {
      // The user's unlikely moves are dropped and the rest renormalised.
      value = edges.reduce((s, e) => s + e.prob * e.value, 0) / covered;
    } else {
      // The opponent's unexplored mass is assumed to find the best reply, so we never
      // count on mistakes the model cannot see.
      let bestEdge = edges.find(e => e.uci === moveUci(best.move));
      if (!bestEdge) bestEdge = await this.edge(pos, best.move, 0, bestValue, plies, humanSides);
      value = edges.reduce((s, e) => s + e.prob * e.value, 0) + (1 - covered) * bestEdge.value;
    }
    return { pos, kind: 'human', value, best, edges, covered };
  }

  async edge(pos, move, prob, objective, plies, humanSides) {
    const uci = moveUci(move);
    if (plies === 1) return { move, uci, prob, objective, value: objective, child: null };
    const child = await this.expand(pos.push(move), plies - 1, humanSides);
    return { move, uci, prob, objective, value: child.value, child };
  }

  // -- facts for explanations -----------------------------------------------

  traps(tricky, objective) {
    const traps = [];
    if (tricky.kind !== 'human') return traps;
    for (const e of tricky.edges) {
      if (e.objective - objective < this.settings.errorDrop) continue;
      let punishment = null;
      let findProb = 0;
      if (e.child && e.child.best) {
        punishment = e.child.best.move;
        const hit = e.child.edges.find(x => x.uci === moveUci(punishment));
        findProb = hit ? hit.prob : 0;
      }
      traps.push({ reply: e.move, prob: e.prob, objectiveAfter: e.objective, punishment, findProb, realized: e.value });
    }
    traps.sort((a, b) => b.prob - a.prob);
    return traps;
  }

  hardest(node, path, pathProb) {
    let found = null;
    if (node.kind === 'human' && node.pos.turn === this.players.user && node.best) {
      const bestValue = this.userWin(node.best, node.pos.turn);
      const expectedHere = node.edges.reduce((s, e) => s + e.prob * e.objective, 0) / node.covered;
      const loss = bestValue - expectedHere;
      const hit = node.edges.find(e => e.uci === moveUci(node.best.move));
      found = {
        path: [...path], pos: node.pos, needed: node.best.move, findProb: hit ? hit.prob : 0,
        loss, weight: pathProb * loss,
      };
    }
    for (const e of node.edges) {
      if (!e.child) continue;
      const sub = this.hardest(e.child, [...path, e.move], pathProb * (node.kind === 'human' ? e.prob : 1));
      if (sub && (!found || sub.weight > found.weight)) found = sub;
    }
    return found;
  }

  // -- entry point ------------------------------------------------------------

  async analyse(pos) {
    if (pos.turn !== this.players.user) throw new Error('analyse() expects a position with the user to move');
    const s = this.settings;
    let lines = await this.engine.analyse(pos, { multipv: s.multipv, depth: s.rootDepth, nodes: s.rootNodes });
    const best = lines[0];
    const threshold = marginWin(Math.max(s.marginCp, s.trickyMarginCp));
    lines = lines.filter(line => best.win - line.win <= threshold).slice(0, s.maxCandidates);

    const rootPolicy = new Map();
    for (const hm of await this.human.policy(pos, this.players.userElo, this.players.oppElo)) rootPolicy.set(moveUci(hm.move), hm.prob);
    const user = this.players.user;
    const candidates = [];
    for (const line of lines) {
      const child = pos.push(line.move);
      const simpleTree = await this.expand(child, s.simplePlies, new Set([user]));
      const trickyTree = await this.expand(child, s.trickyPlies, new Set([user, other(user)]));
      candidates.push({
        line,
        move: line.move,
        uci: line.uci,
        objective: line.win,
        simple: simpleTree.value,
        tricky: trickyTree.value,
        naturalness: rootPolicy.get(line.uci) ?? 0,
        traps: this.traps(trickyTree, line.win),
        errorProb: 0,
        hardest: this.hardest(simpleTree, [], 1),
      });
      const c = candidates[candidates.length - 1];
      c.errorProb = c.traps.reduce((sum, t) => sum + t.prob, 0);
    }
    return new PositionAnalysis(pos, this.players, candidates, marginWin(s.marginCp));
  }
}

export class PositionAnalysis {
  constructor(pos, players, candidates, simpleMargin = 100) {
    this.pos = pos;
    this.players = players;
    this.candidates = candidates; // best (objective) first, all within the tricky margin
    this.simpleMargin = simpleMargin; // win% points the simple move may give up
  }

  get best() { return this.candidates[0]; }

  get simpleCandidates() {
    return this.candidates.filter(c => this.best.objective - c.objective <= this.simpleMargin);
  }

  // Like Python's max(): the first of equal keys wins.
  get simplest() {
    return pickMax(this.simpleCandidates, c => [round1(c.simple), c.naturalness]);
  }

  get trickiest() {
    return pickMax(this.candidates, c => [round1(c.tricky), c.errorProb]);
  }
}

function pickMax(items, key) {
  let best = items[0];
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const k = key(item);
    if (k[0] > bestKey[0] || (k[0] === bestKey[0] && k[1] > bestKey[1])) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}
