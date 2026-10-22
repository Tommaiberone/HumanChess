// Centipawn <-> win-percentage conversions (Lichess accuracy model). Port of winprob.py.

const K = 0.00368208;

// Mate scores are mapped to this many centipawns (minus the distance to mate).
export const MATE_CP = 10_000;

export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-K * cp)) - 1);

export function cpFromWin(win) {
  const w = Math.min(Math.max(win, 0.01), 99.99);
  return -Math.log(2 / (1 + (w - 50) / 50) - 1) / K;
}

export const marginWin = marginCp => winPct(marginCp) - 50;

// Python's "%+.2f" rounds half to even on the binary value; toFixed does the same on doubles.
const signed2 = x => (x >= 0 ? '+' : '-') + Math.abs(x).toFixed(2);

// '+0.85', '-1.20', '#5', '#-3'. Stockfish reports mate distances in moves.
export function formatCp(cp) {
  if (Math.abs(cp) >= MATE_CP - 500) {
    const moves = Math.max(1, MATE_CP - Math.abs(cp));
    return cp > 0 ? `#${moves}` : `#-${moves}`;
  }
  return signed2(cp / 100);
}
