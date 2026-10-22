// Review games of data/games with the browser code running in Node, to compare with Python.
// Usage: node web-tests/review-cli.mjs OUT_DIR VARIANT(lite|full) MODEL N_WORKERS GAME_ID...

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnalysisEngine } from '../src/smartchess/web/analysis/tasks.js';
import { gamePlayers, gameSummary, parseGame } from '../src/smartchess/web/analysis/games.js';
import { reviewGame } from '../src/smartchess/web/analysis/review.js';
import { makeMaia, makeStockfish } from './helpers.js';

const [outDir, variant, model, workers, ...ids] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const engines = [];
for (let i = 0; i < Number(workers); i++) {
  engines.push({ busy: false, engine: new AnalysisEngine(await makeStockfish(variant), await makeMaia(model)) });
}
const queue = [];
const runner = {
  run(type, task) {
    return new Promise((resolve, reject) => { queue.push({ type, task, resolve, reject }); pump(); });
  },
};
function pump() {
  for (const slot of engines) {
    if (slot.busy || !queue.length) continue;
    const job = queue.shift();
    slot.busy = true;
    slot.engine.run(job.type, job.task).then(job.resolve, job.reject).finally(() => { slot.busy = false; pump(); });
  }
}

const timings = {};
for (const id of ids) {
  const raw = JSON.parse(readFileSync(new URL(`../data/games/${id}.json`, import.meta.url), 'utf-8'));
  const game = parseGame(raw.pgn);
  const summary = gameSummary(raw, 'tommasobersani');
  const players = gamePlayers(game.headers, summary.user_color);
  const t = Date.now();
  const review = await reviewGame({ game, runner, players, forcePlies: raw.key_plies ?? [] });
  timings[id] = (Date.now() - t) / 1000;
  writeFileSync(`${outDir}/${id}.json`, JSON.stringify(review));
  console.log(id, `${timings[id]} s`, Object.keys(review.critical).length, 'key moments');
}
writeFileSync(`${outDir}/timings.json`, JSON.stringify(timings));
for (const { engine } of engines) engine.stockfish.kill();
process.exit(0);
