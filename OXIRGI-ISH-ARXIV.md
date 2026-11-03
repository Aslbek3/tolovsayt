## 2026-11-03 — Mijoz (user) tarafdagi "include is not a function" xatosi ham tuzatildi

Yuqoridagi tuzatish faqat admin tarafini yopgan edi — xuddi shu EJS "tuzoq"
muammosi mijoz (oddiy foydalanuvchi) tarafida ham bor ekan: `src/routes/client.js`da
`auth` middleware HAR BIR kirgan mijoz sahifasi uchun `res.locals.client = client`
o'rnatardi — bu esa login qilgan har qanday mijozning istalgan sahifasida (bosh
sahifa, profil, to'lovlar) VA ayniqsa xato yuz berganda chiqadigan `error.ejs`da
ham `include()`ni sindirib qo'yardi (mijoz parol bilan kirgach har qanday kichik
xato "include is not a function" ekranini ko'rsatardi).

- **Tuzatish:** `res.locals.client` → `res.locals.me` qilib o'zgartirildi
  (`req.client` o'zgarmadi, faqat shablonga yuboriladigan nom o'zgardi).
  `views/partials/header.ejs`, `views/client/dashboard.ejs`,
  `views/client/profile.ejs` ichidagi `client.xxx` → `me.xxx`.
- **Tekshirildi:** admin paneldan vaqtinchalik test mijoz yaratib (keyin
  o'chirilgan), unga kirib bosh sahifa/profil/to'lovlar sahifalari va 404 xato
  sahifasi — barchasi 200/404 to'g'ri qaytardi, "include" xatosi yo'qoldi.
  Haqiqiy saytda (`https://tolovqil.duckdns.org`) ham xato sahifasi tekshirildi.
- **Umumiy saboq:** EJS'ning `renderFile()` funksiyasi (faqat Express orqali —
  `res.render()` — chaqirilganda) locals ichidan `client`, `scope`, `context`,
  `debug`, `compileDebug`, `_with`, `rmWhitespace`, `strict`, `filename`,
  `async`, `cache` nomli kalitlarni o'z ichki sozlamasi deb o'g'irlab oladi.
  Shu nomlardan birortasini shablon ma'lumoti sifatida ishlatish bo'lmaydi.

## 2026-11-03 — Admin tarafdagi "include is not a function" xatosi tuzatildi

- **Muammo:** `/admin/clients/:id` sahifasi doim 500 xato berardi: "include is not a function".
- **Sabab:** `src/routes/admin.js` shablonga `client` nomli o'zgaruvchi yuborardi (mijoz ma'lumoti). EJS kutubxonasining `renderFile` funksiyasi Express orqali chaqirilganda, ma'lumotlar ichidan ba'zi "maxrfiy" nomlarni (jumladan aynan `client`) EJS'ning o'z kompilyatsiya sozlamasi deb noto'g'ri qabul qiladi — bu "client-side compile rejimi"ni yoqib, `include()` funksiyasini sindirib qo'yadi. Bu EJS kutubxonasining o'zidagi nozik "tuzoq" (reserved so'z), loyihaning xatosi emas edi.
- **Tuzatish:** `admin.js`da shablonga yuboriladigan kalit `client` → `c` qilib o'zgartirildi, `views/admin/client.ejs` ichidagi barcha `client.xxx` murojaatlari `c.xxx`ga almashtirildi.
- **Bonus tuzatish:** diagnostika paytida `obuna-tolov` PM2 jarayoni bu claudeweb sessiyasining o'z muhit (environment) o'zgaruvchilarini (masalan `PORT=3210`) meros qilib olib, portlar to'qnashganda ishdan to'xtab qolishi aniqlandi. Jarayon `env -i` bilan toza muhitda qayta ishga tushirilib, `pm2 save` qilindi (yangi PM2 id — 18).
- **Tekshirildi:** haqiqiy admin login orqali `https://tolovqil.duckdns.org/admin/clients/1` 200 qaytardi, mijoz ma'lumotlari to'g'ri chiqdi.
- **Keyingi qadam:** yo'q, masala yopildi.
