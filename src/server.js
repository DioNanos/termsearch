// TermSearch — personal search engine server
// Replaces the 4290-line monolith with a clean modular setup

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config/manager.js';
import { initCaches } from './search/engine.js';
import { createRouter } from './api/routes.js';
import { createRateLimiters, ipMiddleware, applySecurityHeaders } from './api/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');

// Initialize config and caches
const cfg = config.getConfig();
const dataDir = config.getDataDir();
initCaches(dataDir, cfg);

// Express app setup
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Middleware
app.use(ipMiddleware);
app.use(express.json({ limit: '256kb' }));

// Rate limiters
const rateLimiters = createRateLimiters(cfg);

// API routes
const router = createRouter(config, rateLimiters);
app.use(router);

// Serve frontend static files
app.use(express.static(FRONTEND_DIST, {
  maxAge: 0,
  etag: true,
  index: 'index.html',
  setHeaders: (res, filePath) => {
    const base = path.basename(filePath);
    if (base === 'index.html' || base === 'app.js' || base === 'style.css') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

// SPA fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

// Start server
const port = cfg.port || 3000;
const host = cfg.host || '127.0.0.1';

const server = app.listen(port, host, () => {
  // Server ready — bin/termsearch.js prints the startup banner
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[termsearch] ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
export { port, host };
