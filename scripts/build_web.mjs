// Build the in-browser analysis into src/smartchess/web/static/dist/:
//   analysis.worker.js  the worker (Maia on ONNX Runtime Web + the search)
//   backend.js          what the page imports (games, reviews, jobs, storage)
//   stockfish/          Stockfish 19 lite (WASM, single thread), from the npm package
//   ort/                the ONNX Runtime Web WASM files
//   chessground.js, chess.js and chessground*.css  the board libraries (no CDN)
//   models/             maia3-5m.onnx (scripts/export_onnx.py), if exported
// Usage: npm run build

import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src/smartchess/web/static/dist');
const analysis = resolve(root, 'src/smartchess/web/analysis');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    'analysis.worker': resolve(analysis, 'worker.js'),
    backend: resolve(analysis, 'browser.js'),
    chessground: resolve(root, 'node_modules/@lichess-org/chessground/dist/chessground.js'),
    chess: resolve(root, 'node_modules/chess.js/dist/esm/chess.js'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  conditions: ['onnxruntime-web-use-extern-wasm'],
  logLevel: 'info',
});

const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  copy(resolve(root, 'node_modules/stockfish/bin', f), resolve(out, 'stockfish', f));
}
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copy(resolve(root, 'node_modules/onnxruntime-web/dist', f), resolve(out, 'ort', f));
}
for (const f of ['chessground.base.css', 'chessground.cburnett.css']) {
  copy(resolve(root, 'node_modules/@lichess-org/chessground/assets', f), resolve(out, f));
}
for (const model of ['maia3-5m']) {
  const src = resolve(root, 'models', `${model}.onnx`);
  if (existsSync(src)) copy(src, resolve(out, 'models', `${model}.onnx`));
  else console.warn(`No ${src}: run scripts/export_onnx.py`);
}
