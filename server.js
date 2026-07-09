// server.js — بک‌اند AJM
// نسخه بدون وابستگی به سرویس هوش مصنوعی خارجی.
// موتور چت از pricing-assistant.js (کاملاً محلی و قانون‌محور) استفاده می‌کنه.

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { answer } = require('./pricing-assistant');
const { sendCode, verifyCode, getPhoneFromToken } = require('./auth');


const app = express();
const PORT = process.env.PORT || 3000;

// ---------- امنیت پایه ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(express.json({ limit: '50kb' })); // جلوگیری از ارسال بدنه‌های حجیم مخرب

// محدودیت نرخ درخواست کلی (ضدـ اسپم/DoS ساده)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقیقه
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.' }
});
app.use(generalLimiter);

function saveListing(newListing) {
  const filePath = path.join(__dirname, 'data', 'listings.json');
  const listings = loadListings();
  const nextId = listings.length ? Math.max(...listings.map(l => l.id)) + 1 : 1;
  const record = { id: nextId, ...newListing };
  listings.push(record);
  fs.writeFileSync(filePath, JSON.stringify(listings, null, 2), 'utf-8');
  return record;
}

function saveSupportTicket(ticket) {
  const filePath = path.join(__dirname, 'data', 'support-tickets.json');
  let tickets = [];
  try {
    tickets = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) { /* فایل هنوز وجود نداره، مشکلی نیست */ }
  tickets.push({ ...ticket, id: tickets.length + 1, date: new Date().toISOString() });
  fs.writeFileSync(filePath, JSON.stringify(tickets, null, 2), 'utf-8');
}

// محدودیت نرخ برای ارسال کد (ضدـ سواستفاده)
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تعداد درخواست کد بیش از حد مجاز است.' }
});

// ---------- احراز هویت ----------
app.post('/api/auth/send-code', otpLimiter, (req, res) => {
  const { phone } = req.body || {};
  const result = sendCode(phone || '');
  if (!result.ok) return res.status(400).json({ error: result.error });
  // هشدار: demoCode فقط برای تست توسعه‌ست. در نسخه نهایی باید حذف بشه
  // و کد فقط از طریق پیامک واقعی (سرویس کاوه‌نگار یا مشابه) فرستاده بشه.
  res.json({ success: true, demoCode: result.demoCode });
});

app.post('/api/auth/verify-code', (req, res) => {
  const { phone, code } = req.body || {};
  const result = verifyCode(phone || '', code || '');
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true, token: result.token });
});

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const phone = token ? getPhoneFromToken(token) : null;
  if (!phone) {
    return res.status(401).json({ error: 'ابتدا شماره موبایلت رو تایید کن.' });
  }
  req.phone = phone;
  next();
}

// ---------- پشتیبانی ----------
app.post('/api/support', (req, res) => {
  try {
    const { name, phone, message } = req.body || {};
    if (!sanitizeText(message, 5)) {
      return res.status(400).json({ error: 'پیام نمی‌تواند خالی باشد.' });
    }
    saveSupportTicket({
      name: sanitizeText(name, 100),
      phone: sanitizeText(phone, 20),
      message: sanitizeText(message, 1000)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'خطا در ثبت پیام.' });
  }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 دقیقه
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'خیلی سریع پیام می‌فرستی؛ کمی صبر کن.' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- داده آگهی‌ها ----------
function loadListings() {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'listings.json'), 'utf-8');
  return JSON.parse(raw);
}

// ---------- اعتبارسنجی ورودی ساده (بدون کتابخانه اضافه) ----------
function sanitizeText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

// ---------- موتور قیمت‌گذاری (فرمول وزنی، بدون نیاز به AI) ----------
function estimatePrice({ model, year, mileage, trustScore }) {
  const listings = loadListings();
  const similar = listings.filter(l =>
    l.model.trim() === String(model).trim()
  );

  let basePrice;
  if (similar.length > 0) {
    basePrice = similar.reduce((sum, l) => sum + l.price, 0) / similar.length;
  } else {
    // اگر مدل مشابهی نبود، از میانگین کل بازار به‌عنوان تخمین خام استفاده می‌کنیم
    basePrice = listings.reduce((sum, l) => sum + l.price, 0) / listings.length;
  }

  // تعدیل بر اساس کارکرد: هر 10,000 کیلومتر کمتر از میانگین بازار = 1.5٪ افزایش ارزش
  const avgMileage = listings.reduce((s, l) => s + l.mileage, 0) / listings.length;
  const mileageDiff = avgMileage - Number(mileage || avgMileage);
  const mileageAdjustment = (mileageDiff / 10000) * 0.015;

  // تعدیل بر اساس Trust Score: هر 10 امتیاز بالاتر از 70 = 1٪ افزایش ارزش منصفانه
  const ts = Number(trustScore || 70);
  const trustAdjustment = ((ts - 70) / 10) * 0.01;

  const finalPrice = basePrice * (1 + mileageAdjustment + trustAdjustment);

  return {
    estimated: Math.round(finalPrice / 1000000) * 1000000,
    basedOnSamples: similar.length,
    label: finalPrice > basePrice * 1.05 ? 'به‌صرفه' : finalPrice < basePrice * 0.95 ? 'کمی بالاتر از بازار' : 'قیمت منصفانه'
  };
}

// ---------- مسیرها (Routes) ----------

app.get('/api/listings', (req, res) => {
  try {
    const listings = loadListings();
    const { maxPrice, city, model } = req.query;
    let result = listings;

    if (maxPrice) result = result.filter(l => l.price <= Number(maxPrice));
    if (city) result = result.filter(l => l.city.includes(sanitizeText(city, 50)));
    if (model) result = result.filter(l => l.model.includes(sanitizeText(model, 50)));

    res.json({ count: result.length, listings: result });
  } catch (err) {
    res.status(500).json({ error: 'خطا در بارگذاری آگهی‌ها' });
  }
});

app.post('/api/listings', requireAuth, (req, res) => {
  try {
    const { model, year, mileage, city, price, desc, sellerName } = req.body || {};
    if (!model || !year || !mileage || !city || !price) {
      return res.status(400).json({ error: 'مدل، سال، کارکرد، شهر، و قیمت الزامی است.' });
    }
    const record = saveListing({
      model: sanitizeText(model, 100),
      year: Number(year),
      mileage: Number(mileage),
      city: sanitizeText(city, 50),
      price: Number(price),
      trustScore: 50, // امتیاز اولیه پیش‌فرض برای آگهی‌های تازه، تا زمانی که بررسی بشه
      bodyType: '',
      accident: false,
      desc: sanitizeText(desc, 500),
      sellerName: sanitizeText(sellerName, 100),
      sellerPhone: req.phone
    });
    res.json({ success: true, listing: record });
  } catch (err) {
    res.status(500).json({ error: 'خطا در ثبت آگهی.' });
  }
});

app.post('/api/price-estimate', (req, res) => {
  try {
    const { model, year, mileage, trustScore } = req.body || {};
    if (!model || !year || !mileage) {
      return res.status(400).json({ error: 'مدل، سال، و کارکرد الزامی است.' });
    }
    const result = estimatePrice({
      model: sanitizeText(model, 100),
      year: Number(year),
      mileage: Number(mileage),
      trustScore: Number(trustScore)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'خطا در محاسبه قیمت' });
  }
});

// ---------- چت هوشمند محلی (بدون هیچ سرویس خارجی) ----------
app.post('/api/chat', chatLimiter, (req, res) => {
  const userMessage = sanitizeText(req.body?.message, 800);
  if (!userMessage) {
    return res.status(400).json({ error: 'پیام خالی است.' });
  }

  try {
    const replyText = answer(userMessage);
    res.json({ reply: replyText });
  } catch (err) {
    console.error('Chat handler error:', err.message);
    res.status(500).json({ error: 'خطای داخلی سرور.' });
  }
});

// ---------- health check ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'local-rule-based', aiConfigured: true });
});

app.listen(PORT, () => {
  console.log(`AJM server running on http://127.0.0.1:${PORT}`);
});
