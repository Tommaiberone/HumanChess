import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pos, moveUci, parseMove } from '../src/smartchess/web/analysis/position.js';
import { moveMotifs, opponentThreats, material, piecesSummary } from '../src/smartchess/web/analysis/motifs.js';
import { winPct, cpFromWin, formatCp } from '../src/smartchess/web/analysis/winprob.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/positions.json', import.meta.url)));

function build(rec) {
  // Rebuild the history the fixture recorded: the position, reached through its last moves.
  return Pos.fromFen(rec.fen);
}

test('win probability and eval formatting match Python', () => {
  for (const r of fixtures.winprob) {
    if ('fmt' in r) {
      assert.ok(Math.abs(winPct(r.cp) - r.win) < 1e-9, `win ${r.cp}`);
      assert.equal(formatCp(r.cp), r.fmt, `format ${r.cp}`);
    } else {
      assert.ok(Math.abs(cpFromWin(r.win_in) - r.cp) < 1e-6, `cp ${r.win_in}`);
    }
  }
});

fixtures.positions.forEach((rec, i) => {
  test(`position ${i}: ${rec.fen}`, () => {
    const pos = build(rec);
    assert.equal(pos.fen(), rec.fen, 'fen');
    assert.equal(pos.turn, rec.turn);
    const over = pos.result();
    assert.equal(over.over, rec.game_over, 'game over');
    assert.equal(over.winner, rec.winner, 'winner');
    const moves = pos.legalMoves();
    assert.deepEqual(moves.map(moveUci), rec.legal, 'legal moves and order');
    assert.equal(pos.legalCount(), rec.legal.length, 'legal count');
    assert.deepEqual(moves.map(m => pos.san(m)), rec.san, 'san');
    assert.deepEqual(moves.map(m => pos.numbered(m)), rec.numbered, 'numbered');
    moves.forEach((m, k) => assert.deepEqual(moveMotifs(pos, m), rec.motifs[k], `motifs of ${rec.san[k]}`));
    assert.deepEqual(opponentThreats(pos), rec.threats, 'threats');
    assert.deepEqual([material(pos, 'white'), material(pos, 'black')], rec.material, 'material');
    assert.deepEqual([piecesSummary(pos, 'white'), piecesSummary(pos, 'black')], rec.pieces, 'pieces');
    if (rec.variation.moves.length) {
      assert.equal(pos.variationSan(rec.variation.moves.map(parseMove)), rec.variation.san, 'variation san');
    }
  });
});
