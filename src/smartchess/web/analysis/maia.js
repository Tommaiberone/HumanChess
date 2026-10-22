// Maia-3 move probabilities in the browser. Port of the encoding, decoding and cache of
// maia_np.py; the network itself runs on ONNX Runtime Web (scripts/export_onnx.py).

import { makeSquare } from 'chessops/util';
import { moveUci } from './position.js';

const HISTORY = 8; // positions the model sees, the current one last
const ROLE_INDEX = { pawn: 0, knight: 1, bishop: 2, rook: 3, queen: 4, king: 5 };
const PROMOTION_CHARS = 'qrbn';

// Moves are always seen from White's side (the board is mirrored for Black): every
// from-to pair in square order, then the promotions from rank 7 to rank 8.
const MOVE_INDEX = new Map();
for (let a = 0; a < 64; a++) for (let b = 0; b < 64; b++) MOVE_INDEX.set(makeSquare(a) + makeSquare(b), a * 64 + b);
{
  let i = 4096;
  for (const f of 'abcdefgh') for (const t of 'abcdefgh') for (const p of PROMOTION_CHARS) MOVE_INDEX.set(`${f}7${t}8${p}`, i++);
}
export const N_MOVES = MOVE_INDEX.size;

const mirrorUci = uci => `${uci[0]}${9 - Number(uci[1])}${uci[2]}${9 - Number(uci[3])}${uci.slice(4)}`;

/** Write the one-hot pieces of `pos`, from the side to move's point of view, into out[sq * stride + offset + channel]. */
function tokenize(pos, out, stride, offset) {
  const black = pos.turn === 'black';
  for (const [square, piece] of pos.board) {
    const sq = black ? square ^ 56 : square;
    const own = black ? piece.color === 'black' : piece.color === 'white';
    out[sq * stride + offset + ROLE_INDEX[piece.role] + (own ? 0 : 6)] = 1;
  }
}

/** (64, 12 * HISTORY) input: the last positions of the game, oldest first, the earliest repeated if short. */
export function encode(pos, out = new Float32Array(64 * 12 * HISTORY)) {
  const stride = 12 * HISTORY;
  const chain = [];
  for (let p = pos; p && chain.length < HISTORY; p = p.prev) chain.push(p);
  chain.reverse();
  while (chain.length < HISTORY) chain.unshift(chain[0]);
  chain.forEach((p, h) => tokenize(p, out, stride, h * 12));
  return out;
}

function softmax(values) {
  const max = Math.max(...values);
  const e = values.map(v => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / sum);
}

/** All legal moves with their probability, most likely first. */
export function decode(pos, logits) {
  const black = pos.turn === 'black';
  const moves = [];
  const picked = [];
  for (const m of pos.legalMoves()) {
    const uci = moveUci(m);
    const idx = MOVE_INDEX.get(black ? mirrorUci(uci) : uci);
    if (idx !== undefined) {
      moves.push(m);
      picked.push(logits[idx]);
    }
  }
  const probs = softmax(picked);
  return moves.map((move, i) => ({ move, prob: probs[i] })).sort((a, b) => b.prob - a.prob);
}

/** Smallest prefix of `policy` covering `mass`, capped at `maxMoves`. */
export function topMoves(policy, mass, maxMoves, minProb = 0.01) {
  const chosen = [];
  let total = 0;
  for (const hm of policy) {
    if (chosen.length >= maxMoves || total >= mass) break;
    if (chosen.length && hm.prob < minProb) break;
    chosen.push(hm);
    total += hm.prob;
  }
  return chosen;
}

export class Maia {
  /** `ort` is the onnxruntime-web module and `model` the ONNX file as bytes. */
  static async create(ort, model, options = {}) {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], ...options });
    return new Maia(ort, session);
  }

  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.cache = new Map();
  }

  clear() {
    this.cache.clear();
  }

  static cacheKey(pos, eloSelf, eloOppo) {
    return `${pos.fen()}|${pos.moveStack(HISTORY - 1).join(' ')}|${eloSelf}|${eloOppo}`;
  }

  async policy(pos, eloSelf, eloOppo) {
    return (await this.policyBatch([pos], eloSelf, eloOppo))[0];
  }

  async policyBatch(positions, eloSelf, eloOppo) {
    const keys = positions.map(p => Maia.cacheKey(p, eloSelf, eloOppo));
    const todo = positions.map((_, i) => i).filter(i => !this.cache.has(keys[i]) && !positions[i].isGameOver());
    if (todo.length) {
      const n = todo.length;
      const size = 64 * 12 * HISTORY;
      const tokens = new Float32Array(n * size);
      todo.forEach((i, row) => encode(positions[i], tokens.subarray(row * size, (row + 1) * size)));
      const { Tensor } = this.ort;
      const out = await this.session.run({
        tokens: new Tensor('float32', tokens, [n, 64, 12 * HISTORY]),
        elo_self: new Tensor('int64', BigInt64Array.from({ length: n }, () => BigInt(eloSelf)), [n]),
        elo_oppo: new Tensor('int64', BigInt64Array.from({ length: n }, () => BigInt(eloOppo)), [n]),
      });
      const logits = out.move.data;
      todo.forEach((i, row) => this.cache.set(keys[i], decode(positions[i], logits.subarray(row * N_MOVES, (row + 1) * N_MOVES))));
    }
    return keys.map(k => this.cache.get(k) ?? []);
  }
}
