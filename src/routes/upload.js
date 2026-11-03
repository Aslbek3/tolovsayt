const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { token } = require('../utils');

const dir = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(dir, { recursive: true });

const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

module.exports = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => cb(null, Date.now() + '_' + token(6) + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = allowed.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Faqat rasm (jpg, png, webp) yoki PDF yuklash mumkin'), ok);
  },
});
