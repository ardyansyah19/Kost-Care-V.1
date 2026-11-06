'use strict';
class Raw { constructor(s) { this.s = s; } }
const raw = s => new Raw(String(s));
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const out = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(out).join('') : v == null || v === false ? '' : esc(v);
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? out(v[i]) : ''), ''));
const R = n => 'Rp' + Number(n).toLocaleString('id-ID');
const LBL = { unpaid: 'Belum bayar', partially_paid: 'Sebagian', paid: 'Lunas', overdue: 'Terlambat', pending_review: 'Menunggu verifikasi', confirmed: 'Terkonfirmasi',
  rejected: 'Ditolak', reversed: 'Dibatalkan', vacant: 'Kosong', occupied: 'Terisi', reserved: 'Dipesan', maintenance: 'Perbaikan', submitted: 'Dikirim', in_progress: 'Diproses',
  resolved: 'Selesai', cash: 'Tunai', bank_transfer: 'Transfer', qris: 'QRIS' };
const badge = s => html`<span class="b ${s}">${LBL[s] || s}</span>`;
const period = p => { const [y, m] = p.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }); };
const dt = d => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
const NAV = {
  admin: [['/admin', 'Beranda'], ['/admin/rooms', 'Kamar'], ['/admin/tenants', 'Penghuni'], ['/admin/contracts', 'Kontrak'], ['/admin/invoices', 'Tagihan'], ['/admin/news', 'Info'], ['/admin/complaints', 'Aduan'], ['/admin/settings', 'Atur']],
  tenant: [['/app', 'Beranda'], ['/app/invoices', 'Tagihan'], ['/app/news', 'Info'], ['/app/complaints', 'Aduan'], ['/password', 'Akun']],
};
const layout = (req, res, title, body) => html`<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f766e"><link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg"><title>${title} · Kost Care</title><link rel="stylesheet" href="/app.css"></head>
<body><header><b>Kost Care</b>${req.user ? html`<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${res.locals.csrf}"><span>${req.user.name}</span><button class="link">Keluar</button></form>` : ''}</header>
<main>${res.locals.flash?.m ? html`<p class="ok">${res.locals.flash.m}</p>` : ''}${res.locals.flash?.e ? html`<p class="err">${res.locals.flash.e}</p>` : ''}<h1>${title}</h1>${body}</main>
${req.user ? html`<nav>${NAV[req.user.role].map(([h, t]) => html`<a href="${h}" class="${(req.originalUrl.split('?')[0] === h) || (h !== '/admin' && h !== '/app' && req.originalUrl.startsWith(h)) ? 'on' : ''}">${t}</a>`)}</nav>` : ''}</body></html>`;
module.exports = { Raw, raw, html, R, badge, period, dt, layout, LBL };
