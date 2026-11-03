const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const upload = require('./upload');
const tg = require('../telegram');
const billing = require('../billing');
const { normPhone, token } = require('../utils');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring." });

function auth(req, res, next) {
  if (!req.session.clientId) return res.redirect('/login');
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  if (!client) { req.session.clientId = null; return res.redirect('/login'); }
  req.client = client;
  res.locals.me = client;
  next();
}

router.get('/login', (req, res) => {
  if (req.session.clientId) return res.redirect('/');
  res.render('client/login', { title: 'Kirish' });
});

router.post('/login', loginLimiter, (req, res) => {
  const phone = normPhone(req.body.phone);
  const c = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
  if (!c || !bcrypt.compareSync(req.body.password || '', c.password_hash)) {
    req.flash('error', "Telefon raqam yoki parol noto'g'ri");
    return res.redirect('/login');
  }
  req.session.clientId = c.id;
  res.redirect('/');
});

router.post('/logout', (req, res) => { req.session.clientId = null; res.redirect('/login'); });

router.get('/', auth, (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE client_id = ? ORDER BY paid_until').all(req.client.id);
  const pending = db.prepare("SELECT service_id FROM payments WHERE client_id = ? AND status = 'pending'").all(req.client.id).map(r => r.service_id);
  res.render('client/dashboard', { title: 'Mening xizmatlarim', services, pending, botUsername: tg.getBotUsername() });
});

router.post('/telegram-link', auth, (req, res) => {
  const t = token(12);
  db.prepare('UPDATE clients SET tg_link_token = ? WHERE id = ?').run(t, req.client.id);
  const bot = tg.getBotUsername();
  if (!bot) { req.flash('error', 'Telegram bot hozircha sozlanmagan'); return res.redirect('/'); }
  res.redirect(`https://t.me/${bot}?start=${t}`);
});

router.post('/telegram-unlink', auth, (req, res) => {
  db.prepare('UPDATE clients SET tg_chat_id = NULL WHERE id = ?').run(req.client.id);
  req.flash('success', 'Telegram uzildi');
  res.redirect('/profile');
});

router.get('/pay/:id', auth, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!service) return res.redirect('/');
  res.render('client/pay', { title: "To'lov", service, balance: req.client.balance });
});

router.post('/pay/:id/balance', auth, async (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!service) return res.redirect('/');
  const months = Math.min(12, Math.max(1, parseInt(req.body.months, 10) || 1));
  const r = await billing.payFromBalance(service.id, months);
  req.flash(r.ok ? 'success' : 'error', r.ok ? `To'landi! Yangi muddat: ${r.paid_until}` : r.error);
  res.redirect(r.ok ? '/' : `/pay/${service.id}`);
});

router.post('/pay/:id', auth, (req, res, next) => {
  upload.single('receipt')(req, res, err => {
    if (err) { req.flash('error', err.message); return res.redirect(`/pay/${req.params.id}`); }
    next();
  });
}, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!service) return res.redirect('/');
  if (!req.file) { req.flash('error', 'Chek rasmini yuklang'); return res.redirect(`/pay/${service.id}`); }
  const months = Math.min(12, Math.max(1, parseInt(req.body.months, 10) || 1));
  const amount = service.price * months;
  const comment = (req.body.comment || '').slice(0, 500) || null;
  const r = db.prepare('INSERT INTO payments (client_id, service_id, months, amount, receipt_path, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.client.id, service.id, months, amount, req.file.path, comment);
  tg.notifyAdminPayment({
    id: r.lastInsertRowid, client_name: req.client.name, phone: req.client.phone,
    service_name: service.name, months, amount, comment, receipt_path: req.file.path,
  }).catch(console.error);
  req.flash('success', "Chek yuborildi! Admin tekshirib tasdiqlagach, muddat avtomatik uzayadi.");
  res.redirect('/payments');
});

router.get('/payments', auth, (req, res) => {
  const payments = db.prepare(`SELECT p.*, s.name AS service_name FROM payments p JOIN services s ON s.id = p.service_id
    WHERE p.client_id = ? ORDER BY p.id DESC`).all(req.client.id);
  res.render('client/payments', { title: "To'lovlar tarixi", payments });
});

router.get('/hisobim', auth, (req, res) => {
  const summary = billing.accountSummary(req.client.id);
  res.render('client/hisobim', { title: 'Hisobim', summary });
});

router.get('/topup', auth, (req, res) => res.render('client/topup', { title: "Hisobni to'ldirish" }));

router.post('/topup', auth, (req, res, next) => {
  upload.single('receipt')(req, res, err => {
    if (err) { req.flash('error', err.message); return res.redirect('/topup'); }
    next();
  });
}, (req, res) => {
  const amount = Math.max(1000, parseInt(String(req.body.amount).replace(/\D/g, ''), 10) || 0);
  if (!req.body.amount || !amount) { req.flash('error', "To'g'ri summa kiriting (kamida 1 000 so'm)"); return res.redirect('/topup'); }
  if (!req.file) { req.flash('error', 'Chek rasmini yuklang'); return res.redirect('/topup'); }
  const comment = (req.body.comment || '').slice(0, 500) || null;
  billing.requestTopup(req.client.id, amount, req.file.path, comment).catch(console.error);
  req.flash('success', "So'rov yuborildi! Admin tekshirib tasdiqlagach, balansingiz to'ldiriladi.");
  res.redirect('/hisobim');
});

router.get('/profile', auth, (req, res) => res.render('client/profile', { title: 'Profil' }));

router.post('/profile/password', auth, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!bcrypt.compareSync(old_password || '', req.client.password_hash)) {
    req.flash('error', "Eski parol noto'g'ri"); return res.redirect('/profile');
  }
  if (!new_password || new_password.length < 6) {
    req.flash('error', "Yangi parol kamida 6 belgi bo'lsin"); return res.redirect('/profile');
  }
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.client.id);
  req.flash('success', "Parol o'zgartirildi");
  res.redirect('/profile');
});

module.exports = router;
