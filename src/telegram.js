// Telegram Bot API bilan ishlash (kutubxonasiz, long polling)
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { esc, money, normPhone, token } = require('./utils');

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

// Mijoz botga chek rasmini yubordi, lekin bir nechta xizmati bor — qaysi birini
// tanlashini kutamiz (xotirada, chatId bo'yicha)
const pendingReceipt = new Map();

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
    // Bot orqali (chek rasmi to'g'ridan-to'g'ri yuborilganda) qo'shiladi — saytdan/Mini
    // App'dan kelgan to'lovlarda bu maydonlar yo'q, shuning uchun qator butunlay tushib qoladi
    (p.tg_username || p.tg_id
      ? `💬 Telegram: ${p.tg_username ? '@' + esc(p.tg_username) : "username yo'q"}${p.tg_id ? ` (ID: <code>${p.tg_id}</code>)` : ''}\n`
      : '') +
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

// Telegram serveridan fayl yuklab olib uploads/ papkasiga saqlaydi — saytdagi
// multer yuklashlari bilan BIR XIL nomlash uslubida (Date.now() + token), shunda
// admin panel/chek ko'rish yo'li o'zgarishsiz ishlayveradi.
async function downloadTelegramFile(fileId) {
  const info = await call('getFile', { file_id: fileId });
  if (!info || !info.file_path) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(info.file_path) || '.jpg';
    const dir = path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}_${token(6)}${ext}`);
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (e) {
    console.error('[telegram] chek faylini yuklab olishda xato:', e.message);
    return null;
  }
}

// Mijoz botga chek rasmini TO'G'RIDAN-TO'G'RI yuborganda — saytdagi "chek yuklash"
// bilan bir xil natija: pending to'lov yozuvi + adminga tasdiqlash tugmalari.
// Bot orqali kelgan chek har doim 1 oy deb hisoblanadi (ko'proq oy uchun sayt/Mini App).
async function createReceiptPayment(client, service, fileId, tgInfo, chatId) {
  const filePath = await downloadTelegramFile(fileId);
  if (!filePath) return send(chatId, "⚠️ Chekni yuklab olishda xato. Qaytadan yuboring yoki saytdan foydalaning.");

  const months = 1;
  const amount = service.price * months;
  const r = db.prepare('INSERT INTO payments (client_id, service_id, months, amount, receipt_path) VALUES (?, ?, ?, ?, ?)')
    .run(client.id, service.id, months, amount, filePath);

  await notifyAdminPayment({
    id: r.lastInsertRowid, client_name: client.name, phone: client.phone,
    service_name: service.name, months, amount, receipt_path: filePath,
    tg_username: tgInfo.username, tg_id: tgInfo.id,
  });
  return send(chatId, `✅ Chekingiz qabul qilindi!\n🤖 <b>${esc(service.name)}</b> — 1 oy, ${money(amount)}\nAdmin tasdiqlagach muddat avtomatik uzayadi.`);
}

// Hisobi ulanmagan yoki xizmati yo'q odamdan kelgan chek — to'lov yozuvi YARATILMAYDI
// (qaysi xizmatga tegishli ekani noma'lum), faqat adminga forward qilinadi, ism/username/ID bilan
async function forwardUnknownReceipt(fileId, tgInfo, chatId, client) {
  if (!ADMIN_CHAT_IDS.length) return;
  const who = client
    ? `👤 ${esc(client.name)} (${esc(client.phone)}) — hisobi ulangan, lekin xizmati yo'q`
    : "⚠️ Hisobi ulanmagan odam";
  const caption =
    `🧾 <b>Chek keldi (avtomatik aniqlab bo'lmadi)</b>\n${who}\n` +
    `Ism: ${esc(tgInfo.name || '—')}${tgInfo.username ? ` (@${esc(tgInfo.username)})` : ''}\n` +
    `Telegram ID: <code>${tgInfo.id}</code>`;
  for (const adminId of ADMIN_CHAT_IDS) {
    await call('sendPhoto', { chat_id: adminId, photo: fileId, caption, parse_mode: 'HTML' });
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

  // Mijoz botga chek rasmini to'g'ridan-to'g'ri yuborgan — avtomatik to'lov so'rovi yaratamiz
  if (u.message && u.message.photo && u.message.photo.length) {
    const chatId = String(u.message.chat.id);
    const from = u.message.from || {};
    const tgInfo = { id: from.id, username: from.username, name: [from.first_name, from.last_name].filter(Boolean).join(' ') };
    // Eng katta o'lchamdagi versiyasi — Telegram bir nechta o'lchamda yuboradi, oxirgisi eng sifatlisi
    const fileId = u.message.photo[u.message.photo.length - 1].file_id;

    const client = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
    if (!client) {
      await forwardUnknownReceipt(fileId, tgInfo, chatId, null);
      return send(chatId, "Chekingiz adminga yuborildi, lekin hisobingiz hali ulanmagan — tezroq ko'rib chiqilishi uchun admin bilan bog'laning: @Coder_uzzz");
    }

    const services = db.prepare('SELECT * FROM services WHERE client_id = ?').all(client.id);
    if (!services.length) {
      await forwardUnknownReceipt(fileId, tgInfo, chatId, client);
      return send(chatId, "Sizda hali xizmat biriktirilmagan. Chekingiz baribir adminga yuborildi.");
    }
    if (services.length === 1) {
      return createReceiptPayment(client, services[0], fileId, tgInfo, chatId);
    }
    // Bir nechta xizmat bor — qaysi biri uchunligini so'raymiz, javobni kutamiz
    pendingReceipt.set(chatId, { fileId, tgInfo });
    const kb = { inline_keyboard: services.map(s => [{ text: s.name, callback_data: `recv_svc:${s.id}` }]) };
    return send(chatId, 'Bu chek qaysi xizmat uchun?', { reply_markup: kb });
  }

  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = String(q.message?.chat?.id || q.from.id);
    const [action, idStr] = (q.data || '').split(':');
    const id = Number(idStr);

    // Mijoz chek rasmi uchun xizmat tanlayapti — bu ADMIN tekshiruvidan oldin
    // turishi SHART, chunki mijoz admin emas (quyidagi guard uni rad etib yuborardi)
    if (action === 'recv_svc') {
      const pending = pendingReceipt.get(chatId);
      pendingReceipt.delete(chatId);
      await call('answerCallbackQuery', { callback_query_id: q.id });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      if (!pending) return send(chatId, "⚠️ Jarayon eskirgan, chekni qaytadan yuboring.");
      const client = db.prepare('SELECT * FROM clients WHERE tg_chat_id = ?').get(chatId);
      const service = client && db.prepare('SELECT * FROM services WHERE id = ? AND client_id = ?').get(id, client.id);
      if (!client || !service) return send(chatId, "⚠️ Xizmat topilmadi.");
      return createReceiptPayment(client, service, pending.fileId, pending.tgInfo, chatId);
    }

    if (!ADMIN_CHAT_IDS.includes(chatId)) {
      return call('answerCallbackQuery', { callback_query_id: q.id, text: 'Ruxsat yo\'q' });
    }
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
    // Hammaga (mijozlarga) — global standart tugma
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: '💳 Kabinet', web_app: { url: `${site}/app` } } });
    // Faqat adminlarga — shu chat uchun ALOHIDA tugma (chat_id bilan global ustidan yoziladi),
    // admin panelni (parolsiz, Telegram orqali) ochadigan Mini App'ga olib boradi
    for (const chatId of ADMIN_CHAT_IDS) {
      await call('setChatMenuButton', {
        chat_id: chatId,
        menu_button: { type: 'web_app', text: '🛠 Admin panel', web_app: { url: `${site}/admin-app` } },
      });
    }
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

module.exports = { send, sendAdmin, notifyAdminPayment, notifyAdminTopup, startPolling, getBotUsername: () => botUsername, ADMIN_CHAT_IDS };
