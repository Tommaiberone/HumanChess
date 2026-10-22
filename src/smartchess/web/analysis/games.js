// Games as the app handles them: parsing a PGN, summarising it for the game list, and
// the moves for the board. Port of the pure parts of importers.py and service.py.
//
// A game record is shaped like Chess.com's API object: {id?, url?, pgn, time_class,
// time_control, end_time, white: {username, rating, result}, black: {...}} plus the
// optional app fields user_color, title, demo, opening and key_plies.

import { makeUci } from 'chessops/util';
import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { Pos, standardMove } from './position.js';
import { DEFAULT_ELO } from './review.js';
import { toMaiaElo } from './ratings.js';

const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

/** {headers, startFen, moves: [uci]} of the first game of a PGN. Throws on invalid input. */
export function parseGame(text) {
  const games = parsePgn(text);
  if (!games.length) throw new Error('Invalid PGN');
  const game = games[0];
  const headers = Object.fromEntries(game.headers);
  if (headers.Variant && headers.Variant.toLowerCase() !== 'standard') throw new Error('Only standard chess is supported');
  const chess = startingPosition(game.headers).unwrap();
  const startFen = new Pos(chess.clone()).fen();
  const moves = [];
  for (const node of game.moves.mainline()) {
    const move = parseSan(chess, node.san);
    if (!move) throw new Error(`Illegal move in the PGN: ${node.san}`);
    moves.push(makeUci(standardMove(chess, move)));
    chess.play(move);
  }
  if (!moves.length) throw new Error('The game has no moves');
  return { headers, startFen, moves };
}

export function gameId(raw) {
  return raw.id || raw.url.replace(/\/+$/, '').split('/').pop();
}

/** The fields the game list needs, from the user's point of view. */
export function gameSummary(g, username) {
  const name = username.toLowerCase();
  const userIsWhite = g.user_color ? g.user_color === 'white' : g.white.username.toLowerCase() === name;
  const [me, opp] = userIsWhite ? [g.white, g.black] : [g.black, g.white];
  const result = me.result === 'win' ? 'win' : DRAW_RESULTS.has(me.result) ? 'draw' : 'loss';
  const opening = g.opening || (g.eco || '').replace(/\/+$/, '').split('/').pop().replaceAll('-', ' ');
  return {
    id: gameId(g),
    url: g.url ?? null,
    demo: !!g.demo,
    title: g.title ?? null,
    end_time: g.end_time ?? null,
    time_class: g.time_class ?? null,
    time_control: g.time_control ?? null,
    user_color: userIsWhite ? 'white' : 'black',
    username: me.username,
    user_rating: me.rating ?? null,
    opponent: opp.username,
    opponent_rating: opp.rating ?? null,
    result,
    result_detail: result !== 'win' ? me.result : opp.result,
    opening,
    source: g.source ?? 'chess.com',
  };
}

const headerElo = (headers, color) => {
  const v = headers[color === 'white' ? 'WhiteElo' : 'BlackElo'];
  return /^\d+$/.test(v ?? '') ? Number(v) : null;
};

/** Ratings on the Maia scale, from the PGN headers (the user's, then the opponent's). */
export function gamePlayers(headers, color) {
  const site = headers.Site ?? '';
  const raw = headerElo(headers, color);
  const userElo = raw ? toMaiaElo(raw, site) : DEFAULT_ELO;
  const rawOpp = headerElo(headers, color === 'white' ? 'black' : 'white');
  return { user: color, userElo, oppElo: rawOpp ? toMaiaElo(rawOpp, site) : userElo };
}

/** The game's moves for the board, before any analysis exists. */
export function gameMoves(raw, username) {
  const parsed = parseGame(raw.pgn);
  let pos = Pos.fromFen(parsed.startFen);
  const plies = parsed.moves.map((uci, ply) => {
    const before = pos;
    pos = pos.pushUci(uci);
    return {
      ply, san: before.sanUci(uci), uci, color: before.turn, move_number: before.fullmoves,
      fen_before: before.fen(), fen_after: pos.fen(),
    };
  });
  const summary = gameSummary(raw, username);
  const players = gamePlayers(parsed.headers, summary.user_color);
  summary.user_maia_elo = players.userElo;
  summary.opp_maia_elo = players.oppElo;
  return { summary, start_fen: parsed.startFen, plies };
}
