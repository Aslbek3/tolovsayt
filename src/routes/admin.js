const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, getSettings, setSetting } = require('../db');
const billing = require('../billing');
const tg = require('../telegram');
const { verifyInitData } = require('../miniapp');
const { normPhone, today, addMonths, daysLeft, fmtDate } = require('../utils');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: "Juda ko'p urinish." });

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

router.use((req, res, next) => { res.locals.admin = true; res.locals.path = req.path; next(); });

router.get('/login', (req, res) => res.render('admin/login', { title: 'Admin kirish' }));
router.post('/login', loginLimiter, (req, res) => {
  if (safeEq(req.body.username || '', process.env.ADMIN_USERNAME || 'admin') && safeEq(req.body.password || '', process.env.ADMIN_PASSWORD)) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  req.flash('error', "Login yoki parol noto'g'ri");
  res.redirect('/admin/login');
});
router.post('/logout', (req, res) => { req.session.isAdmin = false; res.redirect('/admin/login'); });

// Telegram Mini App orqali parolsiz kirish — FAQAT ADMIN_CHAT_ID ro'yxatidagi
// Telegram foydalanuvchilari uchun. initData HMAC bilan tasdiqlanadi (src/miniapp.js,
// mijoz Mini App'ida ishlatilgan aynan shu funksiya), so'ng oddiy login bilan BIR XIL
// sessiya o'rnatiladi (req.session.isAdmin = true) — shundan keyin butun admin panel
// (parolli kirishdagi kabi) ishlayveradi, alohida kod yo'li kerak emas.
router.post('/tg-login', (req, res) => {
  const result = verifyInitData(req.header('X-Tg-Init-Data'));
  if (!result || !tg.ADMIN_CHAT_IDS.includes(String(result.user.id))) {
    return res.status(403).json({ ok: false });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.use((req, res, next) => (req.session.isAdmin ? next() : res.redirect('/admin/login')));

const back = (req, fallback) => req.get('Referrer') || fallback;

// ---------- Bosh sahifa ----------
router.get('/', (req, res) => {
  const services = db.prepare('SELECT s.*, c.name AS client_name FROM services s JOIN clients c ON c.id = s.client_id ORDER BY s.paid_until').all();
  const month = today().slice(0, 7);
  const stats = {
    clients: db.prepare('SELECT COUNT(*) n FROM clients').get().n,
    services: services.length,
    active: services.filter(s => s.status === 'active').length,
    suspended: services.filter(s => s.status === 'suspended').length,
    monthly: services.filter(s => s.status === 'active').reduce((a, s) => a + s.price, 0),
    thisMonth: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='approved' AND substr(reviewed_at,1,7) = ?").get(month).n,
    pending: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending'").get().n,
    pendingTopups: db.prepare("SELECT COUNT(*) n FROM topups WHERE status='pending'").get().n,
    totalBalance: db.prepare('SELECT COALESCE(SUM(balance),0) n FROM clients').get().n,
  };
  const pendingPayments = db.prepare(`SELECT p.*, c.name AS client_name, c.phone, s.name AS service_name FROM payments p
    JOIN clients c ON c.id = p.client_id JOIN services s ON s.id = p.service_id WHERE p.status='pending' ORDER BY p.id`).all();
  const pendingTopups = db.prepare(`SELECT t.*, c.name AS client_name, c.phone FROM topups t
    JOIN clients c ON c.id = t.client_id WHERE t.status='pending' ORDER BY t.id`).all();
  const due = services.filter(s => daysLeft(s.paid_until) <= 7);
  res.render('admin/dashboard', { title: 'Boshqaruv paneli', stats, pendingPayments, pendingTopups, due, botUsername: tg.getBotUsername() });
});

// ---------- Mijozlar ----------
router.get('/clients', (req, res) => {
  const q = (req.query.q || '').trim();
  const clients = db.prepare(`SELECT c.*, COUNT(s.id) AS svc_count, MIN(s.paid_until) AS next_due,
      SUM(CASE WHEN s.status='suspended' THEN 1 ELSE 0 END) AS suspended
    FROM clients c LEFT JOIN services s ON s.client_id = c.id
    WHERE c.name LIKE ? OR c.phone LIKE ? GROUP BY c.id ORDER BY c.id DESC`).all(`%${q}%`, `%${q}%`);
  res.render('admin/clients', { title: 'Mijozlar', clients, q });
});

router.post('/clients', (req, res) => {
  const { name, password, note } = req.body;
  const phone = normPhone(req.body.phone);
  if (!name || phone.length < 9 || !password || password.length < 6) {
    req.flash('error', "Ism, telefon va kamida 6 belgili parolni kiriting");
    return res.redirect('/admin/clients');
  }
  try {
    const r = db.prepare('INSERT INTO clients (name, phone, password_hash, note) VALUES (?, ?, ?, ?)').run(name.trim(), phone, bcrypt.hashSync(password, 10), note || null);
    req.flash('success', `Mijoz qo'shildi. Login: ${phone}, parol: ${password}`);
    res.redirect(`/admin/clients/${r.lastInsertRowid}`);
  } catch (e) {
    req.flash('error', 'Bu telefon raqam allaqachon mavjud');
    res.redirect('/admin/clients');
  }
});

// Tanlangan bir nechta mijozga birdaniga to'lov haqida xabar yuborish
// MUHIM: bu /clients/:id dan OLDIN turishi kerak, aks holda Express "message-bulk"ni :id deb qabul qiladi
router.post('/clients/message-bulk', (req, res) => {
  const ids = [].concat(req.body.client_ids || []).map(Number).filter(Boolean);
  const text = (req.body.text || '').trim();
  if (!ids.length) { req.flash('error', "Kamida bitta mijoz tanlang"); return res.redirect('/admin/clients'); }
  if (!text) { req.flash('error', "Xabar matnini kiriting"); return res.redirect('/admin/clients'); }
  let sent = 0, skipped = 0;
  for (const id of ids) {
    const c = db.prepare('SELECT tg_chat_id FROM clients WHERE id = ?').get(id);
    if (c?.tg_chat_id) { tg.send(c.tg_chat_id, text); sent++; } else { skipped++; }
  }
  req.flash('success', `${sent} mijozga xabar yuborildi` + (skipped ? ` (${skipped} tasida Telegram ulanmagan, o'tkazib yuborildi)` : ''));
  res.redirect('/admin/clients');
});

router.get('/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/admin/clients');
  const services = db.prepare('SELECT * FROM services WHERE client_id = ? ORDER BY id').all(client.id);
  const payments = db.prepare('SELECT p.*, s.name AS service_name FROM payments p JOIN services s ON s.id = p.service_id WHERE p.client_id = ? ORDER BY p.id DESC LIMIT 50').all(client.id);
  const topups = db.prepare('SELECT * FROM topups WHERE client_id = ? ORDER BY id DESC LIMIT 50').all(client.id);
  res.render('admin/client', { title: client.name, c: client, services, payments, topups, defaultDate: addMonths(today(), 1) });
});

router.post('/clients/:id', (req, res) => {
  const { name, note, password } = req.body;
  const phone = normPhone(req.body.phone);
  try {
    db.prepare('UPDATE clients SET name = ?, phone = ?, note = ? WHERE id = ?').run(name.trim(), phone, note || null, req.params.id);
    if (password) {
      if (password.length < 6) throw new Error("Parol kamida 6 belgi bo'lsin");
      db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
    }
    req.flash('success', 'Saqlandi' + (password ? `. Yangi parol: ${password}` : ''));
  } catch (e) {
    req.flash('error', e.message.includes('UNIQUE') ? 'Bu telefon raqam band' : e.message);
  }
  res.redirect(`/admin/clients/${req.params.id}`);
});

router.post('/clients/:id/unlink-tg', (req, res) => {
  db.prepare('UPDATE clients SET tg_chat_id = NULL WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/clients/${req.params.id}`);
});

// Naqd yoki boshqa yo'l bilan to'langanda balansni qo'lda to'g'rilash (musbat = qo'shish, manfiy = ayirish)
router.post('/clients/:id/balance', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/admin/clients');
  const raw = Math.abs(parseInt(String(req.body.amount).replace(/\D/g, ''), 10) || 0);
  if (!raw) { req.flash('error', "Summani kiriting"); return res.redirect(`/admin/clients/${req.params.id}`); }
  const subtract = req.body.direction === 'subtract';
  const capped = subtract && raw > client.balance;
  const delta = subtract ? -Math.min(raw, client.balance) : raw;
  db.prepare('UPDATE clients SET balance = balance + ? WHERE id = ?').run(delta, client.id);
  const newBalance = client.balance + delta;
  tg.send(client.tg_chat_id, `💰 Hisobingiz admin tomonidan ${delta > 0 ? "to'ldirildi" : 'ayirildi'}: ${delta > 0 ? '+' : ''}${delta.toLocaleString('ru-RU')} so'm\nJoriy balans: <b>${newBalance.toLocaleString('ru-RU')} so'm</b>`);
  req.flash(capped ? 'error' : 'success',
    (capped ? `Balansda shuncha mablag' yo'q edi, faqat ${client.balance.toLocaleString('ru-RU')} so'm ayirildi. ` : '') +
    `Joriy balans: ${newBalance.toLocaleString('ru-RU')} so'm`);
  res.redirect(`/admin/clients/${req.params.id}`);
});

router.post('/clients/:id/message', (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (c?.tg_chat_id && req.body.text) tg.send(c.tg_chat_id, req.body.text);
  req.flash('success', 'Xabar yuborildi');
  res.redirect(`/admin/clients/${req.params.id}`);
});

router.post('/clients/:id/delete', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  req.flash('success', "Mijoz o'chirildi");
  res.redirect('/admin/clients');
});

// ---------- Xizmatlar (bot / sayt) ----------
router.get('/services', (req, res) => {
  const services = db.prepare('SELECT s.*, c.name AS client_name, c.phone FROM services s JOIN clients c ON c.id = s.client_id ORDER BY s.paid_until').all();
  res.render('admin/services', { title: 'Xizmatlar', services });
});

function svcFields(b) {
  return {
    name: (b.name || '').trim(),
    type: b.type === 'sayt' ? 'sayt' : 'bot',
    price: Math.max(0, parseInt(String(b.price).replace(/\D/g, ''), 10) || 0),
    paid_until: /^\d{4}-\d{2}-\d{2}$/.test(b.paid_until) ? b.paid_until : today(),
    stop_cmd: (b.stop_cmd || '').trim() || null,
    start_cmd: (b.start_cmd || '').trim() || null,
  };
}

router.post('/services', (req, res) => {
  const f = svcFields(req.body);
  if (!f.name) { req.flash('error', 'Nomini kiriting'); return res.redirect(back(req, '/admin')); }
  db.prepare('INSERT INTO services (client_id, name, type, price, paid_until, stop_cmd, start_cmd) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.body.client_id, f.name, f.type, f.price, f.paid_until, f.stop_cmd, f.start_cmd);
  req.flash('success', "Xizmat qo'shildi");
  res.redirect(`/admin/clients/${req.body.client_id}`);
});

router.get('/services/:id', (req, res) => {
  const service = billing.getService(req.params.id);
  if (!service) return res.redirect('/admin/services');
  res.render('admin/service', { title: service.name, service });
});

router.post('/services/:id', (req, res) => {
  const f = svcFields(req.body);
  db.prepare('UPDATE services SET name=?, type=?, price=?, paid_until=?, stop_cmd=?, start_cmd=? WHERE id=?')
    .run(f.name, f.type, f.price, f.paid_until, f.stop_cmd, f.start_cmd, req.params.id);
  req.flash('success', 'Saqlandi');
  res.redirect(`/admin/services/${req.params.id}`);
});

router.post('/services/:id/delete', (req, res) => {
  const s = billing.getService(req.params.id);
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  req.flash('success', "Xizmat o'chirildi");
  res.redirect(s ? `/admin/clients/${s.client_id}` : '/admin/services');
});

router.post('/services/:id/suspend', async (req, res) => {
  const r = await billing.suspendService(req.params.id, 'manual');
  req.flash(r.cmd?.ok === false ? 'error' : 'success', "To'xtatildi. " + (r.cmd?.ok === false ? 'Buyruq xato berdi — chiqishni tekshiring' : ''));
  res.redirect(back(req, '/admin/services'));
});

router.post('/services/:id/resume', async (req, res) => {
  const r = await billing.resumeService(req.params.id);
  req.flash(r.cmd?.ok === false ? 'error' : 'success', 'Yoqildi. ' + (r.cmd?.ok === false ? 'Buyruq xato berdi — chiqishni tekshiring' : ''));
  res.redirect(back(req, '/admin/services'));
});

// Naqd yoki boshqa yo'l bilan to'langanda qo'lda uzaytirish
router.post('/services/:id/extend', async (req, res) => {
  const months = Math.min(24, Math.max(1, parseInt(req.body.months, 10) || 1));
  const s = billing.getService(req.params.id);
  if (!s) return res.redirect('/admin/services');
  if (req.body.record === '1') {
    const r = db.prepare("INSERT INTO payments (client_id, service_id, months, amount, comment, status, admin_note) VALUES (?, ?, ?, ?, 'Admin tomonidan', 'pending', 'Qo''lda')")
      .run(s.client_id, s.id, months, s.price * months);
    await billing.approvePayment(r.lastInsertRowid, "Qo'lda qo'shildi");
  } else {
    await billing.extendService(s.id, months);
  }
  req.flash('success', `${months} oyga uzaytirildi`);
  res.redirect(back(req, '/admin/services'));
});

// Muddatni qo'lda, aniq sanaga o'rnatish (mijoz sahifasidan to'g'ridan-to'g'ri)
router.post('/services/:id/set-date', async (req, res) => {
  const s = billing.getService(req.params.id);
  if (!s) return res.redirect('/admin/services');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_until)) {
    req.flash('error', "Sana noto'g'ri formatda");
    return res.redirect(back(req, '/admin/services'));
  }
  db.prepare('UPDATE services SET paid_until = ? WHERE id = ?').run(req.body.paid_until, s.id);
  if (s.status === 'suspended' && req.body.paid_until >= today()) {
    await billing.resumeService(s.id);
  }
  req.flash('success', `Muddat ${fmtDate(req.body.paid_until)} ga o'zgartirildi`);
  res.redirect(back(req, '/admin/services'));
});

// ---------- To'lovlar ----------
router.get('/payments', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const payments = db.prepare(`SELECT p.*, c.name AS client_name, c.phone, s.name AS service_name FROM payments p
    JOIN clients c ON c.id = p.client_id JOIN services s ON s.id = p.service_id
    ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 300`).all(...(status ? [status] : []));
  res.render('admin/payments', { title: "To'lovlar", payments, status });
});

router.get('/receipt/:id', (req, res) => {
  const p = db.prepare('SELECT receipt_path FROM payments WHERE id = ?').get(req.params.id);
  if (!p?.receipt_path || !fs.existsSync(p.receipt_path)) return res.status(404).send('Chek topilmadi');
  res.sendFile(p.receipt_path);
});

router.post('/payments/:id/approve', async (req, res) => {
  const r = await billing.approvePayment(Number(req.params.id), req.body.note || null);
  req.flash(r.ok ? 'success' : 'error', r.ok ? `Tasdiqlandi. Yangi muddat: ${r.paid_until}` : r.error);
  res.redirect(back(req, '/admin/payments'));
});

router.post('/payments/:id/reject', async (req, res) => {
  const r = await billing.rejectPayment(Number(req.params.id), req.body.note || null);
  req.flash(r.ok ? 'success' : 'error', r.ok ? 'Rad etildi' : r.error);
  res.redirect(back(req, '/admin/payments'));
});

// ---------- Hisobga pul qo'shish so'rovlari ----------
router.get('/topups', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const topups = db.prepare(`SELECT t.*, c.name AS client_name, c.phone FROM topups t
    JOIN clients c ON c.id = t.client_id
    ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.id DESC LIMIT 300`).all(...(status ? [status] : []));
  res.render('admin/topups', { title: "Hisobga pul qo'shish", topups, status });
});

router.get('/topup-receipt/:id', (req, res) => {
  const t = db.prepare('SELECT receipt_path FROM topups WHERE id = ?').get(req.params.id);
  if (!t?.receipt_path || !fs.existsSync(t.receipt_path)) return res.status(404).send('Chek topilmadi');
  res.sendFile(t.receipt_path);
});

router.post('/topups/:id/approve', async (req, res) => {
  const r = await billing.approveTopup(Number(req.params.id), req.body.note || null);
  req.flash(r.ok ? 'success' : 'error', r.ok ? `Tasdiqlandi. Yangi balans: ${Number(r.balance).toLocaleString('ru-RU')} so'm` : r.error);
  res.redirect(back(req, '/admin/topups'));
});

router.post('/topups/:id/reject', async (req, res) => {
  const r = await billing.rejectTopup(Number(req.params.id), req.body.note || null);
  req.flash(r.ok ? 'success' : 'error', r.ok ? 'Rad etildi' : r.error);
  res.redirect(back(req, '/admin/topups'));
});

// ---------- Sozlamalar ----------
router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Sozlamalar', s: getSettings() }));

router.post('/settings', (req, res) => {
  for (const k of ['site_name', 'card_number', 'card_holder', 'card_bank', 'grace_days', 'remind_days', 'pay_note', 'admin_contact']) {
    if (k in req.body) setSetting(k, String(req.body[k]).trim());
  }
  req.flash('success', 'Sozlamalar saqlandi');
  res.redirect('/admin/settings');
});

router.post('/run-check', async (req, res) => {
  await billing.dailyCheck();
  req.flash('success', 'Tekshiruv bajarildi (eslatmalar yuborildi, muddati o\'tganlar to\'xtatildi)');
  res.redirect('/admin');
});

module.exports = router;
