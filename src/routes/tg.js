// Telegram Mini App uchun JSON API — mijoz kabineti funksiyalarining Mini App ekvivalenti.
// Autentifikatsiya cookie-session EMAS, balki har so'rovda X-Tg-Init-Data header orqali.
const express = require('express');
const { db, getSettings } = require('../db');
const { requireTgAuth } = require('../miniapp');
const billing = require('../billing');
const upload = require('./upload');
const tg = require('../telegram');
const { fmtPhone } = require('../utils');

const router = express.Router();
router.use(express.json());
router.use(requireTgAuth);

// Mijozni tg_chat_id bo'yicha topadigan yordamchi
function findClient(tgUserId) {
  return db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(String(tgUserId));
}

// Har bir mijozga tegishli endpoint'da bu middleware ishlatiladi
function requireLinkedClient(req, res, next) {
  const client = findClient(req.tgUser.id);
  if (!client) return res.status(403).json({ error: 'not_linked' });
  req.client = client;
  next();
}

// Multer xatosini (masalan, ruxsat etilmagan fayl turi) JSON ko'rinishida qaytaradigan yordamchi
function uploadReceipt(req, res, next) {
  upload.single('receipt')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'upload_error' });
    next();
  });
}

// Mijoz hisobining to'liq holati — dashboard + tarixning Mini App ekvivalenti.
// Har safar bazadan yangilanadi, brauzer tomonida keshlanmaydi.
router.post('/session', (req, res) => {
  const client = findClient(req.tgUser.id);
  if (!client) return res.json({ linked: false });

  const services = db.prepare('SELECT * FROM services WHERE client_id = ? ORDER BY paid_until').all(client.id);

  // Tekshirilayotgan cheklar — xizmat id si bo'yicha (src/routes/client.js dagi mantiq bilan bir xil)
  const pendingByService = {};
  for (const p of db.prepare(`SELECT id, service_id, amount, months, created_at FROM payments
    WHERE client_id = ? AND status = 'pending' ORDER BY id DESC`).all(client.id)) {
    if (!pendingByService[p.service_id]) {
      pendingByService[p.service_id] = { id: p.id, amount: p.amount, months: p.months, created_at: p.created_at };
    }
  }

  // Oxirgi rad etilgan to'lov: 14 kun ichida VA undan keyin yangi to'lov yuborilmagan bo'lsa
  const rejected = db.prepare(`SELECT p.service_id, s.name AS service_name, p.amount, p.admin_note
    FROM payments p JOIN services s ON s.id = p.service_id
    WHERE p.client_id = ? AND p.status = 'rejected'
      AND p.created_at >= date('now','localtime','-14 day')
      AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.service_id = p.service_id AND p2.id > p.id)
    ORDER BY p.id DESC LIMIT 1`).get(client.id) || null;

  const summary = billing.accountSummary(client.id);
  const settings = getSettings();

  // To'lov + hisob to'ldirish tarixi bitta ro'yxatda (src/routes/client.js GET /payments bilan bir xil)
  const paymentsRows = db.prepare(`SELECT p.id, p.created_at, p.amount, p.status, p.admin_note, p.comment, p.months,
      s.name AS service_name, s.type AS type
    FROM payments p JOIN services s ON s.id = p.service_id
    WHERE p.client_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 50`).all(client.id)
    .map(r => ({ kind: 'payment', ...r }));

  const topupsRows = db.prepare(`SELECT id, created_at, amount, status, admin_note, comment
    FROM topups WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`).all(client.id)
    .map(r => ({ kind: 'topup', ...r }));

  const payments = paymentsRows.concat(topupsRows)
    .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : (a.created_at < b.created_at ? 1 : -1)))
    .slice(0, 20);

  res.json({
    linked: true,
    client: {
      name: client.name,
      phone: fmtPhone(client.phone),
      created_at: client.created_at,
      tg_chat_id: client.tg_chat_id,
    },
    services,
    balance: client.balance,
    pendingByService,
    rejected,
    summary,
    payments,
    // Bank karta ma'lumotlari va admin kontakti — pay/topup ekranlarida kerak
    // (dashboard.ejs/pay.ejs ham shu sozlamalardan foydalanadi)
    settings: {
      card_number: settings.card_number,
      card_holder: settings.card_holder,
      card_bank: settings.card_bank,
      pay_note: settings.pay_note,
      admin_contact: settings.admin_contact,
    },
  });
});

// Hisob hali ulanmagan foydalanuvchiga botdan kontakt so'raydi (requireLinkedClient KERAK EMAS)
router.post('/request-contact', async (req, res) => {
  // DIQQAT: `tg.call` src/telegram.js dan eksport qilinmagan (ichki funksiya).
  // `tg.send(chatId, text, extra)` xuddi shu ishni qiladi — extra ichidagi
  // reply_markup call()ga shunchaki uzatiladi, boshqa joylarda ham shunday ishlatiladi.
  const r = await tg.send(req.tgUser.id, "📱 Hisobingizni ulash uchun raqamingizni yuboring:", {
    reply_markup: {
      keyboard: [[{ text: '📱 Raqamni ulashish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
  if (!r) return res.json({ ok: false, error: 'bot_not_started' });
  res.json({ ok: true });
});

// Balansdan to'lash
router.post('/pay-balance', requireLinkedClient, async (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?')
    .get(req.body.serviceId, req.client.id);
  if (!service) return res.status(404).json({ error: 'not_found' });
  const months = Math.min(12, Math.max(1, parseInt(req.body.months, 10) || 1));
  const r = await billing.payFromBalance(service.id, months);
  res.json(r);
});

// Chek yuklab xizmat uchun to'lov (src/routes/client.js POST /pay/:id bilan bir xil mantiq)
router.post('/pay-receipt', requireLinkedClient, uploadReceipt, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?')
    .get(req.body.serviceId, req.client.id);
  if (!service) return res.status(404).json({ error: 'not_found' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const months = Math.min(12, Math.max(1, parseInt(req.body.months, 10) || 1));
  const amount = service.price * months;
  const comment = (req.body.comment || '').slice(0, 500) || null;

  const r = db.prepare('INSERT INTO payments (client_id, service_id, months, amount, receipt_path, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.client.id, service.id, months, amount, req.file.path, comment);

  tg.notifyAdminPayment({
    id: r.lastInsertRowid, client_name: req.client.name, phone: req.client.phone,
    service_name: service.name, months, amount, comment, receipt_path: req.file.path,
  }).catch(console.error);

  res.json({ ok: true });
});

// Chek yuklab hisobni to'ldirish (src/routes/client.js POST /topup bilan bir xil mantiq)
router.post('/topup-receipt', requireLinkedClient, uploadReceipt, async (req, res) => {
  const amount = Math.max(1000, parseInt(String(req.body.amount).replace(/\D/g, ''), 10) || 0);
  if (!req.body.amount || !amount) return res.status(400).json({ error: 'invalid_amount' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const comment = (req.body.comment || '').slice(0, 500) || null;
  const r = await billing.requestTopup(req.client.id, amount, req.file.path, comment);
  res.json(r);
});

// Umumiy xato ushlagich — yuqoridagi handler'lardan birida kutilmagan xato chiqsa ham JSON qaytsin
router.use((err, req, res, next) => {
  console.error('[tg route] xato:', err);
  res.status(500).json({ error: 'server_error' });
});

module.exports = { router, findClient, requireLinkedClient };
