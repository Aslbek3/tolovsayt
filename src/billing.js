// To'lovlarni tasdiqlash, xizmatlarni to'xtatish/yoqish, eslatmalar
const { exec } = require('child_process');
const { db, getSetting } = require('./db');
const tg = require('./telegram');
const { today, addMonths, daysLeft, fmtDate, money, esc } = require('./utils');

function runCmd(cmd) {
  return new Promise(resolve => {
    if (!cmd || !cmd.trim()) return resolve({ ok: true, out: '(buyruq yo\'q)' });
    exec(cmd, { timeout: 60000, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: ((stdout || '') + (stderr || '') + (err ? `\n${err.message}` : '')).slice(-2000) });
    });
  });
}

function getService(id) {
  return db.prepare(`SELECT s.*, c.name AS client_name, c.tg_chat_id, c.phone
    FROM services s JOIN clients c ON c.id = s.client_id WHERE s.id = ?`).get(id);
}

async function suspendService(id, reason = 'auto') {
  const s = getService(id);
  if (!s) return { ok: false, error: 'Xizmat topilmadi' };
  const r = await runCmd(s.stop_cmd);
  db.prepare("UPDATE services SET status = 'suspended', last_cmd_output = ? WHERE id = ?").run(`[STOP ${new Date().toLocaleString()}]\n${r.out}`, id);
  if (reason === 'auto') {
    tg.send(s.tg_chat_id, `⛔ <b>${esc(s.name)}</b> to'lov qilinmagani sababli to'xtatildi.\nQayta yoqish uchun saytdan to'lov qiling: ${process.env.SITE_URL || ''}`);
    tg.sendAdmin(`⛔ Avto to'xtatildi: <b>${esc(s.name)}</b> (${esc(s.client_name)})${r.ok ? '' : '\n⚠️ Buyruq xatosi:\n<code>' + esc(r.out.slice(-500)) + '</code>'}`);
  }
  return { ok: true, cmd: r };
}

async function resumeService(id) {
  const s = getService(id);
  if (!s) return { ok: false, error: 'Xizmat topilmadi' };
  const r = await runCmd(s.start_cmd);
  db.prepare("UPDATE services SET status = 'active', last_cmd_output = ? WHERE id = ?").run(`[START ${new Date().toLocaleString()}]\n${r.out}`, id);
  if (!r.ok) tg.sendAdmin(`⚠️ <b>${esc(s.name)}</b> ni yoqishda xato:\n<code>${esc(r.out.slice(-500))}</code>`);
  return { ok: true, cmd: r };
}

// Muddatni uzaytirish: muddat o'tmagan bo'lsa — paid_until dan, o'tgan bo'lsa — bugundan
async function extendService(id, months) {
  const s = getService(id);
  if (!s) return { ok: false, error: 'Xizmat topilmadi' };
  const base = s.paid_until >= today() ? s.paid_until : today();
  const newDate = addMonths(base, months);
  db.prepare('UPDATE services SET paid_until = ? WHERE id = ?').run(newDate, id);
  if (s.status === 'suspended') await resumeService(id);
  return { ok: true, paid_until: newDate };
}

async function approvePayment(paymentId, note = null) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return { ok: false, error: "To'lov topilmadi" };
  if (p.status !== 'pending') return { ok: false, error: "Bu to'lov allaqachon ko'rib chiqilgan" };
  db.prepare("UPDATE payments SET status = 'approved', admin_note = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(note, paymentId);
  const r = await extendService(p.service_id, p.months);
  const s = getService(p.service_id);
  if (s) {
    tg.send(s.tg_chat_id, `✅ To'lovingiz tasdiqlandi!\n<b>${esc(s.name)}</b> — ${p.months} oy, ${money(p.amount)}\n📅 Yangi muddat: <b>${fmtDate(r.paid_until)}</b>\nRahmat!`);
  }
  return { ok: true, paid_until: fmtDate(r.paid_until) };
}

async function rejectPayment(paymentId, note) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return { ok: false, error: "To'lov topilmadi" };
  if (p.status !== 'pending') return { ok: false, error: "Bu to'lov allaqachon ko'rib chiqilgan" };
  db.prepare("UPDATE payments SET status = 'rejected', admin_note = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(note || null, paymentId);
  const s = getService(p.service_id);
  if (s) {
    tg.send(s.tg_chat_id, `❌ <b>${esc(s.name)}</b> uchun to'lovingiz (${money(p.amount)}) rad etildi.` + (note ? `\nSabab: ${esc(note)}` : '') + `\nSavollar bo'lsa admin bilan bog'laning.`);
  }
  return { ok: true };
}

function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

// Mijoz hisobni to'ldirish so'rovini yuboradi (chek admin tasdiqlashi kerak)
async function requestTopup(clientId, amount, receiptPath, comment) {
  const client = getClient(clientId);
  if (!client) return { ok: false, error: 'Mijoz topilmadi' };
  const r = db.prepare('INSERT INTO topups (client_id, amount, receipt_path, comment) VALUES (?, ?, ?, ?)').run(clientId, amount, receiptPath, comment || null);
  await tg.notifyAdminTopup({ id: r.lastInsertRowid, client_name: client.name, phone: client.phone, amount, comment, receipt_path: receiptPath });
  return { ok: true, id: r.lastInsertRowid };
}

async function approveTopup(topupId, note = null) {
  const t = db.prepare('SELECT * FROM topups WHERE id = ?').get(topupId);
  if (!t) return { ok: false, error: "Pul qo'shish so'rovi topilmadi" };
  if (t.status !== 'pending') return { ok: false, error: "Bu so'rov allaqachon ko'rib chiqilgan" };
  db.prepare("UPDATE topups SET status = 'approved', admin_note = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(note, topupId);
  db.prepare('UPDATE clients SET balance = balance + ? WHERE id = ?').run(t.amount, t.client_id);
  const client = getClient(t.client_id);
  if (client) {
    tg.send(client.tg_chat_id, `✅ Hisobingiz ${money(t.amount)} ga to'ldirildi!\n💰 Joriy balans: <b>${money(client.balance)}</b>`);
  }
  return { ok: true, balance: client ? client.balance : null };
}

async function rejectTopup(topupId, note) {
  const t = db.prepare('SELECT * FROM topups WHERE id = ?').get(topupId);
  if (!t) return { ok: false, error: "Pul qo'shish so'rovi topilmadi" };
  if (t.status !== 'pending') return { ok: false, error: "Bu so'rov allaqachon ko'rib chiqilgan" };
  db.prepare("UPDATE topups SET status = 'rejected', admin_note = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(note || null, topupId);
  const client = getClient(t.client_id);
  if (client) {
    tg.send(client.tg_chat_id, `❌ Hisobingizga ${money(t.amount)} qo'shish so'rovi rad etildi.` + (note ? `\nSabab: ${esc(note)}` : '') + `\nSavollar bo'lsa admin bilan bog'laning.`);
  }
  return { ok: true };
}

// Balansdan to'lash — chek yuklash/admin tasdiqlovisiz, darhol xizmat muddatini uzaytiradi
async function payFromBalance(serviceId, months) {
  const s = getService(serviceId);
  if (!s) return { ok: false, error: 'Xizmat topilmadi' };
  const client = getClient(s.client_id);
  const amount = s.price * months;
  if (!client || client.balance < amount) return { ok: false, error: "Balansda yetarli mablag' yo'q" };
  db.prepare('UPDATE clients SET balance = balance - ? WHERE id = ?').run(amount, client.id);
  db.prepare(`INSERT INTO payments (client_id, service_id, months, amount, comment, status, admin_note, reviewed_at)
    VALUES (?, ?, ?, ?, 'Balansdan to''landi', 'approved', 'Balansdan avtomatik', datetime('now','localtime'))`).run(client.id, serviceId, months, amount);
  const r = await extendService(serviceId, months);
  return { ok: true, paid_until: fmtDate(r.paid_until), balance: client.balance - amount };
}

function logOnce(serviceId, kind, forDate) {
  const r = db.prepare('INSERT OR IGNORE INTO reminder_log (service_id, kind, for_date) VALUES (?, ?, ?)').run(serviceId, kind, forDate);
  return r.changes > 0;
}

// Eslatma xabari ostiga "To'lash" tugmasi (saytdagi shu xizmat uchun to'lov sahifasiga olib boradi)
function payButton(site, serviceId) {
  return site ? { reply_markup: { inline_keyboard: [[{ text: "💳 To'lash", url: `${site}/pay/${serviceId}` }]] } } : {};
}

// Har kuni ishlaydi: eslatmalar + muddati o'tganlarni to'xtatish
async function dailyCheck() {
  const grace = Number(getSetting('grace_days') || 0);
  const remindDays = String(getSetting('remind_days') || '').split(',').map(x => Number(x.trim())).filter(x => !isNaN(x));
  const site = process.env.SITE_URL || '';
  const services = db.prepare(`SELECT s.*, c.name AS client_name, c.tg_chat_id FROM services s JOIN clients c ON c.id = s.client_id`).all();
  const soonForAdmin = [];

  for (const s of services) {
    const left = daysLeft(s.paid_until);

    if (s.status === 'active') {
      if (remindDays.includes(left) && logOnce(s.id, 'remind_' + left, s.paid_until)) {
        const when = left === 0 ? '<b>bugun</b>' : `<b>${left} kundan keyin</b> (${fmtDate(s.paid_until)})`;
        const text = `🔔 Eslatma: <b>${esc(s.name)}</b> server to'lovi muddati ${when} tugaydi.\n💰 Oylik: ${money(s.price)}`;
        tg.send(s.tg_chat_id, text, payButton(site, s.id));
        if (left <= 1) soonForAdmin.push(s);
      }
      if (left < 0 && -left <= grace && logOnce(s.id, 'overdue', today())) {
        const text = `⚠️ <b>${esc(s.name)}</b> to'lov muddati ${-left} kun o'tdi!\n${grace + left + 1} kundan so'ng xizmat avtomatik to'xtatiladi.`;
        tg.send(s.tg_chat_id, text, payButton(site, s.id));
      }
      if (left < -grace) {
        await suspendService(s.id, 'auto');
      }
    }
  }

  if (soonForAdmin.length) {
    tg.sendAdmin('📋 Muddati yaqin xizmatlar:\n' + soonForAdmin.map(s => `• ${esc(s.name)} — ${esc(s.client_name)} — ${fmtDate(s.paid_until)}`).join('\n'));
  }
}

// Mijozning o'z xizmatlari haqida hisobot (Telegram bot uchun)
function clientServicesReport(clientId) {
  const services = db.prepare('SELECT * FROM services WHERE client_id = ? ORDER BY paid_until').all(clientId);
  if (!services.length) return 'Sizga hali xizmat biriktirilmagan.';
  return '📋 <b>Xizmatlaringiz:</b>\n\n' + services.map(s => {
    const left = daysLeft(s.paid_until);
    const statusIcon = s.status === 'suspended' ? "⛔ to'xtatilgan" : (left < 0 ? "⚠️ muddati o'tgan" : '✅ faol');
    const leftText = left < 0 ? `${-left} kun o'tgan` : left === 0 ? 'bugun tugaydi' : `${left} kun qoldi`;
    return `🤖 <b>${esc(s.name)}</b>\n💰 ${money(s.price)}/oy\n📅 Muddat: ${fmtDate(s.paid_until)} (${leftText})\n${statusIcon}`;
  }).join('\n\n');
}

// Mijozning so'nggi to'lovlari (Telegram bot uchun)
function clientPaymentsReport(clientId, limit = 10) {
  const rows = db.prepare(`SELECT p.*, s.name AS service_name FROM payments p JOIN services s ON s.id = p.service_id
    WHERE p.client_id = ? ORDER BY p.id DESC LIMIT ?`).all(clientId, limit);
  if (!rows.length) return "Hali to'lov tarixi yo'q.";
  const statusText = { pending: '⏳ Tekshirilmoqda', approved: '✅ Tasdiqlangan', rejected: '❌ Rad etilgan' };
  return "💳 <b>So'nggi to'lovlar:</b>\n\n" + rows.map(p =>
    `🤖 ${esc(p.service_name)} — ${p.months} oy — ${money(p.amount)}\n${statusText[p.status] || p.status} (${fmtDate(p.created_at)})`
  ).join('\n\n');
}

// Mijozning umumiy hisob holati — "Hisobim" bo'limi (sayt VA bot ikkalasi shu funksiyadan foydalanadi)
function accountSummary(clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;
  const services = db.prepare('SELECT * FROM services WHERE client_id = ?').all(clientId);
  const activeCount = services.filter(s => s.status === 'active').length;
  const suspendedCount = services.filter(s => s.status === 'suspended').length;
  const totalPaid = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE client_id = ? AND status = 'approved'").get(clientId).total;
  const lastPayment = db.prepare("SELECT created_at FROM payments WHERE client_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(clientId);
  const nearest = services.filter(s => s.status === 'active').sort((a, b) => a.paid_until < b.paid_until ? -1 : 1)[0];
  const topups = db.prepare('SELECT * FROM topups WHERE client_id = ? ORDER BY id DESC LIMIT 10').all(clientId);
  return {
    client, services, topups,
    balance: client.balance,
    totalServices: services.length,
    activeCount, suspendedCount,
    totalPaid,
    lastPaymentDate: lastPayment ? lastPayment.created_at : null,
    nearestDue: nearest ? nearest.paid_until : null,
  };
}

// "Hisobim" ma'lumotining Telegram bot uchun matn ko'rinishi
function clientAccountReport(clientId) {
  const a = accountSummary(clientId);
  if (!a) return 'Hisobingiz topilmadi.';
  const { client, totalServices, activeCount, suspendedCount, totalPaid, lastPaymentDate, nearestDue } = a;
  return '👤 <b>Hisobim</b>\n\n' +
    `Ism: <b>${esc(client.name)}</b>\n` +
    `Telefon: <b>+${esc(client.phone)}</b>\n` +
    `A'zo bo'lgan sana: ${fmtDate(client.created_at)}\n` +
    `💰 Balans: <b>${money(client.balance)}</b>\n\n` +
    '📊 <b>Statistika</b>\n' +
    `Jami xizmatlar: <b>${totalServices}</b> (✅ ${activeCount} faol, ⛔ ${suspendedCount} to'xtatilgan)\n` +
    `Jami to'langan: <b>${money(totalPaid)}</b>\n` +
    (lastPaymentDate ? `Oxirgi to'lov: ${fmtDate(lastPaymentDate)}\n` : '') +
    (nearestDue ? `Eng yaqin to'lov muddati: ${fmtDate(nearestDue)}\n` : '');
}

function dueReport(kind) {
  const rows = db.prepare(`SELECT s.*, c.name AS client_name, c.phone FROM services s JOIN clients c ON c.id = s.client_id ORDER BY s.paid_until`).all();
  const list = rows.filter(s => {
    const l = daysLeft(s.paid_until);
    return kind === 'overdue' ? l < 0 : l >= 0 && l <= 7;
  });
  if (!list.length) return kind === 'overdue' ? "✅ Qarzdorlar yo'q" : "✅ 7 kun ichida to'lovi bor xizmat yo'q";
  return (kind === 'overdue' ? '⚠️ Muddati o\'tganlar:\n' : '📅 7 kun ichida:\n') +
    list.map(s => `• ${esc(s.name)} — ${esc(s.client_name)} (${s.phone}) — ${fmtDate(s.paid_until)}${s.status === 'suspended' ? ' ⛔' : ''}`).join('\n');
}

module.exports = {
  runCmd, suspendService, resumeService, extendService, approvePayment, rejectPayment, dailyCheck, dueReport, getService,
  clientServicesReport, clientPaymentsReport, accountSummary, clientAccountReport,
  getClient, requestTopup, approveTopup, rejectTopup, payFromBalance,
};
