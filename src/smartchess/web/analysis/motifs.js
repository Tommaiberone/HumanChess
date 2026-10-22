// Tactical and positional themes, in the second person. Port of motifs.py: cheap board
// facts (no engine) that explain why a move works, with ownership always explicit.

import { attacks, between, ray, bishopAttacks, rookAttacks } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import { opposite, squareFile, squareRank, squareFromCoords } from 'chessops/util';
import { WHITE, sqName } from './position.js';

const VALUES = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };
const PLURALS = {
  queen: ['queen', 'queens'], rook: ['rook', 'rooks'], bishop: ['bishop', 'bishops'],
  knight: ['knight', 'knights'], pawn: ['pawn', 'pawns'],
};
const SLIDERS = ['bishop', 'rook', 'queen'];
// A capture or threat must win at least this much material (in pawns) to be worth saying.
const MIN_GAIN = 2;

const theirs = (role, square) => `the opponent's ${role} on ${sqName(square)}`;
const yours = (role, square) => `your ${role} on ${sqName(square)}`;
const yourRole = role => `your ${role}`;

/** Pieces of `color` that can really take on `square`: a pinned piece cannot, unless the square is on its pin line. */
function realAttackers(pos, color, square) {
  const out = [];
  for (const a of pos.attackersOf(color, square)) {
    const line = pinLine(pos, color, a);
    if (line && !line.has(square)) continue;
    out.push(a);
  }
  return out;
}

/** The line a pinned piece must stay on, or null when it is not pinned (python-chess's pin_mask). */
export function pinLine(pos, color, square) {
  const b = pos.board;
  const king = b.kingOf(color);
  if (king === undefined) return null;
  const none = SquareSet.empty();
  const snipers = rookAttacks(king, none).intersect(b.rooksAndQueens())
    .union(bishopAttacks(king, none).intersect(b.bishopsAndQueens()))
    .intersect(b[opposite(color)]);
  for (const sniper of [...snipers].reverse()) {
    const blockers = between(sniper, king).intersect(b.occupied).without(square);
    if (blockers.isEmpty() && between(sniper, king).has(square)) return ray(king, sniper);
  }
  return null;
}

const isPinned = (pos, color, square) => pinLine(pos, color, square) !== null;

/** Attacked by the other side and not defended by its own. */
function hanging(pos, square) {
  const piece = pos.board.get(square);
  return !!piece && realAttackers(pos, opposite(piece.color), square).length > 0 && !pos.attackedBy(piece.color, square);
}

function worthAttacking(pos, targetSquare, attackerRole) {
  const target = pos.board.get(targetSquare);
  if (!target || target.role === 'king') return false;
  return hanging(pos, targetSquare) || VALUES[target.role] > VALUES[attackerRole];
}

/** Rough material won by a capture: the victim, minus the attacker if the square is defended. */
export function captureGain(pos, move) {
  const attacker = pos.board.get(move.from);
  let victimValue;
  if (pos.isEnPassant(move)) {
    victimValue = VALUES.pawn;
  } else {
    const victim = pos.board.get(move.to);
    if (!victim) return 0;
    victimValue = VALUES[victim.role];
  }
  const defended = pos.attackedBy(opposite(pos.turn), move.to);
  return victimValue - (defended ? VALUES[attacker.role] : 0);
}

/**
 * What `color` could do if it were its turn now: mates in one and winning captures.
 * Returns [{move, victim (role, null for a mate), pos}], best first.
 */
export function threats(pos, color, limit = 2) {
  let b = pos;
  if (b.turn !== color) {
    if (b.isCheck()) return []; // the side in check has no time to pass
    b = b.nullMove();
    if (!b) return [];
  }
  const found = [];
  for (const m of b.legalMoves()) {
    const after = b.push(m);
    if (after.isCheck() && after.isCheckmate()) {
      found.push({ gain: 1000, move: m, victim: null });
    } else if (b.isCapture(m) && captureGain(b, m) >= MIN_GAIN) {
      const victim = b.isEnPassant(m) ? 'pawn' : b.board.get(m.to).role;
      found.push({ gain: captureGain(b, m), move: m, victim });
    }
  }
  found.sort((x, y) => y.gain - x.gain); // stable, like Python's sort
  return found.slice(0, limit).map(({ move, victim }) => ({ move, victim, pos: b }));
}

function isPassed(pos, square, color) {
  const file = squareFile(square), rank = squareRank(square);
  for (let f = file - 1; f <= file + 1; f++) {
    if (f < 0 || f > 7) continue;
    for (let r = color === WHITE ? rank + 1 : 0; r < (color === WHITE ? 8 : rank); r++) {
      const p = pos.board.get(squareFromCoords(f, r));
      if (p && p.role === 'pawn' && p.color !== color) return false;
    }
  }
  return true;
}

function cheaperAttacker(pos, square) {
  const piece = pos.board.get(square);
  return realAttackers(pos, opposite(piece.color), square).some(a => VALUES[pos.board.get(a).role] < VALUES[piece.role]);
}

// Squares attacked by the piece on `square` (none if the square is empty), own pieces included.
const piecesAttacked = (pos, square) => {
  const p = pos.board.get(square);
  return p ? attacks(p, square, pos.board.occupied) : SquareSet.empty();
};

/** Themes of a move by the side to move (the user), most telling first. */
export function moveMotifs(pos, move, limit = 7) {
  const out = [];
  const mover = pos.turn;
  const opp = opposite(mover);
  const piece = pos.board.get(move.from);
  if (!piece) return out;
  const nxt = pos.push(move);
  const to = move.to;

  // What the move does immediately.
  if (pos.isCastling(move)) {
    out.push('you castle');
  } else if (pos.isCapture(move)) {
    out.push(pos.isEnPassant(move) ? 'you capture a pawn en passant' : `you capture ${theirs(pos.board.get(to).role, to)}`);
  }
  if (move.promotion) out.push(`you promote to a ${PLURALS[move.promotion][0]}`);
  if (nxt.isCheck() && nxt.isCheckmate()) return [...out, 'checkmate'];

  // Discovered attacks and checks by the pieces behind the moved one.
  const discovered = [];
  const discoveredTargets = [];
  const sliders = pos.board.bishop.union(pos.board.rook).union(pos.board.queen).intersect(pos.board[mover]);
  for (const sq of sliders) {
    if (sq === move.from) continue;
    const added = piecesAttacked(nxt, sq).diff(piecesAttacked(pos, sq)).intersect(nxt.board[opp]);
    const slider = pos.board.get(sq).role;
    for (const t of added) {
      const target = nxt.board.get(t);
      if (target.role === 'king') {
        discovered.push(`discovered check with ${yours(slider, sq)}`);
      } else if (worthAttacking(nxt, t, slider)) {
        discovered.push(`you uncover an attack by ${yours(slider, sq)} on ${theirs(target.role, t)}`);
        discoveredTargets.push(t);
      }
    }
  }
  const oppKing = nxt.board.kingOf(opp);
  const directCheck = nxt.isCheck() && nxt.attackersOf(mover, oppKing).has(to);

  // Fork, or single attacks, by the moved piece.
  const targets = [...piecesAttacked(nxt, to).intersect(nxt.board[opp])].filter(t => worthAttacking(nxt, t, piece.role));
  const names = targets.map(t => theirs(nxt.board.get(t).role, t));
  if (directCheck && !names.length) out.push('you give check');
  if (directCheck && names.length) {
    out.push(`fork: you give check and attack ${names.join(' and ')}`);
  } else if (names.length >= 2) {
    out.push(`fork: you attack ${names.join(' and ')}`);
  } else {
    targets.forEach((t, i) => {
      out.push(`you attack ${names[i]} ` + (hanging(nxt, t) ? '(undefended)' : 'with a less valuable piece'));
    });
  }
  out.push(...discovered);

  // Pins to the king created by the moved piece.
  if (SLIDERS.includes(piece.role)) {
    for (const sq of nxt.board[opp]) {
      const p = nxt.board.get(sq);
      if (p.role !== 'king') {
        const line = pinLine(nxt, opp, sq);
        if (line && line.has(to)) out.push(`you pin ${theirs(p.role, sq)} to the king`);
      }
    }
  }

  // New threats: what you could win next if the opponent ignored the move. Captures of
  // pieces already named as attacked above would only repeat them.
  const before = new Set();
  for (const m of pos.legalMoves()) {
    if (pos.isCapture(m) && captureGain(pos, m) >= MIN_GAIN) before.add(`${m.from}-${m.to}-${m.promotion ?? ''}`);
  }
  const named = new Set([...targets, ...discoveredTargets]);
  for (const { move: m, victim, pos: b } of threats(nxt, mover)) {
    if (before.has(`${m.from}-${m.to}-${m.promotion ?? ''}`) || (victim !== null && named.has(m.to))) continue;
    const what = victim === null ? 'checkmate' : `to win ${theirs(victim, m.to)}`;
    out.push(`you threaten ${b.san(m)} (${what})`);
  }

  // Safety: rescuing the moved piece, or defending another one.
  if (piece.role !== 'king' && realAttackers(pos, opp, move.from).length
    && (hanging(pos, move.from) || cheaperAttacker(pos, move.from)) && !hanging(nxt, to)) {
    out.push(`you rescue ${yourRole(piece.role)}, which was under attack`);
  }
  const reach = piecesAttacked(nxt, to);
  for (const sq of nxt.board[mover]) {
    if (sq !== to && hanging(pos, sq) && !hanging(nxt, sq) && reach.has(sq)) {
      out.push(`you defend ${yours(nxt.board.get(sq).role, sq)}`);
    }
  }

  // Structure and activity.
  if (piece.role === 'pawn' && isPassed(nxt, to, mover)) out.push(`your pawn on ${sqName(to)} is passed`);
  if (piece.role === 'rook' && squareFile(move.from) !== squareFile(to)) {
    const file = squareFile(to);
    const filePieces = Array.from({ length: 8 }, (_, r) => nxt.board.get(squareFromCoords(file, r)));
    const own = filePieces.some(p => p && p.role === 'pawn' && p.color === mover);
    const their = filePieces.some(p => p && p.role === 'pawn' && p.color === opp);
    const column = 'abcdefgh'[file];
    if (!own && !their) out.push(`your rook takes the open ${column}-file`);
    else if (!own) out.push(`your rook takes the half-open ${column}-file`);
  }
  const backRank = mover === WHITE ? 0 : 7;
  if ((piece.role === 'knight' || piece.role === 'bishop') && squareRank(move.from) === backRank && pos.fullmoves <= 15) {
    out.push(`you develop ${yourRole(piece.role)}`);
  }
  if (piece.role !== 'king' && hanging(nxt, to)) out.push(`${yours(piece.role, to)} is left attacked and undefended`);
  return out.slice(0, limit);
}

/** What the opponent threatens in the position, with the user to move. */
export function opponentThreats(pos) {
  const out = [];
  for (const { move, victim, pos: b } of threats(pos, opposite(pos.turn))) {
    out.push(victim === null
      ? `the opponent threatens ${b.san(move)} (checkmate)`
      : `the opponent threatens ${b.san(move)}, winning ${yours(victim, move.to)}`);
  }
  return out;
}

export function material(pos, color) {
  let total = 0;
  for (const [, p] of pos.board) if (p.color === color && p.role !== 'king') total += VALUES[p.role];
  return total;
}

export function piecesSummary(pos, color) {
  const parts = [];
  for (const role of ['queen', 'rook', 'bishop', 'knight', 'pawn']) {
    const n = pos.board.pieces(color, role).size();
    if (n) parts.push(n === 1 ? PLURALS[role][0] : `${n} ${PLURALS[role][1]}`);
  }
  return parts.join(', ') || 'only the king';
}

