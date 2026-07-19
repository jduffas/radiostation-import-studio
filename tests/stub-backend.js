// Faux backend RadioStation pour tester main.js (upload-with-metadata, import).
// Contrôle: POST /_mode {"mode":"ok"|"fail"} ; GET /_last → dernières requêtes reçues.
'use strict';
const http = require('node:http');

const PORT = parseInt(process.env.STUB_PORT || '8901', 10);
let mode = 'ok';
const received = [];

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(b);
  };

  if (req.method === 'POST' && req.url === '/_mode') {
    const body = await readBody(req);
    mode = JSON.parse(body.toString()).mode;
    return send(200, { mode });
  }
  if (req.method === 'GET' && req.url === '/_last') {
    return send(200, received);
  }
  if (req.method === 'POST' && req.url === '/_reset') {
    received.length = 0;
    return send(200, { ok: true });
  }

  // Listes campagnes/catégories (sélecteurs spot/promo du flux fichiers, feature import
  // multi-type) — le stub ne les connaissait pas (404 → proxy main.js renvoyait 502,
  // logué par Chrome en erreur console et faisant échouer tous les checks "sans erreur JS"
  // en aval, signalé 19 juil 2026). Fixtures minimales : seuls id/name sont lus côté UI.
  if (req.method === 'GET' && req.url === '/api/ads/campaigns') {
    return send(200, [{ id: 'stub-ad-campaign-1', name: 'Campagne pub stub' }]);
  }
  if (req.method === 'GET' && req.url === '/api/promos/campaigns') {
    return send(200, [{ id: 'stub-promo-campaign-1', name: 'Campagne promo stub' }]);
  }
  if (req.method === 'GET' && req.url === '/api/ads/categories') {
    return send(200, [{ id: 'stub-ad-category-1', name: 'Catégorie pub stub' }]);
  }

  const body = await readBody(req);

  if (req.url === '/api/importer/upload-with-metadata') {
    // Compte les fichiers dans le multipart (occurrences de name="files")
    const txt = body.toString('latin1');
    const fileCount = (txt.match(/name="files"/g) || []).length;
    const metaMatch = txt.match(/name="metadata"\r\n\r\n([\s\S]*?)\r\n--/);
    let metadata = null;
    try { metadata = JSON.parse(metaMatch[1]); } catch { /* ignore */ }
    const filenames = [...txt.matchAll(/name="files"; filename="([^"]*)"/g)].map(m => m[1]);
    received.push({
      url: req.url,
      auth: req.headers.authorization || null,
      fileCount, filenames, metadata,
      bodyBytes: body.length,
      mode,
    });
    if (mode === 'fail') return send(500, { detail: 'stub failure' });
    return send(200, {
      files: Array.from({ length: fileCount }, (_, i) => ({
        file_id: `stub-file-${i + 1}`,
        metadata: { title: metadata?.[i]?.title || `Stub ${i + 1}`, artist: metadata?.[i]?.artist || 'StubArtist' },
      })),
    });
  }

  if (req.url === '/api/importer/import') {
    let payload = null;
    try { payload = JSON.parse(body.toString()); } catch { /* ignore */ }
    received.push({ url: req.url, auth: req.headers.authorization || null, payload, mode });
    if (mode === 'fail') return send(422, { detail: 'import refusé (stub)' });
    return send(200, { track_id: 4242, status: 'imported' });
  }

  send(404, { detail: 'not found (stub)' });
}).listen(PORT, '127.0.0.1', () => console.log(`stub backend on ${PORT}`));
