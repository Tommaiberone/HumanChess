// Map platform ratings to the scale Maia-3 was trained on (Lichess blitz). Port of ratings.py.

// (Chess.com rating, Maia/Lichess-equivalent rating)
const CHESSCOM_TABLE = [[400, 900], [800, 1200], [1000, 1400], [1400, 1700], [1800, 1975], [2200, 2275], [2600, 2600]];

// Python's round(): halves go to the even neighbour.
function roundHalfEven(x) {
  const floor = Math.floor(x);
  if (x - floor !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

function interpolate(table, x) {
  if (x <= table[0][0]) return table[0][1] - (table[0][0] - x);
  for (let i = 0; i + 1 < table.length; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (x <= x1) return roundHalfEven(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  const [lastX, lastY] = table[table.length - 1];
  return roundHalfEven(lastY + (x - lastX));
}

export function toMaiaElo(rating, site = '') {
  return site.toLowerCase().includes('chess.com') ? interpolate(CHESSCOM_TABLE, rating) : rating;
}
