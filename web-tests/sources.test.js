import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLichess } from '../src/smartchess/web/analysis/sources.js';
import { gameMoves } from '../src/smartchess/web/analysis/games.js';

// What Lichess answers for one game when the export includes the moves.
const GAME = {
  id: 'abcd1234', variant: 'standard', speed: 'blitz', status: 'resign', winner: 'white',
  createdAt: 1_700_000_000_000, lastMoveAt: 1_700_000_300_000, clock: { initial: 180, increment: 0 },
  players: { white: { user: { name: 'me' }, rating: 1500 }, black: { user: { name: 'you' }, rating: 1450 } },
  opening: { name: 'Italian Game' },
  pgn: '[Event "Rated blitz game"]\n[Site "https://lichess.org/abcd1234"]\n[White "me"]\n[Black "you"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0\n',
};

test('the Lichess export is asked for the moves, so the game opens on the board', async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(GAME) + '\n', { status: 200 });
  };
  try {
    const [raw] = await fetchLichess('me', 5);
    assert.equal(new URL(urls[0]).searchParams.get('moves'), 'true');
    const { plies } = gameMoves(raw, 'me');
    assert.deepEqual(plies.map(p => p.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
