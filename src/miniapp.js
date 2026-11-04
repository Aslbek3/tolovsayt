// Telegram Mini App — initData'ni HMAC-SHA256 bilan tasdiqlash (rasmiy algoritm)
const crypto = require('crypto');

function verifyInitData(raw) {
  // raw — URL query-string ko'rinishidagi initData (Mini App window.Telegram.WebApp.initData)
  if (!raw || typeof raw !== 'string') return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN || '').digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  let a, b;
  try {
    a = Buffer.from(computedHash, 'hex');
    b = Buffer.from(hash, 'hex');
  } catch {
    return null;
  }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (Date.now() / 1000 - authDate) > 3600) return null; // 1 soatdan eski — rad

  const userRaw = params.get('user');
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch { user = null; }
  if (!user || !user.id) return null;

  return { user, authDate };
}

// Express middleware — Mini App so'rovlarini tasdiqlaydi (mijozni bazadan QIDIRMAYDI,
// faqat Telegram foydalanuvchisi ekanini tekshiradi). Mijozni topish alohida qadam.
function requireTgAuth(req, res, next) {
  const raw = req.header('X-Tg-Init-Data');
  const result = verifyInitData(raw);
  if (!result) return res.status(401).json({ error: 'invalid_init_data' });
  req.tgUser = result.user;
  next();
}

module.exports = { verifyInitData, requireTgAuth };
