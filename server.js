// ניהול הפיצרייה — שרת Node.js + SQLite
// הפעלה: npm install && npm start   (ראה README.md)
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pizzeria.db');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('pizzeria:' + APP_PASSWORD).digest('hex');
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['new', 'preparing', 'ready', 'done', 'cancelled'];
const NEXT = { new: 'preparing', preparing: 'ready', ready: 'done' };

/* ---------------- database ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  phone_norm TEXT NOT NULL UNIQUE,
  address    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('pizza','topping','extra')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_s     REAL, price_m REAL, price_l REAL,  -- pizzas
  price       REAL,                             -- toppings / extras
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 99
);
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('delivery','pickup')),
  address        TEXT NOT NULL DEFAULT '',
  delivery_fee   REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'new',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id    INTEGER,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size       TEXT,
  qty        INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  toppings   TEXT NOT NULL DEFAULT '[]'   -- JSON: [{name, price}]
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(order_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Starter menu on first run (edit it from the "תפריט" tab)
if (db.prepare('SELECT COUNT(*) n FROM menu_items').get().n === 0) {
  const ins = db.prepare(`INSERT INTO menu_items (kind,name,description,price_s,price_m,price_l,price,sort_order)
                          VALUES (@kind,@name,@description,@S,@M,@L,@price,@sort)`);
  const seed = [
    ['pizza', 'מרגריטה', 'רוטב עגבניות, מוצרלה, בזיליקום', 32, 48, 62],
    ['pizza', 'יוונית', 'בולגרית, זיתי קלמטה, בצל סגול, עגבנייה', 38, 56, 72],
    ['pizza', 'פסטו', 'פסטו בזיליקום, מוצרלה, עגבניות שרי', 38, 56, 72],
    ['pizza', 'פטריות ובצל', 'פטריות שמפיניון, בצל מקורמל, מוצרלה', 36, 54, 69],
    ['pizza', 'ביאנקה', 'שמנת, ריקוטה, פרמזן, שום', 40, 58, 75],
    ['topping', 'זיתים', 6], ['topping', 'פטריות', 6], ['topping', 'בצל', 5], ['topping', 'תירס', 5],
    ['topping', 'פלפל חריף', 5], ['topping', 'בולגרית', 8], ['topping', 'טונה', 9],
    ['extra', 'קולה 1.5 ליטר', 12], ['extra', 'מים מינרליים', 7], ['extra', 'לחם שום', 18],
    ['extra', 'סלט קיסר', 34], ['extra', 'צ׳יפס', 16],
  ];
  const counters = {};
  db.transaction(() => {
    for (const r of seed) {
      const kind = r[0]; counters[kind] = (counters[kind] || 0) + 1;
      if (kind === 'pizza') ins.run({ kind, name: r[1], description: r[2], S: r[3], M: r[4], L: r[5], price: null, sort: counters[kind] });
      else ins.run({ kind, name: r[1], description: '', S: null, M: null, L: null, price: r[2], sort: counters[kind] });
    }
  })();
}

// change counter, so open screens refresh when someone else edits
let rev = +(db.prepare("SELECT value FROM meta WHERE key='rev'").get()?.value || 0);
const bump = () => { rev++; db.prepare("INSERT INTO meta(key,value) VALUES('rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rev)); };

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString();
const normPhone = p => String(p || '').replace(/\D/g, '');
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const toCustomer = r => ({ id: String(r.id), name: r.name, phone: r.phone, address: r.address, notes: r.notes, createdAt: r.created_at });
const toMenu = r => ({
  id: String(r.id), kind: r.kind, name: r.name, desc: r.description, active: !!r.active, order: r.sort_order,
  ...(r.kind === 'pizza' ? { prices: { S: r.price_s || 0, M: r.price_m || 0, L: r.price_l || 0 } } : { price: r.price || 0 }),
});

function loadState() {
  const customers = db.prepare('SELECT * FROM customers').all().map(toCustomer);
  const menu = db.prepare('SELECT * FROM menu_items').all().map(toMenu);
  const items = db.prepare('SELECT * FROM order_items ORDER BY id').all();
  const byOrder = {};
  for (const i of items) (byOrder[i.order_id] ||= []).push({
    menuId: i.menu_id != null ? String(i.menu_id) : null, name: i.name, kind: i.kind, size: i.size || undefined,
    qty: i.qty, unit: i.unit_price, toppings: JSON.parse(i.toppings || '[]'),
  });
  const orders = db.prepare('SELECT * FROM orders').all().map(o => ({
    id: String(o.id), customerId: o.customer_id != null ? String(o.customer_id) : null,
    customerName: o.customer_name, customerPhone: o.customer_phone, type: o.type, address: o.address,
    deliveryFee: o.delivery_fee, total: o.total, note: o.note, status: o.status,
    createdAt: o.created_at, updatedAt: o.updated_at, items: byOrder[o.id] || [],
  }));
  return { rev, customers, menu, orders };
}

/* ---------------- auth ---------------- */
const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function validCookie(c) {
  if (!c) return false;
  const i = c.lastIndexOf('.'); if (i < 0) return false;
  const expected = sign(c.slice(0, i));
  return expected.length === c.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c));
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const attempts = new Map(); // ip -> {n, until}

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/session', (req, res) => res.json({ needsLogin: !!APP_PASSWORD, loggedIn: !APP_PASSWORD || validCookie(getCookie(req, 'pz')) }));

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const ip = req.ip, a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד דקה.' });
  const given = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
  const real = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, real)) {
    a.n++; if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; } attempts.set(ip, a);
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  attempts.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `pz=${encodeURIComponent(sign('staff:' + Date.now()))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'pz=; Path=/; Max-Age=0'); res.json({ ok: true }); });

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || validCookie(getCookie(req, 'pz'))) return next();
  res.status(401).json({ error: 'נדרשת כניסה' });
});

const route = fn => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'שגיאת שרת' });
  }
};

app.get('/api/rev', route(() => ({ rev })));
app.get('/api/state', route(() => loadState()));

/* customers */
function customerInput(b) {
  const name = str(b.name, 120), phone = str(b.phone, 30);
  if (!name) throw new HttpError(400, 'חסר שם לקוח');
  if (normPhone(phone).length < 7) throw new HttpError(400, 'מספר טלפון לא תקין');
  return { name, phone, phone_norm: normPhone(phone), address: str(b.address, 300), notes: str(b.notes, 1000) };
}
function assertPhoneFree(pn, exceptId) {
  const dup = db.prepare('SELECT id, name FROM customers WHERE phone_norm = ?').get(pn);
  if (dup && dup.id !== exceptId) throw new HttpError(409, `הטלפון כבר שייך ל${dup.name}`);
}
app.post('/api/customers', route(req => {
  const c = customerInput(req.body || {}); assertPhoneFree(c.phone_norm);
  const r = db.prepare('INSERT INTO customers (name,phone,phone_norm,address,notes,created_at) VALUES (@name,@phone,@phone_norm,@address,@notes,@created_at)').run({ ...c, created_at: now() });
  bump(); return { id: String(r.lastInsertRowid) };
}));
app.put('/api/customers/:id', route(req => {
  const id = +req.params.id, c = customerInput(req.body || {}); assertPhoneFree(c.phone_norm, id);
  const r = db.prepare('UPDATE customers SET name=@name, phone=@phone, phone_norm=@phone_norm, address=@address, notes=@notes WHERE id=@id').run({ ...c, id });
  if (!r.changes) throw new HttpError(404, 'הלקוח לא נמצא');
  bump(); return { ok: true };
}));
app.delete('/api/customers/:id', route(req => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(+req.params.id); bump(); return { ok: true };
}));

/* menu */
function menuInput(b) {
  const kind = ['pizza', 'topping', 'extra'].includes(b.kind) ? b.kind : null;
  if (!kind) throw new HttpError(400, 'סוג פריט לא תקין');
  const name = str(b.name, 120); if (!name) throw new HttpError(400, 'חסר שם לפריט');
  const m = { kind, name, description: str(b.desc, 300), active: b.active === false ? 0 : 1, S: null, M: null, L: null, price: null };
  if (kind === 'pizza') {
    m.S = num(b.prices?.S); m.M = num(b.prices?.M); m.L = num(b.prices?.L);
    if (!m.S && !m.M && !m.L) throw new HttpError(400, 'הזן לפחות מחיר אחד');
  } else m.price = num(b.price);
  return m;
}
app.post('/api/menu', route(req => {
  const m = menuInput(req.body || {});
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM menu_items WHERE kind=?').get(m.kind).s;
  const r = db.prepare('INSERT INTO menu_items (kind,name,description,price_s,price_m,price_l,price,active,sort_order) VALUES (@kind,@name,@description,@S,@M,@L,@price,@active,@sort)').run({ ...m, sort });
  bump(); return { id: String(r.lastInsertRowid) };
}));
app.put('/api/menu/:id', route(req => {
  const m = menuInput(req.body || {});
  const r = db.prepare('UPDATE menu_items SET kind=@kind,name=@name,description=@description,price_s=@S,price_m=@M,price_l=@L,price=@price,active=@active WHERE id=@id').run({ ...m, id: +req.params.id });
  if (!r.changes) throw new HttpError(404, 'הפריט לא נמצא');
  bump(); return { ok: true };
}));
app.delete('/api/menu/:id', route(req => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(+req.params.id); bump(); return { ok: true };
}));

/* orders — prices are always computed here from the menu, never trusted from the browser */
const createOrder = db.transaction(b => {
  const type = b.type === 'pickup' ? 'pickup' : 'delivery';
  const address = type === 'delivery' ? str(b.address, 300) : '';
  if (type === 'delivery' && !address) throw new HttpError(400, 'הזן כתובת למשלוח');

  let cust = null;
  if (b.customerId) cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(+b.customerId);
  if (!cust && b.newCustomer) {
    const c = customerInput({ ...b.newCustomer, address });
    cust = db.prepare('SELECT * FROM customers WHERE phone_norm = ?').get(c.phone_norm);
    if (!cust) {
      const r = db.prepare('INSERT INTO customers (name,phone,phone_norm,address,notes,created_at) VALUES (@name,@phone,@phone_norm,@address,@notes,@created_at)').run({ ...c, created_at: now() });
      cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.lastInsertRowid);
    }
  }
  if (!cust) throw new HttpError(400, 'בחר לקוח או הוסף לקוח חדש');
  if (type === 'delivery' && !cust.address) db.prepare('UPDATE customers SET address = ? WHERE id = ?').run(address, cust.id);

  const getItem = db.prepare('SELECT * FROM menu_items WHERE id = ? AND active = 1');
  const lines = [];
  for (const l of Array.isArray(b.items) ? b.items.slice(0, 100) : []) {
    const m = getItem.get(+l.menuId); const qty = Math.min(99, Math.max(0, parseInt(l.qty) || 0));
    if (!m || !qty || m.kind === 'topping') continue;
    let unit, size = null, toppings = [];
    if (m.kind === 'pizza') {
      size = SIZES.includes(l.size) ? l.size : 'L';
      unit = m['price_' + size.toLowerCase()] || 0;
      for (const tid of Array.isArray(l.toppingIds) ? l.toppingIds.slice(0, 20) : []) {
        const t = getItem.get(+tid); if (t && t.kind === 'topping') { toppings.push({ name: t.name, price: t.price || 0 }); unit += t.price || 0; }
      }
    } else unit = m.price || 0;
    lines.push({ menu_id: m.id, name: m.name, kind: m.kind, size, qty, unit_price: unit, toppings: JSON.stringify(toppings) });
  }
  if (!lines.length) throw new HttpError(400, 'הוסף לפחות פריט אחד');

  const fee = type === 'delivery' ? num(b.deliveryFee) : 0;
  const total = Math.round((lines.reduce((s, l) => s + l.unit_price * l.qty, 0) + fee) * 100) / 100;
  const t = now();
  const r = db.prepare(`INSERT INTO orders (customer_id,customer_name,customer_phone,type,address,delivery_fee,total,note,status,created_at,updated_at)
                        VALUES (?,?,?,?,?,?,?,?, 'new', ?, ?)`).run(cust.id, cust.name, cust.phone, type, address, fee, total, str(b.note, 500), t, t);
  const insLine = db.prepare('INSERT INTO order_items (order_id,menu_id,name,kind,size,qty,unit_price,toppings) VALUES (@order_id,@menu_id,@name,@kind,@size,@qty,@unit_price,@toppings)');
  for (const l of lines) insLine.run({ ...l, order_id: r.lastInsertRowid });
  return { id: String(r.lastInsertRowid), total };
});
app.post('/api/orders', route(req => { const out = createOrder(req.body || {}); bump(); return out; }));

app.post('/api/orders/:id/status', route(req => {
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(+req.params.id);
  if (!o) throw new HttpError(404, 'ההזמנה לא נמצאה');
  let to = req.body?.status;
  if (to === 'next') to = NEXT[o.status];
  if (!STATUSES.includes(to)) throw new HttpError(400, 'אי אפשר לקדם את ההזמנה הזו');
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), +req.params.id);
  bump(); return { status: to };
}));

app.listen(PORT, () => {
  console.log(`🍕 ניהול הפיצרייה פועל: http://localhost:${PORT}`);
  console.log(`   בסיס נתונים: ${DB_PATH}`);
  if (!APP_PASSWORD) console.warn('   ⚠ לא הוגדרה סיסמה (APP_PASSWORD). כל מי שמגיע לכתובת יכול להיכנס. מתאים רק לרשת פנימית.');
});
