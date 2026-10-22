// A chess position with its history, on top of chessops: the part of python-chess that
// the analysis uses (move stack for Maia and repetitions, python-chess move order, SAN).
//
// Moves are {from, to, promotion?} with castling as the king moving two squares (what
// UCI engines and Maia use); chessops' own "king takes rook" form never leaves this file.

import { Chess, castlingSide } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan, makeSanVariation } from 'chessops/san';
import { makeUci, parseUci, makeSquare, squareFile, squareRank, opposite, kingCastlesTo } from 'chessops/util';
import { pawnAttacks } from 'chessops/attacks';

export const WHITE = 'white';
export const BLACK = 'black';
export const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

const PROMOTION_ORDER = ['queen', 'rook', 'bishop', 'knight'];

export const moveUci = makeUci;
export const sqName = makeSquare;

/** chessops writes castling as "king takes own rook": give it as the king's two-square move. */
export function standardMove(chess, move) {
  const side = castlingSide(chess, move);
  return side && chess.board[chess.turn].has(move.to) ? { from: move.from, to: kingCastlesTo(chess.turn, side) } : move;
}

export function parseMove(uci) {
  const m = parseUci(uci);
  if (!m) throw new Error(`Bad move ${uci}`);
  return m;
}

export class Pos {
  constructor(chess, prev = null, lastUci = null) {
    this.chess = chess;
    this.prev = prev;
    this.lastUci = lastUci;
    this._fen = null;
    this._key = null;
  }

  static fromFen(fen) {
    const setup = parseFen(fen).unwrap();
    return new Pos(Chess.fromSetup(setup).unwrap());
  }

  static start() {
    return new Pos(Chess.default());
  }

  get turn() { return this.chess.turn; }
  get board() { return this.chess.board; }
  get fullmoves() { return this.chess.fullmoves; }
  get halfmoves() { return this.chess.halfmoves; }

  /** FEN as python-chess writes it: the en passant square only when a capture is legal. */
  fen() {
    if (this._fen === null) {
      const setup = this.chess.toSetup();
      if (setup.epSquare !== undefined && !this._epCapturePossible()) setup.epSquare = undefined;
      this._fen = makeFen(setup);
    }
    return this._fen;
  }

  _epCapturePossible() {
    const ep = this.chess.epSquare;
    const pawns = pawnAttacks(opposite(this.turn), ep).intersect(this.board.pawn).intersect(this.board[this.turn]);
    for (const from of pawns) if (this.chess.dests(from).has(ep)) return true;
    return false;
  }

  /** Position part of the FEN, side to move, castling and en passant: what repetition compares. */
  key() {
    return this._key ??= this.fen().split(' ').slice(0, 4).join(' ');
  }

  push(move) {
    const next = this.chess.clone();
    next.play(move);
    return new Pos(next, this, makeUci(move));
  }

  pushUci(uci) {
    return this.push(parseMove(uci));
  }

  /** The same position with the other side to move, or null if that is not a legal position. */
  nullMove() {
    const setup = this.chess.toSetup();
    setup.turn = opposite(setup.turn);
    setup.epSquare = undefined;
    const result = Chess.fromSetup(setup);
    return result.isOk ? new Pos(result.value) : null;
  }

  /** The moves played to reach this position, oldest first (as python-chess's move_stack). */
  moveStack(limit = Infinity) {
    const out = [];
    for (let p = this; p.prev && out.length < limit; p = p.prev) out.push(p.lastUci);
    return out.reverse();
  }

  isCheck() { return this.chess.isCheck(); }
  isCheckmate() { return this.chess.isCheckmate(); }

  /** Legal moves in python-chess's generation order, castling as the king's two-square move. */
  legalMoves() {
    const pos = this.chess;
    const turn = this.turn;
    const nonPawn = [], castles = [], captures = [], singles = [], doubles = [], enPassant = [];
    for (const [from, dests] of pos.allDests()) {
      const piece = this.board.get(from);
      for (const to of dests) {
        if (piece.role === 'king' && this.board[turn].has(to)) {
          // chessops lists castling as "king takes own rook": write it as the king's move.
          const side = to > from ? 'h' : 'a';
          castles.push({ from, to: kingCastlesTo(turn, side) });
        } else if (piece.role !== 'pawn') {
          nonPawn.push({ from, to });
        } else {
          const promotes = squareRank(to) === 0 || squareRank(to) === 7;
          const variants = promotes ? PROMOTION_ORDER.map(promotion => ({ from, to, promotion })) : [{ from, to }];
          if (squareFile(from) !== squareFile(to)) {
            (this.board.occupied.has(to) ? captures : enPassant).push(...variants);
          } else {
            (Math.abs(to - from) === 16 ? doubles : singles).push(...variants);
          }
        }
      }
    }
    const desc = (a, b) => b.from - a.from || b.to - a.to;
    const promo = (a, b) => PROMOTION_ORDER.indexOf(a.promotion) - PROMOTION_ORDER.indexOf(b.promotion);
    nonPawn.sort(desc);
    castles.sort((a, b) => b.to - a.to);
    captures.sort((a, b) => desc(a, b) || promo(a, b));
    const byTo = (a, b) => b.to - a.to || promo(a, b);
    singles.sort(byTo);
    doubles.sort(byTo);
    enPassant.sort(desc);
    return [...nonPawn, ...castles, ...captures, ...singles, ...doubles, ...enPassant];
  }

  legalCount() {
    let n = 0;
    for (const [from, dests] of this.chess.allDests()) {
      const piece = this.board.get(from);
      const promotes = piece.role === 'pawn' && squareRank(from) === (piece.color === WHITE ? 6 : 1);
      n += promotes ? dests.size() * 4 : dests.size();
    }
    return n;
  }

  /** python-chess's is_game_over(claim_draw=True), with the outcome's winner (null: a draw). */
  result() {
    const c = this.chess;
    if (c.isCheckmate()) return { over: true, winner: opposite(c.turn) };
    if (c.isStalemate() || c.isInsufficientMaterial()) return { over: true, winner: null };
    if (c.halfmoves >= 100) return { over: true, winner: null };
    if (c.halfmoves >= 8 && this._repetitions() >= 3) return { over: true, winner: null };
    return { over: false, winner: null };
  }

  _repetitions() {
    let count = 1;
    const key = this.key();
    let p = this.prev;
    for (let back = 1; p && back <= this.halfmoves; back++, p = p.prev) {
      if (back % 2 === 0 && p.key() === key) count++;
    }
    return count;
  }

  isGameOver() { return this.result().over; }

  san(move) { return makeSan(this.chess, move); }
  sanUci(uci) { return this.san(parseMove(uci)); }

  /** python-chess's variation_san: "14. Nf3 Nf6 15. d4", or "14... Nf6 15. d4". */
  variationSan(moves) {
    return makeSanVariation(this.chess, moves).replace(/^(\d+)\.\.\. /, '$1...');
  }

  /** The move as "12.Nf3" or "12...Nf6". */
  numbered(move) {
    return `${this.fullmoves}${this.turn === WHITE ? '.' : '...'}${this.san(move)}`;
  }

  isEnPassant(move) {
    const piece = this.board.get(move.from);
    return piece?.role === 'pawn' && squareFile(move.from) !== squareFile(move.to) && !this.board.occupied.has(move.to);
  }

  isCapture(move) {
    return this.board.occupied.has(move.to) || this.isEnPassant(move);
  }

  isCastling(move) {
    return this.board.get(move.from)?.role === 'king' && Math.abs(squareFile(move.to) - squareFile(move.from)) === 2;
  }

  attackedBy(color, square) {
    return this.chess.kingAttackers(square, color, this.board.occupied).nonEmpty();
  }

  attackersOf(color, square) {
    return this.chess.kingAttackers(square, color, this.board.occupied);
  }
}
