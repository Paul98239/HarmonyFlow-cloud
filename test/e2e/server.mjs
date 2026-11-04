// server.mjs — 端到端測試用的靜態伺服器（Node 內建 http，不加套件）：把專案根目錄原樣 serve 出去，跟部署一樣。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.mid': 'audio/midi', '.task': 'application/octet-stream', '.sf3': 'application/octet-stream' };

export function startServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (path.endsWith('/')) path += 'index.html';
        const file = join(ROOT, path);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        await stat(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(await readFile(file));
      } catch { res.writeHead(404); res.end(); }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}
