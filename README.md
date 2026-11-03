# Server to'lovlari tizimi

Telegram bot va veb saytlaringizni sotib olgan mijozlar oylik server to'lovini shu sayt orqali qiladi.

## Qanday ishlaydi

1. **Siz (admin)** `/admin` panelda mijoz qo'shasiz (ism, telefon, parol) va unga xizmatlarini (bot yoki sayt, oylik narx, to'langan muddat) biriktirasiz.
2. **Mijoz** saytga telefon + parol bilan kiradi, o'z bot/saytlarini va qolgan kunlarni ko'radi.
3. Mijoz **"To'lash"** ni bosadi → necha oy tanlaydi → kartangizga pul o'tkazadi → **chek rasmini yuklaydi**.
4. Chek **Telegramingizga** keladi, ostida **✅ Tasdiqlash / ❌ Rad etish** tugmalari bor (yoki admin panelda).
5. Tasdiqlasangiz muddat **avtomatik uzayadi**, to'xtagan bo'lsa bot **avtomatik yoqiladi**, mijozga Telegramda xabar boradi.
6. Har kuni soat **10:00** da tizim:
   - muddati yaqinlashganlarga eslatma yuboradi (standart: 5, 3, 1 kun oldin va tugagan kuni),
   - muddati o'tganlarga ogohlantirish yuboradi,
   - muddat o'tib **N kun** (standart 3) to'lanmasa — botni **avtomatik to'xtatadi** (siz yozgan buyruq bilan, masalan `pm2 stop shop_bot`).

Bot buyruqlari (admin chatda): `/qarzdorlar`, `/yaqin`.

---

## VPS ga o'rnatish (Ubuntu)

### 1. Node.js va pm2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential nginx
sudo npm install -g pm2
```

### 2. Loyihani joylash
Papkani serverga yuklang (masalan `scp` yoki WinSCP bilan) `/home/USER/obuna-tolov` ga, keyin:
```bash
cd ~/obuna-tolov
npm install
cp .env.example .env
nano .env      # qiymatlarni to'ldiring
```

### 3. Telegram bot
1. [@BotFather](https://t.me/BotFather) da yangi bot yarating (masalan `@myserver_pay_bot`), tokenni `.env` dagi `BOT_TOKEN` ga yozing.
2. Saytni ishga tushiring (4-qadam), botga `/start` yozing — bot sizga **chat ID** ni aytadi.
3. Shu raqamni `.env` dagi `ADMIN_CHAT_ID` ga yozib, `pm2 restart obuna` qiling.

### 4. Ishga tushirish
```bash
pm2 start src/app.js --name obuna
pm2 save
pm2 startup     # chiqqan buyruqni nusxalab bajaring (server qayta yonganda avto ishga tushadi)
```

### 5. Domen + HTTPS (nginx)
`/etc/nginx/sites-available/obuna`:
```nginx
server {
    server_name pay.sizningdomen.uz;
    client_max_body_size 10M;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/obuna /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pay.sizningdomen.uz
```
HTTPS ishlagach `.env` da `COOKIE_SECURE=true` qiling va `pm2 restart obuna`.

---

## Avto to'xtatish buyruqlari

Har bir xizmat sahifasida "To'xtatish" va "Yoqish" buyruqlarini yozasiz. Buyruq shu sayt ishlayotgan foydalanuvchi nomidan bajariladi.

| Xizmat qanday ishlaydi | To'xtatish | Yoqish |
|---|---|---|
| pm2 dagi bot | `pm2 stop shop_bot` | `pm2 start shop_bot` |
| systemd servis | `sudo systemctl stop shop_bot` | `sudo systemctl start shop_bot` |
| Docker | `docker stop shop_bot` | `docker start shop_bot` |
| Nginx sayt | `sudo rm /etc/nginx/sites-enabled/shop && sudo systemctl reload nginx` | `sudo ln -s /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/ && sudo systemctl reload nginx` |

`sudo` kerak bo'lsa, `sudo visudo` orqali faqat kerakli buyruqlarga parolsiz ruxsat bering, masalan:
```
USER ALL=(ALL) NOPASSWD: /bin/systemctl stop *, /bin/systemctl start *, /bin/systemctl reload nginx
```

Buyruq natijasi xizmat sahifasida "Oxirgi buyruq natijasi" bo'limida ko'rinadi. Xato bo'lsa Telegramga ham xabar keladi.

---

## Foydali
- Ma'lumotlar bazasi: `data/db.sqlite` — vaqti-vaqti bilan nusxasini oling (backup).
- Cheklar: `uploads/` papkasida (ochiq emas, faqat admin ko'ra oladi).
- Loglar: `pm2 logs obuna`
- Admin panel: `https://pay.sizningdomen.uz/admin`

### Keyinchalik Payme / Click qo'shish
Merchant hisob ochganingizdan so'ng `billing.approvePayment()` funksiyasini Payme/Click callback'idan chaqirish kifoya — qolgan hammasi (muddat uzaytirish, botni yoqish, xabar) tayyor.
