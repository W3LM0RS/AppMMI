'use strict';

// ---------- Utilitaires ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => (Number(v) || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const qty = (v, d = 3) => (Number(v) || 0).toLocaleString('fr-FR', { maximumFractionDigits: d });
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const fdate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR') : '');
const today = () => new Date().toISOString().slice(0, 10);
const toNum = (v) => Number(String(v ?? '').replace(',', '.')) || 0;
const signClass = (v) => (v < 0 ? 'neg' : v > 0 ? 'pos' : '');

const PURCHASE_CATS = { matiere: 'Matière première', materiel: 'Matériel', autre: 'Autre' };
const ING_CATS = ['Malt', 'Houblon', 'Levure', 'Sucre / adjuvant', 'Conditionnement', 'Nettoyage', 'Autre'];
const UNITS = ['kg', 'g', 'L', 'unité'];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), error ? 5000 : 2500);
}

const options = (list, selected, { value = (x) => x.id, label = (x) => x.name, placeholder } = {}) =>
  (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
  list.map((x) => `<option value="${esc(value(x))}" ${String(value(x)) === String(selected ?? '') ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

function table(columns, rows, empty = 'Aucune donnée pour le moment') {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr class="${r._class || ''}">${columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls ? c.cls(r) : ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${esc(empty)}</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- Fenêtre modale ----------

function openModal({ title, body, submitLabel = 'Enregistrer', footer = '', onSubmit, onInput, onReady }) {
  const dialog = $('#modal');
  const form = $('#modal-form');
  form.innerHTML = `
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="small" data-close>✕</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot"><div class="total" id="modal-total">${footer}</div>
      <div><button type="button" data-close>Annuler</button> <button type="submit" class="primary">${esc(submitLabel)}</button></div>
    </div>`;
  const close = () => dialog.close();
  $$('[data-close]', form).forEach((b) => (b.onclick = close));
  form.oninput = onInput ? () => onInput(form) : null;
  form.onchange = onInput ? () => onInput(form) : null;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await onSubmit(form);
      close();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  dialog.showModal();
  onReady?.(form);
  onInput?.(form);
}

const field = (form, name) => form.elements[name]?.value ?? '';

function lineRows(form) {
  return $$('tbody.lines tr', form);
}

// ---------- Vues ----------

const views = {};

views.dashboard = async (el) => {
  const period = sessionStorage.getItem('period') || 'month';
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const ranges = {
    month: { from: `${y}-${m}-01`, to: `${y}-${m}-31` },
    year: { from: `${y}-01-01`, to: `${y}-12-31` },
    last12: { from: new Date(y, now.getMonth() - 11, 1).toLocaleDateString('sv'), to: today() },
    all: {},
  };
  const r = ranges[period] || {};
  const q = new URLSearchParams(Object.entries(r)).toString();
  const d = await api(`dashboard${q ? `?${q}` : ''}`);

  const maxBar = Math.max(1, ...d.monthly.flatMap((x) => [x.revenue, x.purchases]));
  const bars = d.monthly.length
    ? d.monthly.map((x) => `
        <div class="bar-group" title="${esc(x.month)} — Ventes ${eur(x.revenue)} / Achats ${eur(x.purchases)}">
          <div class="bar-pair">
            <div class="bar rev" style="height:${(x.revenue / maxBar) * 100}%"></div>
            <div class="bar pur" style="height:${(x.purchases / maxBar) * 100}%"></div>
          </div>
          <div class="bar-label">${esc(x.month.slice(5))}/${esc(x.month.slice(2, 4))}</div>
        </div>`).join('')
    : '<p class="hint">Pas encore de ventes ni d’achats sur la période.</p>';

  el.innerHTML = `
    <div class="page-head">
      <h1>Tableau de bord</h1>
      <div class="filters">
        <select id="period">
          ${options([
            { id: 'month', name: 'Ce mois-ci' }, { id: 'year', name: 'Cette année' },
            { id: 'last12', name: '12 derniers mois' }, { id: 'all', name: 'Depuis le début' },
          ], period)}
        </select>
      </div>
    </div>
    <div class="grid">
      <div class="kpi"><div class="label">Chiffre d’affaires HT</div><div class="value">${eur(d.revenue)}</div><div class="sub">${d.sales_count} vente(s)</div></div>
      <div class="kpi"><div class="label">Coût des bières vendues</div><div class="value">${eur(d.cogs)}</div><div class="sub">au coût de revient</div></div>
      <div class="kpi"><div class="label">Marge brute</div><div class="value ${signClass(d.gross_margin)}">${eur(d.gross_margin)}</div><div class="sub">taux : ${pct(d.margin_rate)}</div></div>
      <div class="kpi"><div class="label">Total achats</div><div class="value">${eur(d.purchases.total)}</div><div class="sub">Matières ${eur(d.purchases.matiere)} · Matériel ${eur(d.purchases.materiel)} · Autre ${eur(d.purchases.autre)}</div></div>
      <div class="kpi"><div class="label">Ventes − achats</div><div class="value ${signClass(d.cash_result)}">${eur(d.cash_result)}</div><div class="sub">résultat de trésorerie simplifié</div></div>
      <div class="kpi"><div class="label">Production</div><div class="value">${qty(d.production.units, 0)} u.</div><div class="sub">${d.production.count} lot(s) · ${eur(d.production.cost)}</div></div>
      <div class="kpi"><div class="label">Valeur du stock</div><div class="value">${eur(d.stock_value.total)}</div><div class="sub">Bières ${eur(d.stock_value.beers)} · Matières ${eur(d.stock_value.ingredients)}</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Ventes et achats par mois</h2>
        <div class="bars">${bars}</div>
        <div class="legend"><span style="--c:var(--accent)">Ventes HT</span><span style="--c:var(--muted)">Achats</span></div>
      </div>
      <div class="card">
        <h2>Alertes de stock</h2>
        ${table([
          { label: 'Article', html: (a) => `${esc(a.name)} <span class="badge">${a.type === 'beer' ? 'Bière' : 'Matière'}</span>` },
          { label: 'Stock', num: true, cls: (a) => signClass(a.stock < 0 ? -1 : 0), html: (a) => `${qty(a.stock)} ${esc(a.unit)}` },
          { label: 'Minimum', num: true, html: (a) => `${qty(a.min_stock)} ${esc(a.unit)}` },
        ], d.alerts, 'Aucune alerte — tous les stocks sont au-dessus du minimum 👍')}
      </div>
    </div>
    <div class="card">
      <h2>Bières les plus vendues</h2>
      ${table([
        { label: 'Bière', html: (b) => `${esc(b.name)} <span class="badge">${esc(b.format)}</span>` },
        { label: 'Quantité', num: true, html: (b) => qty(b.quantity) },
        { label: 'CA HT', num: true, html: (b) => eur(b.revenue) },
        { label: 'Marge', num: true, cls: (b) => signClass(b.margin), html: (b) => eur(b.margin) },
        { label: 'Taux', num: true, html: (b) => pct(b.revenue ? b.margin / b.revenue : null) },
      ], d.top_beers, 'Aucune vente sur la période')}
    </div>`;
  $('#period').onchange = (e) => {
    sessionStorage.setItem('period', e.target.value);
    render();
  };
};

// ----- Bières -----

views.beers = async (el) => {
  const beers = await api('beers');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Bières</h1><p class="hint">Coût de revient = coût moyen pondéré des lots produits (ou coût théorique de la recette si aucune production).</p></div>
      <button class="primary" id="add">+ Nouvelle bière</button>
    </div>
    <div class="card">${table([
      { label: 'Bière', html: (b) => `<strong>${esc(b.name)}</strong><div class="sub-lines">${esc(b.style)}</div>` },
      { label: 'Format', html: (b) => esc(b.format) },
      { label: 'Stock', num: true, cls: (b) => signClass(b.stock < 0 ? -1 : 0), html: (b) => `${qty(b.stock)} u.` },
      { label: 'Prix vente HT', num: true, html: (b) => eur(b.sale_price) },
      { label: 'Coût de revient', num: true, html: (b) => (b.avg_cost > 0 ? eur(b.avg_cost) : '—') },
      { label: 'Coût recette', num: true, html: (b) => (b.recipe_unit_cost > 0 ? eur(b.recipe_unit_cost) : '—') },
      { label: 'Marge / u.', num: true, cls: (b) => signClass(b.unit_margin), html: (b) => eur(b.unit_margin) },
      { label: 'Taux marge', num: true, html: (b) => pct(b.margin_rate) },
      { label: 'Valeur stock', num: true, html: (b) => eur(b.value) },
      { label: '', html: (b) => `<span class="actions">
          <button class="small" data-recipe="${b.id}">Recette</button>
          <button class="small" data-adjust="${b.id}">Inventaire</button>
          <button class="small" data-edit="${b.id}">Modifier</button>
          <button class="small danger" data-del="${b.id}">✕</button></span>` },
    ], beers.map((b) => ({ ...b, _class: b.stock <= b.min_stock && b.min_stock > 0 ? 'low' : '' })), 'Aucune bière. Commencez par en créer une.')}</div>`;

  const byId = (id) => beers.find((b) => b.id === Number(id));
  $('#add').onclick = () => beerForm();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => beerForm(byId(b.dataset.edit))));
  $$('[data-recipe]', el).forEach((b) => (b.onclick = () => recipeForm(byId(b.dataset.recipe))));
  $$('[data-adjust]', el).forEach((b) => (b.onclick = () => adjustForm('beer', byId(b.dataset.adjust))));
  $$('[data-del]', el).forEach((b) => (b.onclick = () => remove(`beers/${b.dataset.del}`, `Supprimer la bière « ${byId(b.dataset.del).name} » ?`)));
};

function beerForm(b = null) {
  openModal({
    title: b ? `Modifier ${b.name}` : 'Nouvelle bière',
    body: `<div class="form-grid">
      <label>Nom *<input name="name" required value="${esc(b?.name)}"></label>
      <label>Style<input name="style" placeholder="IPA, Blonde, Stout…" value="${esc(b?.style)}"></label>
      <label>Format<input name="format" list="formats" value="${esc(b?.format ?? 'Bouteille 33cl')}"></label>
      <label>Volume unitaire (L)<input name="volume_l" inputmode="decimal" value="${esc(b?.volume_l ?? 0.33)}"></label>
      <label>Prix de vente HT (€)<input name="sale_price" inputmode="decimal" value="${esc(b?.sale_price ?? '')}"></label>
      <label>Stock minimum (u.)<input name="min_stock" inputmode="decimal" value="${esc(b?.min_stock ?? 0)}"></label>
      ${b ? '' : `
      <label>Stock initial (u.)<input name="stock" inputmode="decimal" value="0"></label>
      <label>Coût unitaire du stock initial (€)<input name="avg_cost" inputmode="decimal" value="0"></label>`}
    </div>
    <datalist id="formats"><option>Bouteille 33cl</option><option>Bouteille 75cl</option><option>Canette 44cl</option><option>Fût 20L</option><option>Fût 30L</option></datalist>`,
    onSubmit: async (f) => {
      const data = Object.fromEntries(new FormData(f));
      await api(b ? `beers/${b.id}` : 'beers', { method: b ? 'PUT' : 'POST', body: data });
      toast('Bière enregistrée');
    },
  });
}

async function recipeForm(beer) {
  const [{ items }, ingredients] = await Promise.all([api(`beers/${beer.id}/recipe`), api('ingredients')]);
  const ingById = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  const row = (it = {}) => `<tr>
      <td><select name="ingredient_id">${options(ingredients, it.ingredient_id, { placeholder: '— Choisir —', label: (i) => `${i.name} (${i.unit})` })}</select></td>
      <td><input name="quantity" inputmode="decimal" value="${esc(it.quantity ?? '')}" style="width:110px"></td>
      <td class="num" data-cost></td>
      <td><button type="button" class="small danger" data-rm>✕</button></td></tr>`;
  openModal({
    title: `Recette — ${beer.name} (${beer.format})`,
    body: `
      <p class="hint">Indiquez les matières premières (y compris bouteilles, capsules, étiquettes…) nécessaires pour produire le nombre d’unités ci-dessous.
      Elles seront automatiquement déduites du stock à chaque production.</p>
      <label style="max-width:280px">Nombre d’unités produites par cette recette<input name="batch_yield" inputmode="decimal" value="${esc(beer.batch_yield)}"></label>
      <div class="table-wrap"><table><thead><tr><th>Matière première</th><th>Quantité</th><th class="num">Coût</th><th></th></tr></thead>
      <tbody class="lines">${(items.length ? items : [{}]).map(row).join('')}</tbody></table></div>
      <button type="button" class="link" id="add-line">+ Ajouter une ligne</button>`,
    onReady: (f) => {
      $('#add-line', f).onclick = () => { $('tbody.lines', f).insertAdjacentHTML('beforeend', row()); f.oninput(); };
      $('tbody.lines', f).onclick = (e) => { if (e.target.dataset.rm !== undefined) { e.target.closest('tr').remove(); f.oninput(); } };
    },
    onInput: (f) => {
      let total = 0;
      for (const tr of lineRows(f)) {
        const ing = ingById[$('[name=ingredient_id]', tr).value];
        const c = ing ? toNum($('[name=quantity]', tr).value) * ing.avg_cost : 0;
        total += c;
        $('[data-cost]', tr).textContent = ing ? eur(c) : '';
      }
      const y = toNum(field(f, 'batch_yield'));
      $('#modal-total').innerHTML = `Coût matières : ${eur(total)} · <span>par unité : ${eur(y > 0 ? total / y : 0)}</span>`;
    },
    onSubmit: async (f) => {
      const lines = lineRows(f)
        .map((tr) => ({ ingredient_id: $('[name=ingredient_id]', tr).value, quantity: $('[name=quantity]', tr).value }))
        .filter((l) => l.ingredient_id);
      await api(`beers/${beer.id}/recipe`, { method: 'PUT', body: { batch_yield: field(f, 'batch_yield'), items: lines } });
      toast('Recette enregistrée');
    },
  });
}

function adjustForm(type, item) {
  const unit = type === 'beer' ? 'u.' : item.unit;
  openModal({
    title: `Inventaire — ${item.name}`,
    body: `<p class="hint">Stock actuel : <strong>${qty(item.stock)} ${esc(unit)}</strong>. Renseignez soit le stock réellement compté, soit un écart (+/−).</p>
      <div class="form-grid">
        <label>Date<input type="date" name="date" value="${today()}"></label>
        <label>Stock compté (${esc(unit)})<input name="counted" inputmode="decimal" placeholder="ex : ${qty(item.stock)}"></label>
        <label>ou écart (+/−)<input name="quantity" inputmode="decimal" placeholder="ex : -3"></label>
        <label>Motif<input name="reason" list="reasons" placeholder="Inventaire, casse, perte…"></label>
      </div>
      <datalist id="reasons"><option>Inventaire</option><option>Casse</option><option>Perte</option><option>Dégustation / échantillons</option><option>Péremption</option></datalist>`,
    submitLabel: 'Valider',
    onSubmit: async (f) => {
      const data = Object.fromEntries(new FormData(f));
      if (data.counted === '' && data.quantity === '') throw new Error('Indiquez un stock compté ou un écart');
      if (data.counted === '') delete data.counted;
      await api('adjustments', { method: 'POST', body: { ...data, item_type: type, item_id: item.id } });
      toast('Stock ajusté');
    },
  });
}

// ----- Matières premières -----

views.ingredients = async (el) => {
  const list = await api('ingredients');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Matières premières</h1><p class="hint">Le coût unitaire (CMP) est recalculé automatiquement à chaque achat (coût moyen pondéré).</p></div>
      <button class="primary" id="add">+ Nouvelle matière</button>
    </div>
    <div class="card">${table([
      { label: 'Catégorie', html: (i) => `<span class="badge">${esc(i.category)}</span>` },
      { label: 'Nom', html: (i) => `<strong>${esc(i.name)}</strong>${i.supplier ? `<div class="sub-lines">${esc(i.supplier)}</div>` : ''}` },
      { label: 'Stock', num: true, cls: (i) => signClass(i.stock < 0 ? -1 : 0), html: (i) => `${qty(i.stock)} ${esc(i.unit)}` },
      { label: 'Minimum', num: true, html: (i) => `${qty(i.min_stock)} ${esc(i.unit)}` },
      { label: 'Coût unitaire (CMP)', num: true, html: (i) => `${eur(i.avg_cost)} / ${esc(i.unit)}` },
      { label: 'Valeur stock', num: true, html: (i) => eur(Math.max(i.stock, 0) * i.avg_cost) },
      { label: '', html: (i) => `<span class="actions">
          <button class="small" data-adjust="${i.id}">Inventaire</button>
          <button class="small" data-edit="${i.id}">Modifier</button>
          <button class="small danger" data-del="${i.id}">✕</button></span>` },
    ], list.map((i) => ({ ...i, _class: i.stock <= i.min_stock && i.min_stock > 0 ? 'low' : '' })), 'Aucune matière première. Ajoutez vos malts, houblons, levures, bouteilles…')}</div>`;

  const byId = (id) => list.find((i) => i.id === Number(id));
  $('#add').onclick = () => ingredientForm();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => ingredientForm(byId(b.dataset.edit))));
  $$('[data-adjust]', el).forEach((b) => (b.onclick = () => adjustForm('ingredient', byId(b.dataset.adjust))));
  $$('[data-del]', el).forEach((b) => (b.onclick = () => remove(`ingredients/${b.dataset.del}`, `Supprimer « ${byId(b.dataset.del).name} » ?`)));
};

function ingredientForm(i = null) {
  openModal({
    title: i ? `Modifier ${i.name}` : 'Nouvelle matière première',
    body: `<div class="form-grid">
      <label>Nom *<input name="name" required value="${esc(i?.name)}"></label>
      <label>Catégorie<select name="category">${options(ING_CATS.map((c) => ({ id: c, name: c })), i?.category ?? 'Malt')}</select></label>
      <label>Unité<select name="unit">${options(UNITS.map((u) => ({ id: u, name: u })), i?.unit ?? 'kg')}</select></label>
      <label>Stock minimum<input name="min_stock" inputmode="decimal" value="${esc(i?.min_stock ?? 0)}"></label>
      <label>Fournisseur habituel<input name="supplier" value="${esc(i?.supplier)}"></label>
      ${i ? '' : `
      <label>Stock initial<input name="stock" inputmode="decimal" value="0"></label>
      <label>Coût unitaire du stock initial (€)<input name="avg_cost" inputmode="decimal" value="0"></label>`}
    </div>`,
    onSubmit: async (f) => {
      const data = Object.fromEntries(new FormData(f));
      await api(i ? `ingredients/${i.id}` : 'ingredients', { method: i ? 'PUT' : 'POST', body: data });
      toast('Matière première enregistrée');
    },
  });
}

// ----- Production -----

views.productions = async (el) => {
  const list = await api('productions');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Production</h1><p class="hint">Chaque lot consomme les matières premières, alimente le stock de bière et calcule son coût de revient.</p></div>
      <button class="primary" id="add">+ Nouvelle production</button>
    </div>
    <div class="card">${table([
      { label: 'Date', html: (p) => fdate(p.date) },
      { label: 'Bière', html: (p) => `<strong>${esc(p.beer_name)}</strong> <span class="badge">${esc(p.beer_format)}</span>${p.notes ? `<div class="sub-lines">${esc(p.notes)}</div>` : ''}` },
      { label: 'Quantité', num: true, html: (p) => `${qty(p.quantity)} u.` },
      { label: 'Matières', num: true, html: (p) => eur(p.ingredients_cost) },
      { label: 'Autres coûts', num: true, html: (p) => eur(p.extra_cost) },
      { label: 'Coût total', num: true, html: (p) => eur(p.total_cost) },
      { label: 'Coût / u.', num: true, html: (p) => `<strong>${eur(p.unit_cost)}</strong>` },
      { label: '', html: (p) => `<span class="actions"><button class="small danger" data-del="${p.id}">✕</button></span>` },
    ], list, 'Aucune production enregistrée')}</div>`;
  $('#add').onclick = productionForm;
  $$('[data-del]', el).forEach((b) => (b.onclick = () => remove(`productions/${b.dataset.del}`, 'Supprimer cette production ? Les stocks seront rétablis.')));
};

async function productionForm() {
  const [beers, ingredients] = await Promise.all([api('beers'), api('ingredients')]);
  if (!beers.length) return toast('Créez d’abord une bière', true);
  const ingById = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  const row = (it = {}) => `<tr>
      <td><select name="ingredient_id">${options(ingredients, it.ingredient_id, { placeholder: '— Choisir —', label: (i) => `${i.name} (${i.unit})` })}</select></td>
      <td><input name="line_qty" inputmode="decimal" value="${esc(it.quantity !== undefined ? +Number(it.quantity).toFixed(4) : '')}" style="width:110px"></td>
      <td class="num" data-stock></td><td class="num" data-cost></td>
      <td><button type="button" class="small danger" data-rm>✕</button></td></tr>`;

  async function loadRecipe(f) {
    const beer = beers.find((b) => b.id === Number(field(f, 'beer_id')));
    if (!beer) return;
    const { items } = await api(`beers/${beer.id}/recipe`);
    const factor = toNum(field(f, 'quantity')) / beer.batch_yield;
    $('tbody.lines', f).innerHTML = items.length
      ? items.map((it) => row({ ingredient_id: it.ingredient_id, quantity: it.quantity * factor })).join('')
      : row();
    if (!items.length) toast('Pas de recette pour cette bière : saisissez les matières à la main');
    f.oninput();
  }

  openModal({
    title: 'Nouvelle production',
    body: `<div class="form-grid">
        <label>Date<input type="date" name="date" value="${today()}"></label>
        <label>Bière<select name="beer_id">${options(beers, beers[0].id, { label: (b) => `${b.name} — ${b.format}` })}</select></label>
        <label>Quantité produite (u.)<input name="quantity" inputmode="decimal" required value="${esc(beers[0].batch_yield)}"></label>
        <label>Autres coûts (€)<input name="extra_cost" inputmode="decimal" value="0" title="Énergie, eau, main d’œuvre, CO2…"></label>
      </div>
      <label style="margin-top:12px">Notes<input name="notes" placeholder="N° de brassin, DLUO…"></label>
      <h2 style="margin-top:16px">Matières consommées <button type="button" class="link" id="load">↻ recalculer depuis la recette</button></h2>
      <div class="table-wrap"><table><thead><tr><th>Matière première</th><th>Quantité</th><th class="num">Stock dispo</th><th class="num">Coût</th><th></th></tr></thead>
      <tbody class="lines"></tbody></table></div>
      <button type="button" class="link" id="add-line">+ Ajouter une ligne</button>`,
    submitLabel: 'Enregistrer la production',
    onReady: (f) => {
      $('#add-line', f).onclick = () => { $('tbody.lines', f).insertAdjacentHTML('beforeend', row()); f.oninput(); };
      $('#load', f).onclick = () => loadRecipe(f);
      $('[name=beer_id]', f).addEventListener('change', () => {
        const beer = beers.find((b) => b.id === Number(field(f, 'beer_id')));
        f.elements.quantity.value = beer.batch_yield;
        loadRecipe(f);
      });
      $('tbody.lines', f).onclick = (e) => { if (e.target.dataset.rm !== undefined) { e.target.closest('tr').remove(); f.oninput(); } };
      loadRecipe(f);
    },
    onInput: (f) => {
      let mat = 0;
      for (const tr of lineRows(f)) {
        const ing = ingById[$('[name=ingredient_id]', tr).value];
        const q = toNum($('[name=line_qty]', tr).value);
        mat += ing ? q * ing.avg_cost : 0;
        $('[data-cost]', tr).textContent = ing ? eur(q * ing.avg_cost) : '';
        const s = $('[data-stock]', tr);
        s.textContent = ing ? `${qty(ing.stock)} ${ing.unit}` : '';
        s.className = `num ${ing && q > ing.stock ? 'neg' : ''}`;
      }
      const total = mat + toNum(field(f, 'extra_cost'));
      const n = toNum(field(f, 'quantity'));
      $('#modal-total').textContent = `Coût total : ${eur(total)} · coût de revient : ${eur(n > 0 ? total / n : 0)} / u.`;
    },
    onSubmit: async (f) => {
      const items = lineRows(f)
        .map((tr) => ({ ingredient_id: $('[name=ingredient_id]', tr).value, quantity: $('[name=line_qty]', tr).value }))
        .filter((l) => l.ingredient_id);
      if (!items.length && !confirm('Aucune matière consommée : enregistrer quand même ?')) throw new Error('Production non enregistrée');
      const head = Object.fromEntries(['date', 'beer_id', 'quantity', 'extra_cost', 'notes'].map((k) => [k, field(f, k)]));
      await api('productions', { method: 'POST', body: { ...head, items } });
      toast('Production enregistrée');
    },
  });
}

// ----- Achats -----

views.purchases = async (el) => {
  const list = await api('purchases');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Achats</h1><p class="hint">Les achats de matières premières mettent à jour le stock et le coût moyen. Matériel et autres frais sont suivis en dépenses.</p></div>
      <button class="primary" id="add">+ Nouvel achat</button>
    </div>
    <div class="card">${table([
      { label: 'Date', html: (p) => fdate(p.date) },
      { label: 'Fournisseur', html: (p) => `<strong>${esc(p.supplier || '—')}</strong>${p.reference ? `<div class="sub-lines">Réf. ${esc(p.reference)}</div>` : ''}` },
      { label: 'Détail', html: (p) => `<div class="sub-lines">${p.items.map((i) => `<span class="badge">${esc(PURCHASE_CATS[i.category])}</span> ${esc(i.description)} — ${qty(i.quantity)}${i.unit ? ` ${esc(i.unit)}` : ''} × ${eur(i.unit_price)}`).join('<br>')}</div>` },
      { label: 'Total HT', num: true, html: (p) => `<strong>${eur(p.total)}</strong>` },
      { label: '', html: (p) => `<span class="actions"><button class="small danger" data-del="${p.id}">✕</button></span>` },
    ], list, 'Aucun achat enregistré')}</div>`;
  $('#add').onclick = purchaseForm;
  $$('[data-del]', el).forEach((b) => (b.onclick = () => remove(`purchases/${b.dataset.del}`, 'Supprimer cet achat ? Le stock des matières sera corrigé.')));
};

async function purchaseForm() {
  const ingredients = await api('ingredients');
  const row = () => `<tr>
      <td><select name="category">${options(Object.entries(PURCHASE_CATS).map(([id, name]) => ({ id, name })), ingredients.length ? 'matiere' : 'materiel')}</select></td>
      <td><select name="ingredient_id">${options(ingredients, '', { placeholder: '— Choisir —', label: (i) => `${i.name} (${i.unit})` })}</select>
          <input name="description" placeholder="Description (ex : fermenteur 100L)" hidden></td>
      <td><input name="quantity" inputmode="decimal" value="1" style="width:90px"></td>
      <td><input name="unit_price" inputmode="decimal" placeholder="0,00" style="width:100px"></td>
      <td class="num" data-total></td>
      <td><button type="button" class="small danger" data-rm>✕</button></td></tr>`;
  openModal({
    title: 'Nouvel achat',
    body: `<div class="form-grid">
        <label>Date<input type="date" name="date" value="${today()}"></label>
        <label>Fournisseur<input name="supplier"></label>
        <label>N° facture<input name="reference"></label>
      </div>
      <h2 style="margin-top:16px">Lignes (prix unitaires HT)</h2>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>Article</th><th>Qté</th><th>Prix unit. HT</th><th class="num">Total</th><th></th></tr></thead>
      <tbody class="lines">${row()}</tbody></table></div>
      <button type="button" class="link" id="add-line">+ Ajouter une ligne</button>
      ${ingredients.length ? '' : '<p class="hint">Astuce : créez vos matières premières pour que leurs achats alimentent automatiquement le stock.</p>'}`,
    onReady: (f) => {
      $('#add-line', f).onclick = () => { $('tbody.lines', f).insertAdjacentHTML('beforeend', row()); f.oninput(); };
      $('tbody.lines', f).onclick = (e) => { if (e.target.dataset.rm !== undefined) { e.target.closest('tr').remove(); f.oninput(); } };
    },
    onInput: (f) => {
      let total = 0;
      for (const tr of lineRows(f)) {
        const isMat = $('[name=category]', tr).value === 'matiere';
        $('[name=ingredient_id]', tr).hidden = !isMat;
        $('[name=description]', tr).hidden = isMat;
        const t = toNum($('[name=quantity]', tr).value) * toNum($('[name=unit_price]', tr).value);
        total += t;
        $('[data-total]', tr).textContent = eur(t);
      }
      $('#modal-total').textContent = `Total HT : ${eur(total)}`;
    },
    onSubmit: async (f) => {
      const items = lineRows(f).map((tr) => {
        const category = $('[name=category]', tr).value;
        return {
          category,
          ingredient_id: category === 'matiere' ? $('[name=ingredient_id]', tr).value : null,
          description: category === 'matiere' ? '' : $('[name=description]', tr).value,
          quantity: $('[name=quantity]', tr).value,
          unit_price: $('[name=unit_price]', tr).value,
        };
      });
      await api('purchases', { method: 'POST', body: { date: field(f, 'date'), supplier: field(f, 'supplier'), reference: field(f, 'reference'), items } });
      toast('Achat enregistré');
    },
  });
}

// ----- Ventes -----

views.sales = async (el) => {
  const list = await api('sales');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Ventes</h1><p class="hint">Chaque vente sort les bières du stock et calcule la marge à partir du coût de revient.</p></div>
      <button class="primary" id="add">+ Nouvelle vente</button>
    </div>
    <div class="card">${table([
      { label: 'Date', html: (s) => fdate(s.date) },
      { label: 'Client', html: (s) => `<strong>${esc(s.customer || '—')}</strong>${s.channel ? ` <span class="badge">${esc(s.channel)}</span>` : ''}` },
      { label: 'Détail', html: (s) => `<div class="sub-lines">${s.items.map((i) => `${qty(i.quantity)} × ${esc(i.beer_name)} (${esc(i.beer_format)}) à ${eur(i.unit_price)}`).join('<br>')}</div>` },
      { label: 'Total HT', num: true, html: (s) => `<strong>${eur(s.total)}</strong>` },
      { label: 'Coût', num: true, html: (s) => eur(s.cost) },
      { label: 'Marge', num: true, cls: (s) => signClass(s.margin), html: (s) => `${eur(s.margin)}<div class="sub-lines">${pct(s.total ? s.margin / s.total : null)}</div>` },
      { label: '', html: (s) => `<span class="actions"><button class="small danger" data-del="${s.id}">✕</button></span>` },
    ], list, 'Aucune vente enregistrée')}</div>`;
  $('#add').onclick = saleForm;
  $$('[data-del]', el).forEach((b) => (b.onclick = () => remove(`sales/${b.dataset.del}`, 'Supprimer cette vente ? Les bières seront remises en stock.')));
};

async function saleForm() {
  const beers = await api('beers');
  if (!beers.length) return toast('Créez d’abord une bière', true);
  const byId = Object.fromEntries(beers.map((b) => [b.id, b]));
  const costOf = (b) => (b.avg_cost > 0 ? b.avg_cost : b.recipe_unit_cost);
  const row = () => `<tr>
      <td><select name="beer_id">${options(beers, '', { placeholder: '— Choisir —', label: (b) => `${b.name} — ${b.format}` })}</select></td>
      <td><input name="quantity" inputmode="decimal" value="1" style="width:80px"></td>
      <td><input name="unit_price" inputmode="decimal" style="width:100px"></td>
      <td class="num" data-stock></td><td class="num" data-total></td>
      <td><button type="button" class="small danger" data-rm>✕</button></td></tr>`;
  openModal({
    title: 'Nouvelle vente',
    body: `<div class="form-grid">
        <label>Date<input type="date" name="date" value="${today()}"></label>
        <label>Client<input name="customer"></label>
        <label>Canal<input name="channel" list="channels" placeholder="Boutique, bar, marché…"></label>
      </div>
      <datalist id="channels"><option>Vente directe</option><option>Bar / restaurant</option><option>Caviste</option><option>Marché / événement</option><option>En ligne</option></datalist>
      <h2 style="margin-top:16px">Bières vendues (prix HT)</h2>
      <div class="table-wrap"><table><thead><tr><th>Bière</th><th>Qté</th><th>Prix unit. HT</th><th class="num">Stock</th><th class="num">Total</th><th></th></tr></thead>
      <tbody class="lines">${row()}</tbody></table></div>
      <button type="button" class="link" id="add-line">+ Ajouter une ligne</button>`,
    onReady: (f) => {
      $('#add-line', f).onclick = () => { $('tbody.lines', f).insertAdjacentHTML('beforeend', row()); f.oninput(); };
      $('tbody.lines', f).onclick = (e) => { if (e.target.dataset.rm !== undefined) { e.target.closest('tr').remove(); f.oninput(); } };
      // Prix par défaut = prix de vente de la bière choisie.
      $('tbody.lines', f).addEventListener('change', (e) => {
        if (e.target.name !== 'beer_id') return;
        const b = byId[e.target.value];
        if (b) $('[name=unit_price]', e.target.closest('tr')).value = String(b.sale_price).replace('.', ',');
        f.oninput();
      });
    },
    onInput: (f) => {
      let total = 0;
      let cost = 0;
      for (const tr of lineRows(f)) {
        const b = byId[$('[name=beer_id]', tr).value];
        const q = toNum($('[name=quantity]', tr).value);
        const t = q * toNum($('[name=unit_price]', tr).value);
        total += t;
        cost += b ? q * costOf(b) : 0;
        $('[data-total]', tr).textContent = eur(t);
        const s = $('[data-stock]', tr);
        s.textContent = b ? qty(b.stock) : '';
        s.className = `num ${b && q > b.stock ? 'neg' : ''}`;
      }
      const margin = total - cost;
      $('#modal-total').innerHTML = `Total HT : ${eur(total)} · <span class="${signClass(margin)}">marge : ${eur(margin)} (${pct(total ? margin / total : null)})</span>`;
    },
    onSubmit: async (f) => {
      const items = lineRows(f)
        .map((tr) => ({ beer_id: $('[name=beer_id]', tr).value, quantity: $('[name=quantity]', tr).value, unit_price: $('[name=unit_price]', tr).value }))
        .filter((l) => l.beer_id);
      await api('sales', { method: 'POST', body: { date: field(f, 'date'), customer: field(f, 'customer'), channel: field(f, 'channel'), items } });
      toast('Vente enregistrée');
    },
  });
}

// ----- Mouvements -----

views.movements = async (el) => {
  const list = await api('movements?limit=500');
  el.innerHTML = `
    <div class="page-head"><div><h1>Mouvements de stock</h1><p class="hint">Historique des 500 derniers mouvements (achats, productions, ventes, inventaires).</p></div></div>
    <div class="card">${table([
      { label: 'Date', html: (m) => fdate(m.date) },
      { label: 'Article', html: (m) => `${esc(m.item_name)} <span class="badge">${m.item_type === 'beer' ? 'Bière' : 'Matière'}</span>` },
      { label: 'Motif', html: (m) => esc(m.reason) },
      { label: 'Quantité', num: true, cls: (m) => signClass(m.quantity), html: (m) => `${m.quantity > 0 ? '+' : ''}${qty(m.quantity)} ${esc(m.unit)}` },
      { label: 'Coût unit.', num: true, html: (m) => eur(m.unit_cost) },
      { label: 'Valeur', num: true, html: (m) => eur(m.quantity * m.unit_cost) },
    ], list, 'Aucun mouvement')}</div>`;
};

// ---------- Navigation ----------

async function remove(path, message) {
  if (!confirm(message)) return;
  try {
    await api(path, { method: 'DELETE' });
    toast('Supprimé');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function render() {
  const name = location.hash.slice(1) || 'dashboard';
  const view = views[name] || views.dashboard;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  try {
    await view($('#view'));
  } catch (err) {
    $('#view').innerHTML = `<div class="card neg">Erreur : ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);
render();
