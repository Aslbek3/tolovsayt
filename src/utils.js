const crypto = require('crypto');

function pad(n) { return String(n).padStart(2, '0'); }

// Bugungi sana (server vaqt zonasi: Asia/Tashkent) YYYY-MM-DD
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// Sanaga N oy qo'shish (31-yanvar + 1 oy = 28/29-fevral)
function addMonths(dateStr, months) {
  const d = parse(dateStr);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

// b - a (kunlarda)
function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000);
}

function daysLeft(paidUntil) {
  return daysBetween(today(), paidUntil);
}

function money(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/ /g, ' ') + " so'm";
}

function token(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

function normPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 9) return '998' + digits;
  return digits;
}

// Bazada raqam faqat raqamlardan iborat saqlanadi (998901234567).
// Ko'rsatish uchun o'qishga qulay shaklga keltiramiz: +998 90 123 45 67
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const m = d.match(/^998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  if (m) return `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  return d ? '+' + d : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { today, fmtDate, addMonths, daysBetween, daysLeft, money, token, normPhone, fmtPhone, esc };
