// Analysis worker (browser): Maia on ONNX Runtime Web plus the search. Stockfish runs in
// its own worker, and the page relays UCI lines between the two ("sf" messages), because
// stockfish.js can only talk to whoever created it.

import * as ort from 'onnxruntime-web/wasm';
import { Maia } from './maia.js';
import { Stockfish } from './stockfish.js';
import { AnalysisEngine } from './tasks.js';

const lineListeners = [];
const transport = {
  send: line => postMessage({ type: 'sf', line }),
  onLine: cb => lineListeners.push(cb),
};

let engine = null;

async function init({ model, ortBase, stockfish, settings }) {
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.wasm.numThreads = 1; // the page is not cross-origin isolated, and one core per worker is the plan
  const maia = await Maia.create(ort, new Uint8Array(model));
  const sf = new Stockfish(transport, stockfish);
  await sf.init();
  engine = new AnalysisEngine(sf, maia, settings);
}

self.onmessage = async ({ data }) => {
  if (data.type === 'sf') {
    lineListeners.forEach(cb => cb(data.line));
  } else if (data.type === 'init') {
    try {
      await init(data);
      postMessage({ type: 'ready' });
    } catch (e) {
      postMessage({ type: 'failed', message: String(e?.message ?? e) });
    }
  } else if (data.type === 'task') {
    try {
      postMessage({ type: 'result', id: data.id, result: await engine.run(data.kind, data.task) });
    } catch (e) {
      postMessage({ type: 'error', id: data.id, message: String(e?.message ?? e) });
    }
  }
};
