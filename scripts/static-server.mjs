import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A dependency-free static file server for the perf harness (tests/perf/) —
// it needs to load dist/index.js via a *relative* import (the same way the
// examples and any real CDN-style consumer would), which requires an actual
// http origin; file:// URLs can't resolve ES module specifiers the way the
// browser needs here. No existing devDependency already provides this
// (`serve` is only ever invoked via npx, not installed), so a few dozen
// lines beats adding one just for local static hosting.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const filePath = path.join(root, urlPath);
  // Guards against a request path escaping `root` via `..` segments.
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`static server on http://localhost:${port}`);
});
