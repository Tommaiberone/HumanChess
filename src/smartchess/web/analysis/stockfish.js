// Stockfish over UCI, with the caching of engine.py: every search is remembered by
// position, and a search's principal variation also gives the eval and best reply of
// every position along it, so the expectimax rarely has to search a child again.
//
// The engine is reached through a transport {send(line), onLine(callback)}: a Web
// Worker running stockfish.js in the browser, a Node adapter in tests.

import { MATE_CP, winPct } from './winprob.js';
import { moveUci, parseMove } from './position.js';

export class LineEval {
  constructor(move, cp, pv) {
    this.move = move;
    this.cp = cp;
    this.pv = pv; // moves, the first one is `move`
  }

  get win() { return winPct(this.cp); }
  get uci() { return moveUci(this.move); }
}

function parseScore(tokens) {
  const i = tokens.indexOf('score');
  if (i < 0) return null;
  const n = Number(tokens[i + 2]);
  if (tokens[i + 1] === 'cp') return n;
  if (tokens[i + 1] === 'mate') return n > 0 ? MATE_CP - n : -MATE_CP - n;
  return null;
}

export class Stockfish {
  /**
   * Every search stops at its depth or at `maxNodes`, whichever comes first (the time
   * cap is only a safety net): a search does the same work on every device, so a
   * review comes out the same wherever it runs.
   */
  constructor(transport, { depth = 12, hashMb = 16, maxNodes = 2_000_000, maxMs = 60_000 } = {}) {
    this.transport = transport;
    this.depth = depth;
    this.hashMb = hashMb;
    this.maxNodes = maxNodes;
    this.maxMs = maxMs;
    this.multipv = 1;
    this.waiting = null;
    this.info = new Map();
    this.searches = 0;
    this.nodes = 0;
    this.clearCaches();
    transport.onLine(line => this._line(line));
  }

  clearCaches() {
    this.bestLines = new Map();
    this.bestDepth = new Map();
    this.moveLines = new Map();
  }

  _line(line) {
    if (line.startsWith('info ')) {
      const tokens = line.split(' ');
      if (!tokens.includes('pv') || line.includes('lowerbound') || line.includes('upperbound')) return;
      const score = parseScore(tokens);
      if (score === null) return;
      const mi = tokens.indexOf('multipv');
      const ni = tokens.indexOf('nodes');
      this.info.set(mi < 0 ? 1 : Number(tokens[mi + 1]), {
        cp: score, pv: tokens.slice(tokens.indexOf('pv') + 1), nodes: ni < 0 ? 0 : Number(tokens[ni + 1]),
      });
    }
    if (this.waiting && this.waiting.test(line)) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(line);
    }
  }

  _until(test, ms) {
    return new Promise((resolve, reject) => {
      const timer = ms && setTimeout(() => reject(new Error('Stockfish did not answer')), ms);
      this.waiting = { test, resolve: line => { clearTimeout(timer); resolve(line); } };
    });
  }

  async init() {
    let ready = this._until(l => l === 'uciok', 30_000);
    this.transport.send('uci');
    await ready;
    this.transport.send(`setoption name Hash value ${this.hashMb}`);
    ready = this._until(l => l === 'readyok', 30_000);
    this.transport.send('isready');
    await ready;
  }

  /** Forget everything searched so far (the hash too), so the next search does not depend on earlier ones. */
  async newGame() {
    this.clearCaches();
    const ready = this._until(l => l === 'readyok', 30_000);
    this.transport.send('ucinewgame');
    this.transport.send('isready');
    await ready;
  }

  close() {
    this.transport.send('quit');
  }

  /** Lines sorted best first (side-to-move point of view). */
  async analyse(pos, { multipv = 1, moves = null, depth = null, nodes = null } = {}) {
    if (moves) multipv = moves.length;
    multipv = Math.max(1, Math.min(multipv, pos.legalCount()));
    depth = depth || this.depth;
    if (multipv !== this.multipv) {
      this.transport.send(`setoption name MultiPV value ${multipv}`);
      this.multipv = multipv;
    }
    const stack = pos.moveStack();
    let root = pos;
    while (root.prev) root = root.prev;
    this.transport.send(`position fen ${root.fen()}${stack.length ? ` moves ${stack.join(' ')}` : ''}`);
    this.info = new Map();
    const done = this._until(l => l.startsWith('bestmove'), this.maxMs + 30_000);
    // `searchmoves` must come last: Stockfish reads every token after it as a move.
    const searchmoves = moves ? ` searchmoves ${moves.map(moveUci).join(' ')}` : '';
    this.transport.send(`go depth ${depth} nodes ${nodes || this.maxNodes} movetime ${this.maxMs}${searchmoves}`);
    await done;
    this.searches++;
    const lines = [];
    for (const info of this.info.values()) {
      this.nodes += info.nodes;
      lines.push(new LineEval(parseMove(info.pv[0]), info.cp, info.pv.map(parseMove)));
    }
    lines.sort((a, b) => b.cp - a.cp);
    this._remember(pos, lines, moves === null, depth);
    return lines;
  }

  _setBest(key, line, depth) {
    // Keep whichever search looked deeper at this position.
    if (depth > (this.bestDepth.get(key) ?? -1)) {
      this.bestLines.set(key, line);
      this.bestDepth.set(key, depth);
    }
  }

  _remember(pos, lines, complete, depth) {
    const key = pos.key();
    for (const line of lines) {
      this.moveLines.set(`${key}|${line.uci}`, line);
      // Every position along a PV has the same minimax value, with the sign flipping
      // each ply, and its best move is the next PV move.
      let p = pos;
      let cp = line.cp;
      for (let i = 0; i < line.pv.length - 1; i++) {
        p = p.push(line.pv[i]);
        cp = -cp;
        this._setBest(p.key(), new LineEval(line.pv[i + 1], cp, line.pv.slice(i + 1)), depth - i - 1);
      }
    }
    if (complete && lines.length) this._setBest(key, lines[0], depth);
  }

  async best(pos) {
    const key = pos.key();
    if (!this.bestLines.has(key)) await this.analyse(pos);
    return this.bestLines.get(key);
  }

  /** Map uci -> LineEval for each of `moves`. */
  async evaluateMoves(pos, moves) {
    const key = pos.key();
    const known = m => this.moveLines.has(`${key}|${moveUci(m)}`);
    const missing = moves.filter(m => !known(m));
    if (missing.length) await this.analyse(pos, { moves: missing, nodes: this.maxNodes });
    // Stockfish occasionally drops a root move from a MultiPV answer.
    for (const m of moves) {
      if (!known(m)) await this.analyse(pos, { moves: [m] });
    }
    return new Map(moves.map(m => [moveUci(m), this.moveLines.get(`${key}|${moveUci(m)}`)]));
  }
}
