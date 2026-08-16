'use strict';

const fs = require('fs');
const path = require('path');

const UI_DIR = path.resolve(__dirname, '..', 'ui');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.webp': 'image/webp'
};

function resolveUiPath(pathname) {
  const decoded = decodeURIComponent(pathname || '/');
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(UI_DIR, relative);
  if (!candidate.startsWith(`${UI_DIR}${path.sep}`) && candidate !== UI_DIR) return null;
  return candidate;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(pathname, res) {
  const filePath = resolveUiPath(pathname);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(res, filePath);
      return;
    }

    const indexPath = path.join(UI_DIR, 'index.html');
    fs.stat(indexPath, (indexError, indexStats) => {
      if (indexError || !indexStats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      sendFile(res, indexPath);
    });
  });
}

module.exports = { serveStatic };
