// The page's side of the analysis: a pool of workers, each with its own Stockfish and
// Maia, that tasks are spread over. Everything runs on the user's device.

const MODEL_CACHE = 'smartchess-models-v1';

/** How many workers to run: one core is left to the page, and phones get fewer (memory). */
export function defaultWorkers() {
  const cores = navigator.hardwareConcurrency || 4;
  const phone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return Math.max(1, Math.min(phone ? 2 : 4, cores - 1));
}

/** The model file, from the cache or the network, reporting progress as it downloads. */
export async function loadModel(url, onProgress = () => {}) {
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch { /* no Cache Storage: download every time */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the analysis model (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch { /* quota: fine */ }
  return bytes;
}

class Slot {
  constructor(base, onIdle) {
    this.busy = false;
    this.pending = new Map();
    this.onIdle = onIdle;
    this.stockfish = new Worker(new URL('stockfish/stockfish-19-lite-single.js', base));
    this.worker = new Worker(new URL('analysis.worker.js', base), { type: 'module' });
    // The page only relays UCI text between the two workers.
    this.stockfish.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : e.data?.line;
      if (line) this.worker.postMessage({ type: 'sf', line });
    };
    this.worker.onmessage = e => this._message(e.data);
    this.worker.onerror = e => this._fail(new Error(e.message || 'The analysis worker crashed'));
    this.ready = new Promise((resolve, reject) => { this._ready = { resolve, reject }; });
  }

  _message(m) {
    if (m.type === 'sf') this.stockfish.postMessage(m.line);
    else if (m.type === 'ready') this._ready.resolve();
    else if (m.type === 'failed') this._ready.reject(new Error(m.message));
    else if (m.type === 'result' || m.type === 'error') {
      const job = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.type === 'result') job.resolve(m.result);
      else job.reject(new Error(m.message));
    }
  }

  _fail(error) {
    this._ready.reject(error);
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }

  init(config, transfer = []) {
    this.worker.postMessage({ type: 'init', ...config }, transfer);
    return this.ready;
  }

  run(id, kind, task) {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'task', id, kind, task });
    });
  }

  close() {
    this.worker.terminate();
    this.stockfish.terminate();
  }
}

export class AnalysisPool {
  /**
   * base: URL of the folder with analysis.worker.js, stockfish/, ort/ and models/.
   * Tasks run in the order they were asked, each on the first free worker.
   */
  constructor({ base, model = 'maia3-5m', workers = defaultWorkers(), settings = {}, stockfish = {} }) {
    this.base = base;
    this.model = model;
    this.size = workers;
    this.settings = settings;
    this.stockfishOptions = stockfish;
    this.slots = [];
    this.queue = [];
    this.nextId = 1;
    this.starting = null;
  }

  /** Download the model and start the workers; safe to call again. onProgress(message, fraction). */
  start(onProgress = () => {}) {
    this.starting ??= (async () => {
      const url = new URL(`models/${this.model}.onnx`, this.base);
      const model = await loadModel(url, (loaded, total) => {
        onProgress(`Downloading the analysis model${total ? ` (${Math.round((100 * loaded) / total)}%)` : ''}`, total ? loaded / total : 0);
      });
      onProgress('Starting the engines', 1);
      const config = { ortBase: new URL('ort/', this.base).href, stockfish: this.stockfishOptions, settings: this.settings };
      for (let i = 0; i < this.size; i++) {
        const slot = new Slot(this.base);
        this.slots.push(slot);
        // Each worker gets its own copy of the model bytes (moved, not cloned again).
        const copy = model.slice();
        slot.init({ ...config, model: copy.buffer }, [copy.buffer]).catch(() => {});
      }
      await Promise.all(this.slots.map(s => s.ready));
      this._pump();
    })().catch(error => {
      this.starting = null;
      this.close();
      throw error;
    });
    return this.starting;
  }

  run(kind, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, task, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      slot.busy = true;
      slot.run(this.nextId++, job.kind, job.task).then(job.resolve, job.reject).finally(() => {
        slot.busy = false;
        this._pump();
      });
    }
  }

  close() {
    this.slots.forEach(s => s.close());
    this.slots = [];
    this.starting = null;
  }
}
