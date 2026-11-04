process.env.TZ = process.env.TZ || 'Asia/Tashkent';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const cron = require('node-cron');
const { getSettings } = require('./db');
const utils = require('./utils');
const tg = require('./telegram');
const billing = require('./billing');

if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD) {
  console.error('❗ .env faylida SESSION_SECRET va ADMIN_PASSWORD ni to\'ldiring');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.use(cookieSession({
  name: 'sid',
  keys: [process.env.SESSION_SECRET],
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
}));

// Har bir sahifa uchun umumiy o'zgaruvchilar
app.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.u = utils;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.path = req.path;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

app.use('/tg', require('./routes/tg').router);
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html')));
app.get('/admin-app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin-app', 'index.html')));

app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/client'));

app.use((req, res) => res.status(404).render('error', { title: 'Topilmadi', message: 'Sahifa topilmadi' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Xato', message: err.message || 'Server xatosi' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`✅ Sayt ishga tushdi: http://localhost:${PORT}`));

// Har kuni soat 10:00 da eslatmalar va avto to'xtatish
cron.schedule('0 10 * * *', () => billing.dailyCheck().catch(console.error), { timezone: 'Asia/Tashkent' });
// Ishga tushganda ham bir marta tekshirish
setTimeout(() => billing.dailyCheck().catch(console.error), 10000);

tg.startPolling();
