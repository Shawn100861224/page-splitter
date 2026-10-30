/** 本地静态服务器：node tools/serve.js [port]  默认 8099，仅监听 127.0.0.1 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.argv[2] || 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/site/index.html';
    else if (!p.includes('.')) p = p.replace(/\/$/, '') + '/index.html';
    const abs = normalize(join(ROOT, p));
    if (!abs.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    // 站点根在 site/，所以 /src/main.js 要落到 site/src/main.js
    let path = abs;
    try {
      await stat(path);
    } catch {
      path = normalize(join(ROOT, 'site', p));
    }
    const st = await stat(path);
    if (st.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} → http://127.0.0.1:${PORT}/`);
});
