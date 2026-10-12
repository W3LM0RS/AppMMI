'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, HttpError } = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function buildRoutes(store) {
  const crud = (base, { list, create, update, remove, get }) => [
    list && ['GET', `^/api/${base}$`, () => list()],
    create && ['POST', `^/api/${base}$`, (_, body) => create(body)],
    get && ['GET', `^/api/${base}/(\\d+)$`, ([id]) => get(id)],
    update && ['PUT', `^/api/${base}/(\\d+)$`, ([id], body) => update(body, id)],
    remove && ['DELETE', `^/api/${base}/(\\d+)$`, ([id]) => (remove(id), { ok: true })],
  ].filter(Boolean);

  return [
    ...crud('ingredients', {
      list: () => store.listIngredients(),
      create: (b) => store.saveIngredient(b),
      update: (b, id) => store.saveIngredient(b, id),
      remove: (id) => store.deleteIngredient(id),
    }),
    ...crud('beers', {
      list: () => store.listBeers(),
      create: (b) => store.saveBeer(b),
      update: (b, id) => store.saveBeer(b, id),
      remove: (id) => store.deleteBeer(id),
    }),
    ['GET', '^/api/beers/(\\d+)/recipe$', ([id]) => ({ beer: store.decorateBeer(store.beer(id)), items: store.recipe(id) })],
    ['PUT', '^/api/beers/(\\d+)/recipe$', ([id], body) => store.saveRecipe(id, body)],
    ...crud('productions', {
      list: () => store.listProductions(),
      get: (id) => store.production(id),
      create: (b) => store.createProduction(b),
      remove: (id) => store.deleteProduction(id),
    }),
    ...crud('purchases', {
      list: () => store.listPurchases(),
      get: (id) => store.purchase(id),
      create: (b) => store.createPurchase(b),
      remove: (id) => store.deletePurchase(id),
    }),
    ...crud('sales', {
      list: () => store.listSales(),
      get: (id) => store.sale(id),
      create: (b) => store.createSale(b),
      remove: (id) => store.deleteSale(id),
    }),
    ['POST', '^/api/adjustments$', (_, body) => store.adjustStock(body)],
    ['GET', '^/api/movements$', (_, __, query) => store.listMovements(Number(query.get('limit')) || 200)],
    ['GET', '^/api/dashboard$', (_, __, query) => store.dashboard({ from: query.get('from'), to: query.get('to') })],
  ].map(([method, pattern, handler]) => ({ method, re: new RegExp(pattern), handler }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new HttpError(413, 'Requête trop volumineuse'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Interdit' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Page introuvable');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(store) {
  const routes = buildRoutes(store);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Méthode non autorisée' });
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'Route inconnue' });
    try {
      const params = url.pathname.match(route.re).slice(1).map(Number);
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = route.handler(params, body, url.searchParams);
      send(res, req.method === 'POST' ? 201 : 200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Erreur interne du serveur' });
    }
  });
}

if (require.main === module) {
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'brasserie.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const store = new Store(dbFile);
  const port = Number(process.env.PORT) || 3000;
  createServer(store).listen(port, () => {
    console.log(`Brasserie — application disponible sur http://localhost:${port}`);
  });
}

module.exports = { createServer };
