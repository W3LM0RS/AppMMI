'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

function setup() {
  const s = new Store();
  const malt = s.saveIngredient({ name: 'Malt Pale', category: 'Malt', unit: 'kg', min_stock: 10 });
  const hop = s.saveIngredient({ name: 'Houblon Cascade', category: 'Houblon', unit: 'kg' });
  const bottle = s.saveIngredient({ name: 'Bouteille 33cl', category: 'Conditionnement', unit: 'unité' });
  const beer = s.saveBeer({ name: 'Blonde', format: 'Bouteille 33cl', sale_price: 3, batch_yield: 100 });
  return { s, malt, hop, bottle, beer };
}

test('achat de matière : stock et coût moyen pondéré', () => {
  const { s, malt } = setup();
  s.createPurchase({ date: '2026-01-10', supplier: 'Malterie', items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 100, unit_price: 1 }] });
  s.createPurchase({ date: '2026-01-20', items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 100, unit_price: 2 }] });
  const m = s.ingredient(malt.id);
  assert.equal(m.stock, 200);
  close(m.avg_cost, 1.5);
});

test('achat de matériel : n’affecte pas les stocks, exige une description', () => {
  const { s } = setup();
  const p = s.createPurchase({ items: [{ category: 'materiel', description: 'Fermenteur 100L', quantity: 2, unit_price: 250 }] });
  assert.equal(p.total, 500);
  assert.throws(() => s.createPurchase({ items: [{ category: 'autre', quantity: 1, unit_price: 5 }] }), /description/);
});

test('suppression d’un achat : stock et CMP rétablis', () => {
  const { s, malt } = setup();
  s.createPurchase({ items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 100, unit_price: 1 }] });
  const p = s.createPurchase({ items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 100, unit_price: 3 }] });
  s.deletePurchase(p.id);
  const m = s.ingredient(malt.id);
  assert.equal(m.stock, 100);
  close(m.avg_cost, 1);
});

test('production depuis la recette : consommation et coût de revient', () => {
  const { s, malt, hop, bottle, beer } = setup();
  s.createPurchase({ items: [
    { category: 'matiere', ingredient_id: malt.id, quantity: 50, unit_price: 1.2 },
    { category: 'matiere', ingredient_id: hop.id, quantity: 2, unit_price: 30 },
    { category: 'matiere', ingredient_id: bottle.id, quantity: 500, unit_price: 0.25 },
  ] });
  s.saveRecipe(beer.id, { batch_yield: 100, items: [
    { ingredient_id: malt.id, quantity: 10 },
    { ingredient_id: hop.id, quantity: 0.5 },
    { ingredient_id: bottle.id, quantity: 100 },
  ] });
  // Recette : 12 + 15 + 25 = 52 € pour 100 bouteilles.
  close(s.recipeCost(beer.id).unit, 0.52);

  const p = s.createProduction({ date: '2026-02-01', beer_id: beer.id, quantity: 200, extra_cost: 16 });
  close(p.ingredients_cost, 104);
  close(p.unit_cost, 0.6);
  assert.equal(s.ingredient(malt.id).stock, 30);
  assert.equal(s.ingredient(bottle.id).stock, 300);
  const b = s.beer(beer.id);
  assert.equal(b.stock, 200);
  close(b.avg_cost, 0.6);

  s.deleteProduction(p.id);
  assert.equal(s.ingredient(malt.id).stock, 50);
  assert.equal(s.beer(beer.id).stock, 0);
});

test('production sans recette ni détail : refusée', () => {
  const { s, beer } = setup();
  assert.throws(() => s.createProduction({ beer_id: beer.id, quantity: 10 }), /recette/);
});

test('vente : sortie de stock, coût des ventes et marge', () => {
  const { s, malt, beer } = setup();
  s.createPurchase({ items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 10, unit_price: 5 }] });
  s.createProduction({ beer_id: beer.id, quantity: 100, items: [{ ingredient_id: malt.id, quantity: 10 }] });
  const sale = s.createSale({ date: '2026-03-01', customer: 'Bar', items: [
    { beer_id: beer.id, quantity: 24 },
    { beer_id: beer.id, quantity: 6, unit_price: 2.5 },
  ] });
  close(sale.total, 24 * 3 + 6 * 2.5);
  close(sale.cost, 30 * 0.5);
  close(sale.margin, 87 - 15);
  assert.equal(s.beer(beer.id).stock, 70);

  const d = s.dashboard({ from: '2026-03-01', to: '2026-03-31' });
  close(d.revenue, 87);
  close(d.gross_margin, 72);
  assert.equal(d.top_beers[0].quantity, 30);

  s.deleteSale(sale.id);
  assert.equal(s.beer(beer.id).stock, 100);
});

test('ajustement d’inventaire par comptage et alerte stock bas', () => {
  const { s, malt } = setup();
  s.createPurchase({ items: [{ category: 'matiere', ingredient_id: malt.id, quantity: 20, unit_price: 1 }] });
  s.adjustStock({ item_type: 'ingredient', item_id: malt.id, counted: 8, reason: 'Inventaire' });
  assert.equal(s.ingredient(malt.id).stock, 8);
  const alerts = s.dashboard().alerts;
  assert.ok(alerts.some((a) => a.name === 'Malt Pale'));
});

test('suppression d’une matière utilisée dans une recette : refusée', () => {
  const { s, malt, beer } = setup();
  s.saveRecipe(beer.id, { items: [{ ingredient_id: malt.id, quantity: 1 }] });
  assert.throws(() => s.deleteIngredient(malt.id), /suppression impossible/);
});

test('API HTTP : création et lecture', async () => {
  const { s } = setup();
  const server = createServer(s).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/api/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Levure US-05', unit: 'g', stock: '500', avg_cost: '0,08' }),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    close(created.avg_cost, 0.08);

    res = await fetch(`${base}/api/ingredients`, { method: 'POST', body: JSON.stringify({ name: '' }) });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/dashboard`);
    assert.equal(res.status, 200);
    close((await res.json()).stock_value.ingredients, 40);

    res = await fetch(`${base}/`);
    assert.match(await res.text(), /Gestion Brasserie/);
  } finally {
    server.close();
  }
});
