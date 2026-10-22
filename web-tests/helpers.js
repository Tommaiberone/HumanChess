// Test helpers: Stockfish (WASM, as a child process) and Maia (ONNX Runtime Web) in Node.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import * as ort from 'onnxruntime-web';
import { Stockfish } from '../src/smartchess/web/analysis/stockfish.js';
import { Maia } from '../src/smartchess/web/analysis/maia.js';

const ROOT = new URL('..', import.meta.url);
export const STOCKFISH_FILES = {
  lite: new URL('node_modules/stockfish/bin/stockfish-19-lite-single.js', ROOT).pathname.replace(/^\/(\w:)/, '$1'),
  full: new URL('node_modules/stockfish/bin/stockfish-19-single.js', ROOT).pathname.replace(/^\/(\w:)/, '$1'),
};

export function nodeTransport(file) {
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'inherit'] });
  const listeners = [];
  readline.createInterface({ input: child.stdout }).on('line', line => listeners.forEach(cb => cb(line)));
  return {
    send: line => child.stdin.write(`${line}\n`),
    onLine: cb => listeners.push(cb),
    kill: () => child.kill(),
  };
}

export async function makeStockfish(variant = 'lite', options = {}) {
  const transport = nodeTransport(STOCKFISH_FILES[variant]);
  const sf = new Stockfish(transport, options);
  await sf.init();
  sf.kill = () => transport.kill();
  return sf;
}

export async function makeMaia(model = 'maia3-5m') {
  ort.env.wasm.numThreads = 1;
  const bytes = readFileSync(new URL(`models/${model}.onnx`, ROOT));
  return Maia.create(ort, new Uint8Array(bytes));
}
