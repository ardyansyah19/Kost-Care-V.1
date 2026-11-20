'use strict';
const { db, tx, setting, today, now, audit } = require('./db');
class UErr extends Error {}
const U = m => new UErr(m);
const int = v => { const n = Number(String(v ?? '').replace(/[.\s]/g, '')); return Number.isInteger(n) ? n : NaN; };
const DATE = { test: d => /^\d{4}-\d\d-\d\d$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d };
const paidOf = id => db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=? AND status='confirmed'").get(id).s;

function syncRoom(id) {
  const r = db.prepare('SELECT status FROM rooms WHERE id=?').get(id);
  if (!r || r.status === 'maintenance') return;
  const t = today();
  const cur = db.prepare("SELECT 1 FROM contracts WHERE room_id=? AND status='active' AND start<=? AND (end IS NULL OR end>=?)").get(id, t, t);
  const fut = db.prepare("SELECT 1 FROM contracts WHERE room_id=? AND status='active' AND start>?").get(id, t);
  db.prepare('UPDATE rooms SET status=? WHERE id=?').run(cur ? 'occupied' : fut ? 'reserved' : 'vacant', id);
}
function newContract(b, uid) {
  return tx(() => {
    const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(int(b.room_id));
    const ten = db.prepare('SELECT * FROM tenants WHERE id=?').get(int(b.tenant_id));
    if (!room || !ten) throw U('Kamar atau penghuni tidak ditemukan');
    if (room.status === 'maintenance') throw U('Kamar sedang perbaikan');
    const start = String(b.start || ''), end = b.end ? String(b.end) : null;
    if (!DATE.test(start) || (end && !DATE.test(end))) throw U('Format tanggal tidak valid');
    if (end && end < start) throw U('Tanggal akhir sebelum tanggal mulai');
    const price = b.price ? int(b.price) : room.price, deposit = b.deposit ? int(b.deposit) : 0;
    if (!(price > 0) || !(deposit >= 0)) throw U('Harga/deposit tidak valid');
    const clash = col => db.prepare(`SELECT 1 FROM contracts WHERE ${col}=? AND status='active' AND start<=COALESCE(?,'9999-12-31') AND COALESCE(end,'9999-12-31')>=?`);
    if (clash('room_id').get(room.id, end, start)) throw U('Kamar sudah punya kontrak aktif pada rentang tanggal itu');
    if (clash('tenant_id').get(ten.id, end, start)) throw U('Penghuni sudah punya kontrak aktif pada rentang tanggal itu');
    const id = db.prepare('INSERT INTO contracts(tenant_id,room_id,start,end,price,deposit) VALUES(?,?,?,?,?,?)').run(ten.id, room.id, start, end, price, deposit).lastInsertRowid;
    if (ten.user_id) db.prepare('UPDATE users SET active=1 WHERE id=?').run(ten.user_id);
    syncRoom(room.id); audit(uid, 'contract.create', `#${id} kamar ${room.number} ${ten.name} ${start}`);
    return id;
  });
}
function endContract(id, date, uid) {
  return tx(() => {
    const c = db.prepare("SELECT * FROM contracts WHERE id=? AND status='active'").get(int(id));
    if (!c) throw U('Kontrak aktif tidak ditemukan');
    if (!DATE.test(date || '') || date < c.start) throw U('Tanggal akhir tidak valid');
    db.prepare('UPDATE contracts SET end=?, status=? WHERE id=?').run(date, date <= today() ? 'completed' : 'active', c.id);
    syncRoom(c.room_id);
    const t = db.prepare('SELECT user_id FROM tenants WHERE id=?').get(c.tenant_id);
    const still = db.prepare("SELECT 1 FROM contracts WHERE tenant_id=? AND status='active'").get(c.tenant_id);
    const debt = db.prepare(`SELECT 1 FROM invoices i JOIN contracts k ON k.id=i.contract_id WHERE k.tenant_id=? AND i.status!='paid'`).get(c.tenant_id);
    if (t.user_id && !still && !debt) db.prepare('UPDATE users SET active=0 WHERE id=?').run(t.user_id);
    audit(uid, 'contract.end', `#${c.id} ${date}`);
  });
}
function generateInvoices(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw U('Periode tidak valid');
  const [y, m] = period.split('-').map(Number), dim = new Date(y, m, 0).getDate();
  const first = `${period}-01`, last = `${period}-${String(dim).padStart(2, '0')}`;
  const due = `${period}-${String(Math.min(+setting('due_day') || 10, dim)).padStart(2, '0')}`;
  const mode = setting('proration');
  return tx(() => {
    let n = 0;
    for (const c of db.prepare("SELECT * FROM contracts WHERE start<=? AND (end IS NULL OR end>=?)").all(last, first)) {
      let amt = c.price;
      if (c.start >= first) {
        const sd = +c.start.slice(8);
        if (mode === 'next' && sd > 1) continue;
        if (mode === 'prorata') amt = Math.round(c.price * (dim - sd + 1) / dim);
      }
      n += db.prepare('INSERT OR IGNORE INTO invoices(contract_id,period,due,total) VALUES(?,?,?,?)').run(c.id, period, due, amt).changes;
    }
    return n;
  });
}
function refresh(id) {
  const i = db.prepare('SELECT total FROM invoices WHERE id=?').get(id), p = paidOf(id);
  db.prepare('UPDATE invoices SET status=? WHERE id=?').run(p >= i.total ? 'paid' : p > 0 ? 'partially_paid' : 'unpaid', id);
}
function addPayment({ invoice, amount, method, proof, by, confirmed, note }) {
  return tx(() => {
    const i = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice);
    if (!i) throw U('Tagihan tidak ditemukan');
    amount = int(amount);
    if (!(amount > 0)) throw U('Nominal tidak valid');
    if (amount > i.total - paidOf(i.id)) throw U('Nominal melebihi sisa tagihan');
    if (!['cash', 'bank_transfer', 'qris'].includes(method)) throw U('Metode tidak valid');
    if (!confirmed && !proof) throw U('Bukti pembayaran wajib diunggah');
    const id = db.prepare('INSERT INTO payments(invoice_id,amount,method,status,proof,note,created_by,verified_by,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(i.id, amount, method, confirmed ? 'confirmed' : 'pending_review', proof ?? null, note ?? null, by, confirmed ? by : null, now(), confirmed ? now() : null).lastInsertRowid;
    refresh(i.id); audit(by, confirmed ? 'payment.record' : 'payment.submit', `#${id} inv ${i.id} ${amount} ${method}`);
    return id;
  });
}
function reviewPayment(id, by, ok, note) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(int(id));
    if (!p || p.status !== 'pending_review') throw U('Pembayaran bukan berstatus menunggu verifikasi');
    if (ok) {
      const i = db.prepare('SELECT total FROM invoices WHERE id=?').get(p.invoice_id);
      if (p.amount > i.total - paidOf(p.invoice_id)) throw U('Nominal melebihi sisa tagihan saat ini');
    } else if (!note) throw U('Alasan penolakan wajib diisi');
    db.prepare('UPDATE payments SET status=?, note=COALESCE(?,note), verified_by=?, verified_at=? WHERE id=?').run(ok ? 'confirmed' : 'rejected', note || null, by, now(), p.id);
    refresh(p.invoice_id); audit(by, ok ? 'payment.confirm' : 'payment.reject', `#${p.id} ${note || ''}`);
  });
}
function reversePayment(id, by, note) {
  return tx(() => {
    const p = db.prepare("SELECT * FROM payments WHERE id=? AND status='confirmed'").get(int(id));
    if (!p) throw U('Pembayaran terkonfirmasi tidak ditemukan');
    if (!note) throw U('Alasan pembatalan wajib diisi');
    db.prepare("UPDATE payments SET status='reversed', note=?, verified_by=?, verified_at=? WHERE id=?").run(note, by, now(), p.id);
    refresh(p.invoice_id); audit(by, 'payment.reverse', `#${p.id} ${note}`);
  });
}
function housekeeping() {
  tx(() => {
    db.prepare("UPDATE contracts SET status='completed' WHERE status='active' AND end IS NOT NULL AND end<?").run(today());
    for (const r of db.prepare('SELECT id FROM rooms').all()) syncRoom(r.id);
  });
}
module.exports = { housekeeping, UErr, U, int, paidOf, syncRoom, newContract, endContract, generateInvoices, addPayment, reviewPayment, reversePayment };
'use strict';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`\nNode.js ${process.versions.node} terlalu lama. Aplikasi ini butuh Node.js 22.13 atau lebih baru (lihat README bagian Laragon).\n - db.js:4`);
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'kost.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','tenant')), active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'Standar',
  price INTEGER NOT NULL CHECK(price>0), status TEXT NOT NULL DEFAULT 'vacant' CHECK(status IN('vacant','occupied','reserved','maintenance')), description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id), name TEXT NOT NULL, nim TEXT, university TEXT, phone TEXT, emergency TEXT);
CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), room_id INTEGER NOT NULL REFERENCES rooms(id),
  start TEXT NOT NULL, end TEXT, price INTEGER NOT NULL CHECK(price>0), deposit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed')));
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), period TEXT NOT NULL, due TEXT NOT NULL,
  total INTEGER NOT NULL CHECK(total>0), status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN('unpaid','partially_paid','paid')), UNIQUE(contract_id,period));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL CHECK(amount>0),
  method TEXT NOT NULL CHECK(method IN('cash','bank_transfer','qris')), status TEXT NOT NULL CHECK(status IN('pending_review','confirmed','rejected','reversed')),
  proof TEXT, note TEXT, created_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, verified_at TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','in_progress','resolved','rejected')), note TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
`);
const defaults = { kost_name: 'Kost Saya', due_day: '10', invoice_day: '1', proration: 'full', bank_info: 'Isi info rekening/QRIS di menu Atur.' };
for (const [k, v] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, v);
const setting = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const now = () => new Date().toLocaleString('sv-SE', { timeZone: TZ });
const audit = (uid, action, detail) => db.prepare('INSERT INTO audit(user_id,action,detail,at) VALUES(?,?,?,?)').run(uid ?? null, action, detail ?? null, now());
module.exports = { db, DATA, setting, tx, today, now, audit };
'use strict';
const { db, tx, setting, today, now, audit } = require('./db');
class UErr extends Error {}
const U = m => new UErr(m);
const int = v => { const n = Number(String(v ?? '').replace(/[.\s]/g, '')); return Number.isInteger(n) ? n : NaN; };
const DATE = { test: d => /^\d{4}-\d\d-\d\d$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d };
const paidOf = id => db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=? AND status='confirmed'").get(id).s;

function syncRoom(id) {
  const r = db.prepare('SELECT status FROM rooms WHERE id=?').get(id);
  if (!r || r.status === 'maintenance') return;
  const t = today();
  const cur = db.prepare("SELECT 1 FROM contracts WHERE room_id=? AND status='active' AND start<=? AND (end IS NULL OR end>=?)").get(id, t, t);
  const fut = db.prepare("SELECT 1 FROM contracts WHERE room_id=? AND status='active' AND start>?").get(id, t);
  db.prepare('UPDATE rooms SET status=? WHERE id=?').run(cur ? 'occupied' : fut ? 'reserved' : 'vacant', id);
}
function newContract(b, uid) {
  return tx(() => {
    const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(int(b.room_id));
    const ten = db.prepare('SELECT * FROM tenants WHERE id=?').get(int(b.tenant_id));
    if (!room || !ten) throw U('Kamar atau penghuni tidak ditemukan');
    if (room.status === 'maintenance') throw U('Kamar sedang perbaikan');
    const start = String(b.start || ''), end = b.end ? String(b.end) : null;
    if (!DATE.test(start) || (end && !DATE.test(end))) throw U('Format tanggal tidak valid');
    if (end && end < start) throw U('Tanggal akhir sebelum tanggal mulai');
    const price = b.price ? int(b.price) : room.price, deposit = b.deposit ? int(b.deposit) : 0;
    if (!(price > 0) || !(deposit >= 0)) throw U('Harga/deposit tidak valid');
    const clash = col => db.prepare(`SELECT 1 FROM contracts WHERE ${col}=? AND status='active' AND start<=COALESCE(?,'9999-12-31') AND COALESCE(end,'9999-12-31')>=?`);
    if (clash('room_id').get(room.id, end, start)) throw U('Kamar sudah punya kontrak aktif pada rentang tanggal itu');
    if (clash('tenant_id').get(ten.id, end, start)) throw U('Penghuni sudah punya kontrak aktif pada rentang tanggal itu');
    const id = db.prepare('INSERT INTO contracts(tenant_id,room_id,start,end,price,deposit) VALUES(?,?,?,?,?,?)').run(ten.id, room.id, start, end, price, deposit).lastInsertRowid;
    if (ten.user_id) db.prepare('UPDATE users SET active=1 WHERE id=?').run(ten.user_id);
    syncRoom(room.id); audit(uid, 'contract.create', `#${id} kamar ${room.number} ${ten.name} ${start}`);
    return id;
  });
}
function endContract(id, date, uid) {
  return tx(() => {
    const c = db.prepare("SELECT * FROM contracts WHERE id=? AND status='active'").get(int(id));
    if (!c) throw U('Kontrak aktif tidak ditemukan');
    if (!DATE.test(date || '') || date < c.start) throw U('Tanggal akhir tidak valid');
    db.prepare('UPDATE contracts SET end=?, status=? WHERE id=?').run(date, date <= today() ? 'completed' : 'active', c.id);
    syncRoom(c.room_id);
    const t = db.prepare('SELECT user_id FROM tenants WHERE id=?').get(c.tenant_id);
    const still = db.prepare("SELECT 1 FROM contracts WHERE tenant_id=? AND status='active'").get(c.tenant_id);
    const debt = db.prepare(`SELECT 1 FROM invoices i JOIN contracts k ON k.id=i.contract_id WHERE k.tenant_id=? AND i.status!='paid'`).get(c.tenant_id);
    if (t.user_id && !still && !debt) db.prepare('UPDATE users SET active=0 WHERE id=?').run(t.user_id);
    audit(uid, 'contract.end', `#${c.id} ${date}`);
  });
}
function generateInvoices(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw U('Periode tidak valid');
  const [y, m] = period.split('-').map(Number), dim = new Date(y, m, 0).getDate();
  const first = `${period}-01`, last = `${period}-${String(dim).padStart(2, '0')}`;
  const due = `${period}-${String(Math.min(+setting('due_day') || 10, dim)).padStart(2, '0')}`;
  const mode = setting('proration');
  return tx(() => {
    let n = 0;
    for (const c of db.prepare("SELECT * FROM contracts WHERE start<=? AND (end IS NULL OR end>=?)").all(last, first)) {
      let amt = c.price;
      if (c.start >= first) {
        const sd = +c.start.slice(8);
        if (mode === 'next' && sd > 1) continue;
        if (mode === 'prorata') amt = Math.round(c.price * (dim - sd + 1) / dim);
      }
      n += db.prepare('INSERT OR IGNORE INTO invoices(contract_id,period,due,total) VALUES(?,?,?,?)').run(c.id, period, due, amt).changes;
    }
    return n;
  });
}
function refresh(id) {
  const i = db.prepare('SELECT total FROM invoices WHERE id=?').get(id), p = paidOf(id);
  db.prepare('UPDATE invoices SET status=? WHERE id=?').run(p >= i.total ? 'paid' : p > 0 ? 'partially_paid' : 'unpaid', id);
}
function addPayment({ invoice, amount, method, proof, by, confirmed, note }) {
  return tx(() => {
    const i = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice);
    if (!i) throw U('Tagihan tidak ditemukan');
    amount = int(amount);
    if (!(amount > 0)) throw U('Nominal tidak valid');
    if (amount > i.total - paidOf(i.id)) throw U('Nominal melebihi sisa tagihan');
    if (!['cash', 'bank_transfer', 'qris'].includes(method)) throw U('Metode tidak valid');
    if (!confirmed && !proof) throw U('Bukti pembayaran wajib diunggah');
    const id = db.prepare('INSERT INTO payments(invoice_id,amount,method,status,proof,note,created_by,verified_by,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(i.id, amount, method, confirmed ? 'confirmed' : 'pending_review', proof ?? null, note ?? null, by, confirmed ? by : null, now(), confirmed ? now() : null).lastInsertRowid;
    refresh(i.id); audit(by, confirmed ? 'payment.record' : 'payment.submit', `#${id} inv ${i.id} ${amount} ${method}`);
    return id;
  });
}
function reviewPayment(id, by, ok, note) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(int(id));
    if (!p || p.status !== 'pending_review') throw U('Pembayaran bukan berstatus menunggu verifikasi');
    if (ok) {
      const i = db.prepare('SELECT total FROM invoices WHERE id=?').get(p.invoice_id);
      if (p.amount > i.total - paidOf(p.invoice_id)) throw U('Nominal melebihi sisa tagihan saat ini');
    } else if (!note) throw U('Alasan penolakan wajib diisi');
    db.prepare('UPDATE payments SET status=?, note=COALESCE(?,note), verified_by=?, verified_at=? WHERE id=?').run(ok ? 'confirmed' : 'rejected', note || null, by, now(), p.id);
    refresh(p.invoice_id); audit(by, ok ? 'payment.confirm' : 'payment.reject', `#${p.id} ${note || ''}`);
  });
}
function reversePayment(id, by, note) {
  return tx(() => {
    const p = db.prepare("SELECT * FROM payments WHERE id=? AND status='confirmed'").get(int(id));
    if (!p) throw U('Pembayaran terkonfirmasi tidak ditemukan');
    if (!note) throw U('Alasan pembatalan wajib diisi');
    db.prepare("UPDATE payments SET status='reversed', note=?, verified_by=?, verified_at=? WHERE id=?").run(note, by, now(), p.id);
    refresh(p.invoice_id); audit(by, 'payment.reverse', `#${p.id} ${note}`);
  });
}
function housekeeping() {
  tx(() => {
    db.prepare("UPDATE contracts SET status='completed' WHERE status='active' AND end IS NOT NULL AND end<?").run(today());
    for (const r of db.prepare('SELECT id FROM rooms').all()) syncRoom(r.id);
  });
}
module.exports = { housekeeping, UErr, U, int, paidOf, syncRoom, newContract, endContract, generateInvoices, addPayment, reviewPayment, reversePayment };
'use strict';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`\nNode.js ${process.versions.node} terlalu lama. Aplikasi ini butuh Node.js 22.13 atau lebih baru (lihat README bagian Laragon).\n - db.js:4`);
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'kost.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','tenant')), active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'Standar',
  price INTEGER NOT NULL CHECK(price>0), status TEXT NOT NULL DEFAULT 'vacant' CHECK(status IN('vacant','occupied','reserved','maintenance')), description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id), name TEXT NOT NULL, nim TEXT, university TEXT, phone TEXT, emergency TEXT);
CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), room_id INTEGER NOT NULL REFERENCES rooms(id),
  start TEXT NOT NULL, end TEXT, price INTEGER NOT NULL CHECK(price>0), deposit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed')));
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), period TEXT NOT NULL, due TEXT NOT NULL,
  total INTEGER NOT NULL CHECK(total>0), status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN('unpaid','partially_paid','paid')), UNIQUE(contract_id,period));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL CHECK(amount>0),
  method TEXT NOT NULL CHECK(method IN('cash','bank_transfer','qris')), status TEXT NOT NULL CHECK(status IN('pending_review','confirmed','rejected','reversed')),
  proof TEXT, note TEXT, created_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, verified_at TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','in_progress','resolved','rejected')), note TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
`);
const defaults = { kost_name: 'Kost Saya', due_day: '10', invoice_day: '1', proration: 'full', bank_info: 'Isi info rekening/QRIS di menu Atur.' };
for (const [k, v] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, v);
const setting = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const now = () => new Date().toLocaleString('sv-SE', { timeZone: TZ });
const audit = (uid, action, detail) => db.prepare('INSERT INTO audit(user_id,action,detail,at) VALUES(?,?,?,?)').run(uid ?? null, action, detail ?? null, now());
module.exports = { db, DATA, setting, tx, today, now, audit };
