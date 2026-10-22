// Where games come from: the public Chess.com and Lichess APIs, both of which allow
// requests from any web page. Results are Chess.com-shaped game records (see games.js).

const TIME_CLASS_TO_LICHESS = {
  rapid: 'rapid,classical', blitz: 'blitz', bullet: 'bullet,ultraBullet', daily: 'correspondence',
};
const LICHESS_SPEED = {
  ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'rapid', correspondence: 'daily',
};
const USERNAME = /^[A-Za-z0-9_-]{2,30}$/;

export class SourceError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function checkUsername(name) {
  if (!USERNAME.test(name)) throw new SourceError('That does not look like a username: use letters, digits, _ and - only', 400);
  return name;
}

async function getJson(url, what, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new SourceError(`Could not reach ${what}: check your connection`);
  }
  if (response.status === 404) throw new SourceError(`${what} user not found`, 404);
  if (response.status === 429) throw new SourceError(`${what} is busy: wait a minute and try again`, 429);
  if (!response.ok) throw new SourceError(`${what} answered ${response.status}`);
  return response;
}

/** Standard-chess games of a Chess.com user, newest first. */
export async function fetchChesscom(username, limit = 30, timeClass = '') {
  const name = checkUsername(username).toLowerCase();
  const archives = (await (await getJson(`https://api.chess.com/pub/player/${name}/games/archives`, 'Chess.com')).json()).archives ?? [];
  const games = [];
  for (const archive of archives.reverse()) {
    const month = (await (await getJson(archive, 'Chess.com')).json()).games ?? [];
    for (const g of month.reverse()) {
      if (g.rules !== 'chess' || !g.pgn) continue;
      if (timeClass && g.time_class !== timeClass) continue;
      games.push({ ...g, source: 'chess.com' });
      if (games.length >= limit) return games;
    }
  }
  return games;
}

function lichessRecord(g) {
  const result = color => {
    if (g.winner === color) return 'win';
    if (!g.winner) return g.status === 'stalemate' ? 'stalemate' : 'agreed';
    return { mate: 'checkmated', resign: 'resigned', outoftime: 'timeout', timeout: 'timeout' }[g.status] ?? 'resigned';
  };
  const player = color => {
    const p = g.players[color];
    return { username: p.user?.name ?? 'Anonymous', rating: p.rating, result: result(color) };
  };
  const clock = g.clock ? `${g.clock.initial}+${g.clock.increment}` : null;
  return {
    id: g.id,
    url: `https://lichess.org/${g.id}`,
    pgn: g.pgn,
    time_class: LICHESS_SPEED[g.speed] ?? g.speed,
    time_control: clock,
    end_time: Math.floor((g.lastMoveAt ?? g.createdAt) / 1000),
    white: player('white'),
    black: player('black'),
    opening: g.opening?.name ?? '',
    source: 'lichess',
  };
}

/** Standard-chess games of a Lichess user, newest first. */
export async function fetchLichess(username, limit = 30, timeClass = '') {
  const name = checkUsername(username);
  const params = new URLSearchParams({
    max: String(limit), pgnInJson: 'true', opening: 'true', moves: 'false', clocks: 'false', evals: 'false', finished: 'true',
  });
  if (timeClass && TIME_CLASS_TO_LICHESS[timeClass]) params.set('perfType', TIME_CLASS_TO_LICHESS[timeClass]);
  let response;
  try {
    response = await getJson(`https://lichess.org/api/games/user/${name}?${params}`, 'Lichess', {
      headers: { Accept: 'application/x-ndjson' },
    });
  } catch (e) {
    if (e.status !== 404) throw e;
    // The export answers 404 for an unknown user, but also when it refuses a request.
    const exists = await fetch(`https://lichess.org/api/user/${name}`).then(r => r.ok, () => false);
    if (exists) throw new SourceError('Lichess did not hand over the games of this account: try again later, or paste a game as a PGN');
    throw e;
  }
  return (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(g => g.variant === 'standard' && g.pgn && g.players?.white && g.players?.black)
    .map(lichessRecord);
}

/** A game pasted as PGN, as a record the app can list and review. */
export function pgnRecord(text, headers, id, userColor) {
  const result = headers.Result;
  const outcome = color => (result === (color === 'white' ? '1-0' : '0-1') ? 'win' : result === '1/2-1/2' ? 'agreed' : 'resigned');
  const rating = h => (/^\d+$/.test(h ?? '') ? Number(h) : null);
  return {
    id,
    url: null,
    pgn: text,
    time_class: null,
    time_control: null,
    end_time: null,
    white: { username: headers.White ?? 'White', rating: rating(headers.WhiteElo), result: outcome('white') },
    black: { username: headers.Black ?? 'Black', rating: rating(headers.BlackElo), result: outcome('black') },
    opening: headers.Opening ?? '',
    user_color: userColor,
    source: 'pgn',
  };
}

/** A short stable id for a pasted PGN: "p" and 12 hex digits of its SHA-256. */
export async function pgnId(text) {
  const bytes = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'p' + [...new Uint8Array(digest).slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}
