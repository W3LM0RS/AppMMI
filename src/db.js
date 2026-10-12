'use strict';

// Couche données + règles métier (stocks, coût moyen pondéré, coûts de revient).
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Autre',
  unit TEXT NOT NULL DEFAULT 'kg',
  stock REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  supplier TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS beers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  style TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'Bouteille 33cl',
  volume_l REAL NOT NULL DEFAULT 0.33,
  sale_price REAL NOT NULL DEFAULT 0,
  batch_yield REAL NOT NULL DEFAULT 1,
  stock REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id INTEGER PRIMARY KEY,
  beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS productions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL,
  ingredients_cost REAL NOT NULL DEFAULT 0,
  extra_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS production_items (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('ingredient', 'beer')),
  item_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER
);
`;

const PURCHASE_CATEGORIES = ['matiere', 'materiel', 'autre'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} introuvable`);

function num(value, field, { min = -Infinity, allowZero = true } = {}) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
    throw bad(`Le champ « ${field} » doit être un nombre`);
  }
  if (n < min || (!allowZero && n === 0)) throw bad(`Valeur invalide pour « ${field} »`);
  return n;
}

function optNum(value, field, fallback, opts) {
  return value === undefined || value === null || value === '' ? fallback : num(value, field, opts);
}

function str(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function date(value) {
  const d = str(value) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Date invalide (format AAAA-MM-JJ)');
  return d;
}

// Coût moyen pondéré après une entrée de `qty` unités au coût `cost`.
function weightedAvg(stock, avg, qty, cost) {
  const base = Math.max(stock, 0);
  const total = base + qty;
  return total > 0 ? (base * avg + qty * cost) / total : cost;
}

// Inverse d'une entrée : retire `qty` unités valorisées à `cost` du CMP.
function removeFromAvg(stock, avg, qty, cost) {
  const remaining = stock - qty;
  if (remaining <= 0) return avg;
  return Math.max((stock * avg - qty * cost) / remaining, 0);
}

class Store {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r }));
  }

  get(sql, ...params) {
    const row = this.db.prepare(sql).get(...params);
    return row ? { ...row } : undefined;
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (err && err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/.test(err.message)) {
        throw bad('Élément utilisé ailleurs (recette, achat, vente ou production) : suppression impossible');
      }
      if (err && err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) {
        throw bad('Ce nom existe déjà');
      }
      throw err;
    }
  }

  movement(date, type, id, quantity, unitCost, reason, refType = null, refId = null) {
    this.run(
      `INSERT INTO movements (date, item_type, item_id, quantity, unit_cost, reason, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      date, type, id, quantity, unitCost, reason, refType, refId,
    );
  }

  // ---------- Matières premières ----------

  listIngredients() {
    return this.all(`SELECT *, stock * avg_cost AS value FROM ingredients ORDER BY category, name`);
  }

  ingredient(id) {
    const row = this.get('SELECT * FROM ingredients WHERE id = ?', id);
    if (!row) throw notFound('Matière première');
    return row;
  }

  saveIngredient(data, id = null) {
    const name = str(data.name);
    if (!name) throw bad('Le nom est obligatoire');
    const fields = {
      name,
      category: str(data.category, 'Autre') || 'Autre',
      unit: str(data.unit, 'kg') || 'kg',
      min_stock: optNum(data.min_stock, 'Stock minimum', 0, { min: 0 }),
      supplier: str(data.supplier),
    };
    return this.tx(() => {
      if (id) {
        this.ingredient(id);
        this.run(
          'UPDATE ingredients SET name = ?, category = ?, unit = ?, min_stock = ?, supplier = ? WHERE id = ?',
          fields.name, fields.category, fields.unit, fields.min_stock, fields.supplier, id,
        );
        return this.ingredient(id);
      }
      // Stock initial éventuel, valorisé au coût indiqué.
      const stock = optNum(data.stock, 'Stock initial', 0, { min: 0 });
      const cost = optNum(data.avg_cost, 'Coût unitaire', 0, { min: 0 });
      const { lastInsertRowid } = this.run(
        `INSERT INTO ingredients (name, category, unit, min_stock, supplier, stock, avg_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        fields.name, fields.category, fields.unit, fields.min_stock, fields.supplier, stock, cost,
      );
      const newId = Number(lastInsertRowid);
      if (stock) this.movement(date(), 'ingredient', newId, stock, cost, 'Stock initial');
      return this.ingredient(newId);
    });
  }

  deleteIngredient(id) {
    this.tx(() => {
      this.ingredient(id);
      this.run('DELETE FROM ingredients WHERE id = ?', id);
      this.run(`DELETE FROM movements WHERE item_type = 'ingredient' AND item_id = ?`, id);
    });
  }

  // ---------- Bières ----------

  recipeCost(beerId) {
    const beer = this.get('SELECT batch_yield FROM beers WHERE id = ?', beerId);
    const { cost } = this.get(
      `SELECT COALESCE(SUM(r.quantity * i.avg_cost), 0) AS cost
       FROM recipe_items r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.beer_id = ?`,
      beerId,
    );
    return { batch: cost, unit: beer && beer.batch_yield > 0 ? cost / beer.batch_yield : 0 };
  }

  decorateBeer(beer) {
    const recipe = this.recipeCost(beer.id);
    // Coût de revient de référence : CMP réel si la bière a déjà été produite, sinon coût théorique de la recette.
    const cost = beer.avg_cost > 0 ? beer.avg_cost : recipe.unit;
    return {
      ...beer,
      value: Math.max(beer.stock, 0) * beer.avg_cost,
      recipe_unit_cost: recipe.unit,
      recipe_batch_cost: recipe.batch,
      unit_margin: beer.sale_price - cost,
      margin_rate: beer.sale_price > 0 ? (beer.sale_price - cost) / beer.sale_price : null,
    };
  }

  listBeers() {
    return this.all('SELECT * FROM beers ORDER BY name').map((b) => this.decorateBeer(b));
  }

  beer(id) {
    const row = this.get('SELECT * FROM beers WHERE id = ?', id);
    if (!row) throw notFound('Bière');
    return row;
  }

  saveBeer(data, id = null) {
    const name = str(data.name);
    if (!name) throw bad('Le nom est obligatoire');
    const f = {
      name,
      style: str(data.style),
      format: str(data.format, 'Bouteille 33cl') || 'Bouteille 33cl',
      volume_l: optNum(data.volume_l, 'Volume', 0.33, { min: 0 }),
      sale_price: optNum(data.sale_price, 'Prix de vente', 0, { min: 0 }),
      batch_yield: optNum(data.batch_yield, 'Rendement de la recette', 1, { min: 0, allowZero: false }),
      min_stock: optNum(data.min_stock, 'Stock minimum', 0, { min: 0 }),
    };
    return this.tx(() => {
      if (id) {
        this.beer(id);
        this.run(
          `UPDATE beers SET name = ?, style = ?, format = ?, volume_l = ?, sale_price = ?, batch_yield = ?, min_stock = ?
           WHERE id = ?`,
          f.name, f.style, f.format, f.volume_l, f.sale_price, f.batch_yield, f.min_stock, id,
        );
        return this.decorateBeer(this.beer(id));
      }
      const stock = optNum(data.stock, 'Stock initial', 0, { min: 0 });
      const cost = optNum(data.avg_cost, 'Coût unitaire', 0, { min: 0 });
      const { lastInsertRowid } = this.run(
        `INSERT INTO beers (name, style, format, volume_l, sale_price, batch_yield, min_stock, stock, avg_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        f.name, f.style, f.format, f.volume_l, f.sale_price, f.batch_yield, f.min_stock, stock, cost,
      );
      const newId = Number(lastInsertRowid);
      if (stock) this.movement(date(), 'beer', newId, stock, cost, 'Stock initial');
      return this.decorateBeer(this.beer(newId));
    });
  }

  deleteBeer(id) {
    this.tx(() => {
      this.beer(id);
      this.run('DELETE FROM beers WHERE id = ?', id);
      this.run(`DELETE FROM movements WHERE item_type = 'beer' AND item_id = ?`, id);
    });
  }

  recipe(beerId) {
    this.beer(beerId);
    return this.all(
      `SELECT r.ingredient_id, r.quantity, i.name, i.unit, i.avg_cost, r.quantity * i.avg_cost AS cost
       FROM recipe_items r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.beer_id = ? ORDER BY i.category, i.name`,
      beerId,
    );
  }

  saveRecipe(beerId, data) {
    const items = Array.isArray(data.items) ? data.items : [];
    return this.tx(() => {
      const beer = this.beer(beerId);
      if (data.batch_yield !== undefined) {
        const y = num(data.batch_yield, 'Rendement de la recette', { min: 0, allowZero: false });
        this.run('UPDATE beers SET batch_yield = ? WHERE id = ?', y, beer.id);
      }
      this.run('DELETE FROM recipe_items WHERE beer_id = ?', beerId);
      for (const item of items) {
        const ingId = num(item.ingredient_id, 'Matière première');
        this.ingredient(ingId);
        const q = num(item.quantity, 'Quantité', { min: 0, allowZero: false });
        this.run('INSERT INTO recipe_items (beer_id, ingredient_id, quantity) VALUES (?, ?, ?)', beerId, ingId, q);
      }
      return { beer: this.decorateBeer(this.beer(beerId)), items: this.recipe(beerId) };
    });
  }

  // ---------- Production (brassins / conditionnement) ----------

  listProductions() {
    return this.all(
      `SELECT p.*, b.name AS beer_name, b.format AS beer_format
       FROM productions p JOIN beers b ON b.id = p.beer_id ORDER BY p.date DESC, p.id DESC`,
    );
  }

  production(id) {
    const row = this.get(
      `SELECT p.*, b.name AS beer_name FROM productions p JOIN beers b ON b.id = p.beer_id WHERE p.id = ?`, id,
    );
    if (!row) throw notFound('Production');
    row.items = this.all(
      `SELECT pi.*, i.name, i.unit FROM production_items pi JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.production_id = ?`,
      id,
    );
    return row;
  }

  createProduction(data) {
    return this.tx(() => {
      const d = date(data.date);
      const beer = this.beer(num(data.beer_id, 'Bière'));
      const qty = num(data.quantity, 'Quantité produite', { min: 0, allowZero: false });
      const extra = optNum(data.extra_cost, 'Autres coûts', 0, { min: 0 });

      // Sans détail fourni, on consomme la recette au prorata de la quantité produite.
      let items = Array.isArray(data.items) ? data.items : null;
      if (!items) {
        const recipe = this.recipe(beer.id);
        if (!recipe.length) throw bad(`Aucune recette définie pour « ${beer.name} » : indiquez les matières consommées`);
        const factor = qty / beer.batch_yield;
        items = recipe.map((r) => ({ ingredient_id: r.ingredient_id, quantity: r.quantity * factor }));
      }

      const { lastInsertRowid } = this.run(
        'INSERT INTO productions (date, beer_id, quantity, extra_cost, notes) VALUES (?, ?, ?, ?, ?)',
        d, beer.id, qty, extra, str(data.notes),
      );
      const prodId = Number(lastInsertRowid);

      let ingredientsCost = 0;
      for (const item of items) {
        const ing = this.ingredient(num(item.ingredient_id, 'Matière première'));
        const q = num(item.quantity, `Quantité de ${ing.name}`, { min: 0 });
        if (q === 0) continue;
        ingredientsCost += q * ing.avg_cost;
        this.run(
          'INSERT INTO production_items (production_id, ingredient_id, quantity, unit_cost) VALUES (?, ?, ?, ?)',
          prodId, ing.id, q, ing.avg_cost,
        );
        this.run('UPDATE ingredients SET stock = stock - ? WHERE id = ?', q, ing.id);
        this.movement(d, 'ingredient', ing.id, -q, ing.avg_cost, `Production ${beer.name}`, 'production', prodId);
      }

      const total = ingredientsCost + extra;
      const unitCost = total / qty;
      this.run(
        'UPDATE productions SET ingredients_cost = ?, total_cost = ?, unit_cost = ? WHERE id = ?',
        ingredientsCost, total, unitCost, prodId,
      );
      this.run(
        'UPDATE beers SET avg_cost = ?, stock = stock + ? WHERE id = ?',
        weightedAvg(beer.stock, beer.avg_cost, qty, unitCost), qty, beer.id,
      );
      this.movement(d, 'beer', beer.id, qty, unitCost, 'Production', 'production', prodId);
      return this.production(prodId);
    });
  }

  deleteProduction(id) {
    this.tx(() => {
      const p = this.production(id);
      const beer = this.beer(p.beer_id);
      this.run(
        'UPDATE beers SET avg_cost = ?, stock = stock - ? WHERE id = ?',
        removeFromAvg(beer.stock, beer.avg_cost, p.quantity, p.unit_cost), p.quantity, beer.id,
      );
      for (const item of p.items) {
        const ing = this.ingredient(item.ingredient_id);
        this.run(
          'UPDATE ingredients SET avg_cost = ?, stock = stock + ? WHERE id = ?',
          weightedAvg(ing.stock, ing.avg_cost, item.quantity, item.unit_cost), item.quantity, ing.id,
        );
      }
      this.run(`DELETE FROM movements WHERE ref_type = 'production' AND ref_id = ?`, id);
      this.run('DELETE FROM productions WHERE id = ?', id);
    });
  }

  // ---------- Achats ----------

  listPurchases() {
    const rows = this.all('SELECT * FROM purchases ORDER BY date DESC, id DESC');
    const items = this.all(
      `SELECT pi.*, i.name AS ingredient_name, i.unit FROM purchase_items pi
       LEFT JOIN ingredients i ON i.id = pi.ingredient_id`,
    );
    for (const r of rows) r.items = items.filter((i) => i.purchase_id === r.id);
    return rows;
  }

  purchase(id) {
    const row = this.get('SELECT * FROM purchases WHERE id = ?', id);
    if (!row) throw notFound('Achat');
    row.items = this.all(
      `SELECT pi.*, i.name AS ingredient_name, i.unit FROM purchase_items pi
       LEFT JOIN ingredients i ON i.id = pi.ingredient_id WHERE pi.purchase_id = ?`,
      id,
    );
    return row;
  }

  createPurchase(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw bad('Ajoutez au moins une ligne à l’achat');
    return this.tx(() => {
      const d = date(data.date);
      const { lastInsertRowid } = this.run(
        'INSERT INTO purchases (date, supplier, reference, notes) VALUES (?, ?, ?, ?)',
        d, str(data.supplier), str(data.reference), str(data.notes),
      );
      const purchaseId = Number(lastInsertRowid);
      let total = 0;
      for (const item of items) {
        const category = str(item.category, 'matiere');
        if (!PURCHASE_CATEGORIES.includes(category)) throw bad(`Catégorie d’achat inconnue : ${category}`);
        const q = num(item.quantity, 'Quantité', { min: 0, allowZero: false });
        const price = num(item.unit_price, 'Prix unitaire', { min: 0 });
        let ingId = null;
        let description = str(item.description);
        if (category === 'matiere') {
          const ing = this.ingredient(num(item.ingredient_id, 'Matière première'));
          ingId = ing.id;
          description = description || ing.name;
          this.run(
            'UPDATE ingredients SET avg_cost = ?, stock = stock + ? WHERE id = ?',
            weightedAvg(ing.stock, ing.avg_cost, q, price), q, ing.id,
          );
          this.movement(d, 'ingredient', ing.id, q, price, `Achat ${str(data.supplier)}`.trim(), 'purchase', purchaseId);
        } else if (!description) {
          throw bad('Indiquez une description pour les achats de matériel ou autres');
        }
        const lineTotal = q * price;
        total += lineTotal;
        this.run(
          `INSERT INTO purchase_items (purchase_id, category, ingredient_id, description, quantity, unit_price, total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          purchaseId, category, ingId, description, q, price, lineTotal,
        );
      }
      this.run('UPDATE purchases SET total = ? WHERE id = ?', total, purchaseId);
      return this.purchase(purchaseId);
    });
  }

  deletePurchase(id) {
    this.tx(() => {
      const p = this.purchase(id);
      for (const item of p.items) {
        if (!item.ingredient_id) continue;
        const ing = this.ingredient(item.ingredient_id);
        this.run(
          'UPDATE ingredients SET avg_cost = ?, stock = stock - ? WHERE id = ?',
          removeFromAvg(ing.stock, ing.avg_cost, item.quantity, item.unit_price), item.quantity, ing.id,
        );
      }
      this.run(`DELETE FROM movements WHERE ref_type = 'purchase' AND ref_id = ?`, id);
      this.run('DELETE FROM purchases WHERE id = ?', id);
    });
  }

  // ---------- Ventes ----------

  listSales() {
    const rows = this.all('SELECT *, total - cost AS margin FROM sales ORDER BY date DESC, id DESC');
    const items = this.all(
      `SELECT si.*, b.name AS beer_name, b.format AS beer_format FROM sale_items si JOIN beers b ON b.id = si.beer_id`,
    );
    for (const r of rows) r.items = items.filter((i) => i.sale_id === r.id);
    return rows;
  }

  sale(id) {
    const row = this.get('SELECT *, total - cost AS margin FROM sales WHERE id = ?', id);
    if (!row) throw notFound('Vente');
    row.items = this.all(
      `SELECT si.*, b.name AS beer_name, b.format AS beer_format FROM sale_items si
       JOIN beers b ON b.id = si.beer_id WHERE si.sale_id = ?`,
      id,
    );
    return row;
  }

  createSale(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw bad('Ajoutez au moins une bière à la vente');
    return this.tx(() => {
      const d = date(data.date);
      const { lastInsertRowid } = this.run(
        'INSERT INTO sales (date, customer, channel, notes) VALUES (?, ?, ?, ?)',
        d, str(data.customer), str(data.channel), str(data.notes),
      );
      const saleId = Number(lastInsertRowid);
      let total = 0;
      let cost = 0;
      for (const item of items) {
        const beer = this.decorateBeer(this.beer(num(item.beer_id, 'Bière')));
        const q = num(item.quantity, 'Quantité', { min: 0, allowZero: false });
        const price = optNum(item.unit_price, 'Prix unitaire', beer.sale_price, { min: 0 });
        // Coût des ventes : CMP réel, ou coût théorique de la recette si la bière n'a jamais été produite.
        const unitCost = beer.avg_cost > 0 ? beer.avg_cost : beer.recipe_unit_cost;
        total += q * price;
        cost += q * unitCost;
        this.run(
          'INSERT INTO sale_items (sale_id, beer_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)',
          saleId, beer.id, q, price, unitCost,
        );
        this.run('UPDATE beers SET stock = stock - ? WHERE id = ?', q, beer.id);
        this.movement(d, 'beer', beer.id, -q, unitCost, `Vente ${str(data.customer)}`.trim(), 'sale', saleId);
      }
      this.run('UPDATE sales SET total = ?, cost = ? WHERE id = ?', total, cost, saleId);
      return this.sale(saleId);
    });
  }

  deleteSale(id) {
    this.tx(() => {
      const s = this.sale(id);
      for (const item of s.items) {
        this.run('UPDATE beers SET stock = stock + ? WHERE id = ?', item.quantity, item.beer_id);
      }
      this.run(`DELETE FROM movements WHERE ref_type = 'sale' AND ref_id = ?`, id);
      this.run('DELETE FROM sales WHERE id = ?', id);
    });
  }

  // ---------- Ajustements d'inventaire ----------

  adjustStock(data) {
    const type = str(data.item_type);
    if (!['ingredient', 'beer'].includes(type)) throw bad('Type d’article invalide');
    const table = type === 'beer' ? 'beers' : 'ingredients';
    return this.tx(() => {
      const id = num(data.item_id, 'Article');
      const item = type === 'beer' ? this.beer(id) : this.ingredient(id);
      // Soit un écart (+/-), soit le stock réel compté lors d'un inventaire.
      const delta = data.counted !== undefined && data.counted !== ''
        ? num(data.counted, 'Stock compté', { min: 0 }) - item.stock
        : num(data.quantity, 'Quantité');
      if (delta === 0) return { ...item };
      this.run(`UPDATE ${table} SET stock = stock + ? WHERE id = ?`, delta, id);
      this.movement(date(data.date), type, id, delta, item.avg_cost, str(data.reason) || 'Ajustement d’inventaire', 'adjustment');
      return this.get(`SELECT * FROM ${table} WHERE id = ?`, id);
    });
  }

  listMovements(limit = 200) {
    return this.all(
      `SELECT m.*, CASE m.item_type WHEN 'beer' THEN b.name ELSE i.name END AS item_name,
              CASE m.item_type WHEN 'beer' THEN 'u.' ELSE i.unit END AS unit
       FROM movements m
       LEFT JOIN beers b ON m.item_type = 'beer' AND b.id = m.item_id
       LEFT JOIN ingredients i ON m.item_type = 'ingredient' AND i.id = m.item_id
       ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      limit,
    );
  }

  // ---------- Tableau de bord ----------

  dashboard({ from, to } = {}) {
    const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : '0000-01-01';
    const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : '9999-12-31';

    const sales = this.get(
      `SELECT COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS count
       FROM sales WHERE date BETWEEN ? AND ?`,
      start, end,
    );
    const purchases = this.all(
      `SELECT pi.category, COALESCE(SUM(pi.total), 0) AS total
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       WHERE p.date BETWEEN ? AND ? GROUP BY pi.category`,
      start, end,
    );
    const purchaseByCat = Object.fromEntries(PURCHASE_CATEGORIES.map((c) => [c, 0]));
    for (const p of purchases) purchaseByCat[p.category] = p.total;

    const production = this.get(
      `SELECT COALESCE(SUM(quantity), 0) AS units, COALESCE(SUM(total_cost), 0) AS cost, COUNT(*) AS count
       FROM productions WHERE date BETWEEN ? AND ?`,
      start, end,
    );

    const stockValue = {
      ingredients: this.get('SELECT COALESCE(SUM(MAX(stock, 0) * avg_cost), 0) AS v FROM ingredients').v,
      beers: this.get('SELECT COALESCE(SUM(MAX(stock, 0) * avg_cost), 0) AS v FROM beers').v,
    };

    const alerts = [
      ...this.all(`SELECT 'ingredient' AS type, id, name, stock, min_stock, unit FROM ingredients
                   WHERE stock <= min_stock AND (min_stock > 0 OR stock < 0)`),
      ...this.all(`SELECT 'beer' AS type, id, name || ' (' || format || ')' AS name, stock, min_stock, 'u.' AS unit
                   FROM beers WHERE stock <= min_stock AND (min_stock > 0 OR stock < 0)`),
    ];

    const topBeers = this.all(
      `SELECT b.name, b.format, SUM(si.quantity) AS quantity, SUM(si.quantity * si.unit_price) AS revenue,
              SUM(si.quantity * (si.unit_price - si.unit_cost)) AS margin
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN beers b ON b.id = si.beer_id
       WHERE s.date BETWEEN ? AND ? GROUP BY b.id ORDER BY revenue DESC LIMIT 10`,
      start, end,
    );

    const monthly = this.all(
      `WITH m AS (
         SELECT substr(date, 1, 7) AS month, total AS revenue, cost AS cogs, 0 AS purchases FROM sales
         WHERE date BETWEEN ? AND ?
         UNION ALL
         SELECT substr(date, 1, 7), 0, 0, total FROM purchases WHERE date BETWEEN ? AND ?
       )
       SELECT month, SUM(revenue) AS revenue, SUM(cogs) AS cogs, SUM(purchases) AS purchases
       FROM m GROUP BY month ORDER BY month DESC LIMIT 12`,
      start, end, start, end,
    ).reverse();

    const totalPurchases = Object.values(purchaseByCat).reduce((a, b) => a + b, 0);
    return {
      period: { from: from || null, to: to || null },
      revenue: sales.revenue,
      cogs: sales.cost,
      gross_margin: sales.revenue - sales.cost,
      margin_rate: sales.revenue > 0 ? (sales.revenue - sales.cost) / sales.revenue : null,
      sales_count: sales.count,
      purchases: { ...purchaseByCat, total: totalPurchases },
      // Trésorerie simplifiée : encaissements des ventes - décaissements des achats.
      cash_result: sales.revenue - totalPurchases,
      production,
      stock_value: { ...stockValue, total: stockValue.ingredients + stockValue.beers },
      alerts,
      top_beers: topBeers,
      monthly,
    };
  }
}

module.exports = { Store, HttpError, weightedAvg, removeFromAvg };
