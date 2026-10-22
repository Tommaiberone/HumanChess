// A tiny static file server for the exported site (site/), shared by the browser scripts.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

export const SITE = new URL('../site/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
export const CHROMIUM = process.env.CHROMIUM ?? 'C:/Program Files/Chromium/Application/chrome.exe';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.svg': 'image/svg+xml',
};

/** Serve SITE on a free port; resolves to {url, close}. With SITE_URL set, point at that site instead. */
export function serve() {
  if (process.env.SITE_URL) return Promise.resolve({ url: process.env.SITE_URL, close() {} });
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '') || 'index.html';
    try {
      const file = join(SITE, path);
      const st = statSync(file);
      if (st.isDirectory()) throw new Error('directory');
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': st.size });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, () => resolve({
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  })));
}
