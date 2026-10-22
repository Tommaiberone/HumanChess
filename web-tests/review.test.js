import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pos, moveUci } from '../src/smartchess/web/analysis/position.js';
import { reviewGame } from '../src/smartchess/web/analysis/review.js';
import { gamePlayers, gameSummary, gameMoves, parseGame } from '../src/smartchess/web/analysis/games.js';
import { toMaiaElo } from '../src/smartchess/web/analysis/ratings.js';

const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "me"]
[Black "you"]
[WhiteElo "1400"]
[BlackElo "1000"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 6. Bg5 h6 7. Bh4 g5 8. Bg3 Bg4 9. h3 Bxf3 10. Qxf3 Nd4 11. Qd1 Nxc2 12. Qxc2 *
`;

test('a PGN becomes UCI moves with castling as the king move', () => {
  const g = parseGame(PGN);
  assert.equal(g.moves[6], 'e1g1');
  assert.equal(g.moves.length, 23);
  assert.equal(g.startFen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.throws(() => parseGame('not a game'), /no moves|Invalid/);
});

test('ratings are converted to the Maia scale like in Python', () => {
  assert.equal(toMaiaElo(1400, 'Chess.com'), 1700);
  assert.equal(toMaiaElo(1006, 'chess.com'), 1404); // 1404.5 rounds to the even neighbour
  assert.equal(toMaiaElo(300, 'chess.com'), 800);
  assert.equal(toMaiaElo(1500, 'https://lichess.org/abc'), 1500);
  const p = gamePlayers(parseGame(PGN).headers, 'white');
  assert.deepEqual(p, { user: 'white', userElo: 1700, oppElo: 1400 });
});

test('the game list and the board get what they need from a Chess.com record', () => {
  const raw = {
    url: 'https://www.chess.com/game/live/123', pgn: PGN, time_class: 'rapid', time_control: '600', end_time: 1,
    white: { username: 'Me', rating: 1400, result: 'win' }, black: { username: 'you', rating: 1000, result: 'resigned' },
    eco: 'https://www.chess.com/openings/Italian-Game-Giuoco-Piano',
  };
  const s = gameSummary(raw, 'me');
  assert.equal(s.id, '123');
  assert.equal(s.result, 'win');
  assert.equal(s.user_color, 'white');
  assert.equal(s.opening, 'Italian Game Giuoco Piano');
  const m = gameMoves(raw, 'me');
  assert.equal(m.plies.length, 23);
  assert.equal(m.plies[6].san, 'O-O');
  assert.equal(m.summary.user_maia_elo, 1700);
  assert.equal(gameSummary(raw, 'YOU').user_color, 'black');
});

// A stand-in for the engines: every position is level except the ones listed.
function fakeRunner(game, { blunderPly }) {
  const calls = [];
  return {
    calls,
    async run(type, task) {
      calls.push(type);
      if (type === 'quick') {
        let pos = Pos.fromFen(task.startFen);
        for (const u of task.moves) pos = pos.pushUci(u);
        const legal = pos.legalMoves().map(moveUci);
        // The best move keeps a small edge; the move actually played at `blunderPly` is much worse.
        const lines = legal.slice(0, task.multipv).map((uci, i) => ({ uci, cp: 30 - 5 * i, pv: [uci] }));
        if (task.moves.length === blunderPly) {
          const played = game.moves[blunderPly];
          return { lines: [{ uci: 'x', cp: 30, pv: [] }, ...lines.slice(1)].map((l, i) => (i === 0 ? { ...lines[0], cp: 400 } : l)), policy: task.policy ? {} : null, played };
        }
        return { lines, policy: task.policy ? Object.fromEntries(lines.map(l => [l.uci, 0.1])) : null };
      }
      return {
        bestCp: 400, playedCp: -50, gain: 0, roles: { best: 'a2a3', simple: 'a2a3', tricky: 'a2a3' },
        facts: { moment: null, played: { uci: task.played, roles: [] } }, drafts: { best: 'b', simple: 's', tricky: 't' },
      };
    },
  };
}

test('review picks the mistakes, analyses them deeply and builds the JSON the UI reads', async () => {
  const game = parseGame(PGN);
  const players = { user: 'white', userElo: 1700, oppElo: 1400 };
  // At ply 12 (white to move) the engine sees +400 but the position after the played move is level.
  const runner = fakeRunner(game, { blunderPly: 12 });
  const review = await reviewGame({ game, runner, players });
  assert.equal(review.plies.length, 23);
  assert.equal(review.game.user_color, 'white');
  assert.ok(review.accuracy.white <= 100 && review.accuracy.white >= 0);
  assert.ok(runner.calls.includes('deep'), 'a deep analysis was requested');
  assert.deepEqual(Object.keys(review.critical), Object.keys(review.critical).filter(k => review.plies[Number(k)].critical));
  for (const p of review.plies) {
    assert.ok(['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'simple', 'tricky'].includes(p.judgement));
    assert.ok(p.fen_before && p.fen_after && p.san);
  }
  const item = review.critical['12'];
  assert.ok(item, 'the mistake at ply 12 is a key moment');
  assert.equal(item.kind, 'mistake');
  assert.equal(item.facts.moment, 'mistake');
  assert.equal(item.narration.source, 'template');
});
