// Telegram Bot API bilan ishlash (kutubxonasiz, long polling)
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { esc, money, normPhone } = require('./utils');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const API = `https://api.telegram.org/bot${TOKEN}`;
let botUsername = null;

const CLIENT_MENU = { keyboard: [["📋 Xizmatlarim", "💳 To'lovlarim"], ['👤 Hisobim']], resize_keyboard: true };

// Mini App'ni ochadigan inline tugma — faqat HTTPS SITE_URL bo'lsa qo'shiladi
// (Telegram web_app tugmasi http (lokal) manzillarni qabul qilmaydi).
function miniAppButton() {
  const site = process.env.SITE_URL || '';
  if (!site.startsWith('https://')) return null;
  return { inline_keyboard: [[{ text: '💳 Kabinetni ochish', web_app: { url: `${site}/app` } }]] };
}

// Admin "/xabar" bilan tanlangan mijozlarga xabar yuborish jarayoni (xotirada, bitta admin uchun)
const broadcastState = new Map();

function buildBroadcastKeyboard(state) {
  const clients = db.prepare('SELECT id, name FROM clients WHERE tg_chat_id IS NOT NULL ORDER BY name').all();
  const rows = clients.map(c => [{ text: `${state.selected.has(c.id) ? '✅' : '⬜'} ${c.name}`, callback_data: `bc_toggle:${c.id}` }]);
  rows.push([{ text: `📨 Yuborish (${state.selected.size})`, callback_data: 'bc_send' }, { text: '❌ Bekor qilish', callback_data: 'bc_cancel' }]);
  return { inline_keyboard: rows };
}

async function call(method, body) {
  if (!TOKEN) return null;
  try {
    const isForm = body instanceof FormData;
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram] ${method}:`, data.description);
    return data.ok ? data.result : null;
  } catch (e) {
    console.error(`[telegram] ${method} xato:`, e.message);
    return null;
  }
}

function send(chatId, text, extra = {}) {
  if (!chatId) return null;
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

function sendAdmin(text, extra) {
  return Promise.all(ADMIN_CHAT_IDS.map(id => send(id, text, extra)));
}

// Ulangan mijozga Mini App'ni ochadigan tugmali qisqa xabar (SITE_URL https bo'lsa)
function sendMiniAppButton(chatId) {
  const kb = miniAppButton();
  if (!kb) return null;
  return send(chatId, '👇 Kabinetga kirish uchun:', { reply_markup: kb });
}

// Yangi to'lov haqida barcha adminlarga chek bilan xabar + Tasdiqlash/Rad etish tugmalari
async function notifyAdminPayment(p) {
  if (!ADMIN_CHAT_IDS.length) return;
  const caption =
    `🧾 <b>Yangi to'lov #${p.id}</b>\n` +
    `👤 ${esc(p.client_name)} (${esc(p.phone)})\n` +
    `🤖 ${esc(p.service_name)}\n` +
    `📅 ${p.months} oy\n` +
    `💰 ${Number(p.amount).toLocaleString('ru-RU')} so'm` +
    (p.comment ? `\n💬 ${esc(p.comment)}` : '');
  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ Tasdiqlash', callback_data: `approve:${p.id}` },
      { text: '❌ Rad etish', callback_data: `reject:${p.id}` },
    ]],
  };
  for (const chatId of ADMIN_CHAT_IDS) {
    if (p.receipt_path && fs.existsSync(p.receipt_path)) {
      const ext = path.extname(p.receipt_path).toLowerCase();
      const isImg = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
      const fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
      fd.append('reply_markup', JSON.stringify(reply_markup));
      fd.append(isImg ? 'photo' : 'document', new Blob([fs.readFileSync(p.receipt_path)]), 'chek' + ext);
      const r = await call(isImg ? 'sendPhoto' : 'sendDocument', fd);
      if (r) continue;
    }
    await send(chatId, caption, { reply_markup });
  }
}

// Yangi "hisobga pul qo'shish" so'rovi haqida barcha adminlarga chek bilan xabar + Tasdiqlash/Rad etish tugmalari
async function notifyAdminTopup(t) {
  if (!ADMIN_CHAT_IDS.length) return;
  const caption =
    `💰 <b>Hisobga pul qo'shish #${t.id}</b>\n` +
    `👤 ${esc(t.client_name)} (${esc(t.phone)})\n` +
    `💵 ${Number(t.amount).toLocaleString('ru-RU')} so'm` +
    (t.comment ? `\n💬 ${esc(t.comment)}` : '');
  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ Tasdiqlash', callback_data: `topup_approve:${t.id}` },
      { text: '❌ Rad etish', callback_data: `topup_reject:${t.id}` },
    ]],
  };
  for (const chatId of ADMIN_CHAT_IDS) {
    if (t.receipt_path && fs.existsSync(t.receipt_path)) {
      const ext = path.extname(t.receipt_path).toLowerCase();
      const isImg = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
      const fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
      fd.append('reply_markup', JSON.stringify(reply_markup));
      fd.append(isImg ? 'photo' : 'document', new Blob([fs.readFileSync(t.receipt_path)]), 'chek' + ext);
      const r = await call(isImg ? 'sendPhoto' : 'sendDocument', fd);
      if (r) continue;
    }
    await send(chatId, caption, { reply_markup });
  }
}

async function handleUpdate(u) {
  const billing = require('./billing');

  if (u.message && u.message.text) {
    const chatId = String(u.message.chat.id);
    const text = u.message.text.trim();

    if (text.startsWith('/start')) {
      const arg = text.split(' ')[1];
      if (arg) {
        const client = db.prepare('SELECT * FROM clients WHERE tg_link_token = ?').get(arg);
        if (client) {
          db.prepare('UPDATE clients SET tg_chat_id = ?, tg_link_token = NULL WHERE id = ?').run(chatId, client.id);
          await send(chatId, `✅ Assalomu alaykum, <b>${esc(client.name)}</b>!\nTelegram hisobingiz ulandi. Endi to'lov muddati yaqinlashganda shu yerga eslatma yuboriladi.\n\nXizmatlaringiz va to'lovlaringiz haqida ma'lumot olish uchun pastdagi tugmalardan foydalaning.`, { reply_markup: CLIENT_MENU });
          return sendMiniAppButton(chatId);
        }
        return send(chatId, "❌ Havola eskirgan yoki noto'g'ri. Saytdagi kabinetingizdan qaytadan ulang.");
      }
      if (ADMIN_CHAT_IDS.includes(chatId)) {
        return send(chatId, '👋 Siz adminsiz. Yangi to\'lovlar shu yerga keladi.\n\n/qarzdorlar — muddati o\'tganlar\n/yaqin — 7 kun ichida to\'lashi keraklar\n/xabar — tanlangan mijozlarga xabar yuborish');
      }
      const existing = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
      if (existing) {
        await send(chatId, `Assalomu alaykum, <b>${esc(existing.name)}</b>!\nXizmatlaringiz va to'lovlaringiz haqida ma'lumot olish uchun pastdagi tugmalardan foydalaning.`, { reply_markup: CLIENT_MENU });
        return sendMiniAppButton(chatId);
      }
      return send(chatId, `Assalomu alaykum! Sizning chat ID: <code>${chatId}</code>\n\nHisobingizni ulash uchun admin bilan bog'laning: @Coder_uzzz`);
    }

    if (ADMIN_CHAT_IDS.includes(chatId) && (text === '/qarzdorlar' || text === '/yaqin')) {
      return send(chatId, billing.dueReport(text === '/qarzdorlar' ? 'overdue' : 'soon'));
    }

    if (ADMIN_CHAT_IDS.includes(chatId) && text === '/xabar') {
      const state = { selected: new Set() };
      const kb = buildBroadcastKeyboard(state);
      if (kb.inline_keyboard.length === 1) return send(chatId, "Hozircha birorta mijoz Telegramini ulamagan.");
      broadcastState.set(chatId, state);
      return send(chatId, "📢 Xabar yuboriladigan mijoz(lar)ni tanlang:", { reply_markup: kb });
    }

    // Mijozning o'z xizmatlari/to'lovlari haqida so'rovi (ulangan chat uchun)
    if (text === '📋 Xizmatlarim' || text === '/xizmatlarim') {
      const client = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
      if (!client) return send(chatId, "Hisobingiz ulanmagan. Saytdagi kabinetingizdan \"Telegramni ulash\" tugmasini bosing.");
      return send(chatId, billing.clientServicesReport(client.id), { reply_markup: CLIENT_MENU });
    }
    if (text === "💳 To'lovlarim" || text === '/tolovlarim') {
      const client = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
      if (!client) return send(chatId, "Hisobingiz ulanmagan. Saytdagi kabinetingizdan \"Telegramni ulash\" tugmasini bosing.");
      return send(chatId, billing.clientPaymentsReport(client.id), { reply_markup: CLIENT_MENU });
    }
    if (text === '👤 Hisobim' || text === '/hisobim') {
      const client = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
      if (!client) return send(chatId, "Hisobingiz ulanmagan. Saytdagi kabinetingizdan \"Telegramni ulash\" tugmasini bosing.");
      return send(chatId, billing.clientAccountReport(client.id), { reply_markup: CLIENT_MENU });
    }

    // Rad etish sababi (admin javob yozsa)
    if (ADMIN_CHAT_IDS.includes(chatId) && u.message.reply_to_message) {
      const replyText = u.message.reply_to_message.text || '';
      const mPay = replyText.match(/To'lov #(\d+) uchun rad etish sababini/);
      if (mPay) {
        const r = await billing.rejectPayment(Number(mPay[1]), text);
        return send(chatId, r.ok ? `❌ To'lov #${mPay[1]} rad etildi.` : `⚠️ ${r.error}`);
      }
      const mTopup = replyText.match(/Pul qo'shish #(\d+) uchun rad etish sababini/);
      if (mTopup) {
        const r = await billing.rejectTopup(Number(mTopup[1]), text);
        return send(chatId, r.ok ? `❌ Pul qo'shish #${mTopup[1]} rad etildi.` : `⚠️ ${r.error}`);
      }
      if (/^📢 Tanlangan \d+ mijozga yuboriladigan xabar matnini yozing:/.test(replyText)) {
        const state = broadcastState.get(chatId);
        broadcastState.delete(chatId);
        if (!state || !state.selected.size) return send(chatId, "⚠️ Jarayon eskirgan, /xabar bilan qayta boshlang.");
        let sent = 0;
        for (const cid of state.selected) {
          const c = db.prepare('SELECT tg_chat_id FROM clients WHERE id = ?').get(cid);
          if (c?.tg_chat_id) { send(c.tg_chat_id, text); sent++; }
        }
        return send(chatId, `✅ ${sent} mijozga xabar yuborildi.`);
      }
    }
    return;
  }

  // Mijoz "Raqamni ulashish" tugmasini bosib kontaktini yuborgan — shu orqali hisobni ulaymiz
  if (u.message && u.message.contact) {
    const chatId = String(u.message.chat.id);

    // XAVFSIZLIK: faqat o'z raqamini yuborgan odam ishonchli — boshqa birovning
    // kontaktini ulashtirib ularning hisobiga kirib bo'lmasin
    if (String(u.message.contact.user_id) !== String(u.message.from.id)) {
      return send(chatId, "⚠️ Faqat o'zingizning raqamingizni ulashing.");
    }

    const phone = normPhone(u.message.contact.phone_number);
    const client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
    if (!client) {
      await send(chatId, "❌ Bu raqam bo'yicha hisob topilmadi. Admin bilan bog'laning: @Coder_uzzz", { reply_markup: { remove_keyboard: true } });
      sendAdmin(`⚠️ Noma'lum raqam Mini App orqali ulanishga urindi: <b>${esc(u.message.from.first_name || '')}</b> (chat ${chatId}), raqam: <code>${esc(phone)}</code>`);
      return;
    }

    db.prepare('UPDATE clients SET tg_chat_id = ? WHERE id = ?').run(chatId, client.id);
    await send(chatId, `✅ Hisobingiz ulandi, ${esc(client.name)}! Endi "💳 Kabinet" tugmasi orqali kiring.`, { reply_markup: CLIENT_MENU });
    return sendMiniAppButton(chatId);
  }

  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = String(q.message?.chat?.id || q.from.id);
    if (!ADMIN_CHAT_IDS.includes(chatId)) {
      return call('answerCallbackQuery', { callback_query_id: q.id, text: 'Ruxsat yo\'q' });
    }
    const [action, idStr] = (q.data || '').split(':');
    const id = Number(idStr);
    if (action === 'approve') {
      const r = await billing.approvePayment(id);
      await call('answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? 'Tasdiqlandi ✅' : r.error });
      if (r.ok) {
        await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: `✅ Tasdiqlandi — ${r.paid_until}`, callback_data: 'noop' }]] } });
      }
    } else if (action === 'reject') {
      await call('answerCallbackQuery', { callback_query_id: q.id });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send(chatId, `To'lov #${id} uchun rad etish sababini shu xabarga javob (reply) qilib yozing:`, { reply_markup: { force_reply: true } });
    } else if (action === 'topup_approve') {
      const r = await billing.approveTopup(id);
      await call('answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? 'Tasdiqlandi ✅' : r.error });
      if (r.ok) {
        await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: `✅ Tasdiqlandi — balans: ${money(r.balance)}`, callback_data: 'noop' }]] } });
      }
    } else if (action === 'topup_reject') {
      await call('answerCallbackQuery', { callback_query_id: q.id });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send(chatId, `Pul qo'shish #${id} uchun rad etish sababini shu xabarga javob (reply) qilib yozing:`, { reply_markup: { force_reply: true } });
    } else if (action === 'bc_toggle') {
      const state = broadcastState.get(chatId);
      if (!state) { await call('answerCallbackQuery', { callback_query_id: q.id, text: "Jarayon eskirgan, /xabar bilan qayta boshlang" }); return; }
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      await call('answerCallbackQuery', { callback_query_id: q.id });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: buildBroadcastKeyboard(state) });
    } else if (action === 'bc_send') {
      const state = broadcastState.get(chatId);
      if (!state || !state.selected.size) { await call('answerCallbackQuery', { callback_query_id: q.id, text: "Hech kim tanlanmadi" }); return; }
      await call('answerCallbackQuery', { callback_query_id: q.id });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send(chatId, `📢 Tanlangan ${state.selected.size} mijozga yuboriladigan xabar matnini yozing:`, { reply_markup: { force_reply: true } });
    } else if (action === 'bc_cancel') {
      broadcastState.delete(chatId);
      await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Bekor qilindi' });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    } else {
      await call('answerCallbackQuery', { callback_query_id: q.id });
    }
  }
}

async function startPolling() {
  if (!TOKEN) {
    console.log('[telegram] BOT_TOKEN yo\'q — Telegram o\'chirilgan');
    return;
  }
  const me = await call('getMe');
  botUsername = me?.username || null;
  await call('deleteWebhook', {});

  // Pastki chap tugmani "Kabinet" Mini App'iga aylantiramiz — FAQAT https SITE_URL bo'lsa,
  // chunki Telegram menu button uchun http (lokal) manzilni qabul qilmaydi.
  const site = process.env.SITE_URL || '';
  if (site.startsWith('https://')) {
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: '💳 Kabinet', web_app: { url: `${site}/app` } } });
  }

  console.log(`[telegram] bot ishga tushdi: @${botUsername}`);
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
      const data = await res.json();
      if (data.ok) {
        for (const u of data.result) {
          offset = u.update_id + 1;
          handleUpdate(u).catch(e => console.error('[telegram] update xato:', e));
        }
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

module.exports = { send, sendAdmin, notifyAdminPayment, notifyAdminTopup, startPolling, getBotUsername: () => botUsername };
