const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'db.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  tg_chat_id TEXT,
  tg_link_token TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bot',          -- bot | sayt
  price INTEGER NOT NULL DEFAULT 0,          -- oylik narx (so'm)
  paid_until TEXT NOT NULL,                  -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'active',     -- active | suspended
  stop_cmd TEXT,                             -- masalan: pm2 stop mybot
  start_cmd TEXT,                            -- masalan: pm2 start mybot
  last_cmd_output TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  months INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL,
  receipt_path TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  admin_note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  service_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  for_date TEXT NOT NULL,
  PRIMARY KEY (service_id, kind, for_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  receipt_path TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  admin_note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  reviewed_at TEXT
);
`);

// Eski bazalarda clients.balance ustuni bo'lmasligi mumkin — xavfsiz qo'shish
const hasBalance = db.prepare("SELECT 1 FROM pragma_table_info('clients') WHERE name = 'balance'").get();
if (!hasBalance) db.exec('ALTER TABLE clients ADD COLUMN balance INTEGER NOT NULL DEFAULT 0');

// Balans oxirgi marta qachon TO'LDIRILGANI — avto-yechish mijozga 15 daqiqa vaqt berishi uchun
const hasBalanceAt = db.prepare("SELECT 1 FROM pragma_table_info('clients') WHERE name = 'balance_at'").get();
if (!hasBalanceAt) db.exec('ALTER TABLE clients ADD COLUMN balance_at TEXT');

const defaults = {
  site_name: "Server to'lovlari",
  card_number: '8600 0000 0000 0000',
  card_holder: 'Ism Familiya',
  card_bank: 'Uzcard',
  grace_days: '3',
  remind_days: '5,3,1,0',
  pay_note: "To'lovni amalga oshirgach, chek (skrinshot) rasmini yuklang. Admin tasdiqlagach muddat avtomatik uzayadi.",
  // Mijoz sahifalarida "admin bilan bog'lanish" havolasi uchun
  admin_contact: '@Coder_uzzz',
};
const insDef = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insDef.run(k, v);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaults[key];
}
function getSettings() {
  const out = { ...defaults };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { db, getSetting, getSettings, setSetting };
