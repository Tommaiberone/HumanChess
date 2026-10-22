import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Pos, moveUci } from '../src/smartchess/web/analysis/position.js';
import { buildPos } from '../src/smartchess/web/analysis/tasks.js';
import { makeMaia } from './helpers.js';

const hasModel = existsSync(new URL('../models/maia3-5m.onnx', import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/positions.json', import.meta.url)));

test('Maia 5M on ONNX Runtime Web gives the probabilities of the Python model', { skip: !hasModel && 'run scripts/export_onnx.py' }, async () => {
  const maia = await makeMaia('maia3-5m');
  for (const rec of fixtures.maia) {
    const pos = buildPos(rec.start_fen, rec.moves);
    const policy = await maia.policy(pos, rec.elo_self, rec.elo_oppo);
    assert.equal(policy.length, rec.n_legal, 'legal moves');
    const probs = new Map(policy.map(hm => [moveUci(hm.move), hm.prob]));
    for (const [uci, prob] of rec.policy) {
      assert.ok(Math.abs((probs.get(uci) ?? -1) - prob) < 2e-3, `${rec.moves.length} plies, ${uci}: ${probs.get(uci)} vs ${prob}`);
    }
    assert.equal(moveUci(policy[0].move), rec.policy[0][0], 'most likely move');
  }
});

test('a position with no history repeats the earliest position', { skip: !hasModel && 'run scripts/export_onnx.py' }, async () => {
  const maia = await makeMaia('maia3-5m');
  const policy = await maia.policy(Pos.start(), 1500, 1500);
  assert.equal(policy.length, 20);
  assert.ok(Math.abs(policy.reduce((s, hm) => s + hm.prob, 0) - 1) < 1e-9);
});
