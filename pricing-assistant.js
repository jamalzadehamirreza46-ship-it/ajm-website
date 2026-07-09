// pricing-assistant.js
// یک موتور "هوشمند" کاملاً قانون‌محور (Rule-Based) برای قیمت‌گذاری خودرو
// هیچ اتصالی به سرویس هوش مصنوعی خارجی (Anthropic/OpenAI/...) ندارد.
// همه‌چیز محلی، روی داده‌های خودِ AJM اجرا می‌شود — بدون هزینه، بدون وابستگی به تحریم.

const fs = require('fs');
const path = require('path');

function loadListings() {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'listings.json'), 'utf-8');
  return JSON.parse(raw);
}

// ---------- تبدیل اعداد فارسی/عربی به لاتین ----------
function normalizeDigits(str) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  return str.replace(/[۰-۹٠-٩]/g, (ch) => {
    let idx = persian.indexOf(ch);
    if (idx === -1) idx = arabic.indexOf(ch);
    return idx !== -1 ? String(idx) : ch;
  });
}

// ---------- استخراج عدد کارکرد (کیلومتر) ----------
function extractMileage(text) {
  // الگوهایی مثل: "42000 کیلومتر"، "کارکرد 45 هزار"، "با 30هزار کیلومتر کارکرد"
  const t = normalizeDigits(text);

  let m = t.match(/(\d[\d,]*)\s*هزار\s*(?:کیلومتر|کارکرد)?/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10) * 1000;

  m = t.match(/(\d[\d,]*)\s*کیلومتر/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  m = t.match(/کارکرد\D{0,5}(\d[\d,]*)/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  return null;
}

// ---------- استخراج سال ----------
function extractYear(text) {
  const t = normalizeDigits(text);
  // سال شمسی ۴ رقمی بین 1380 تا 1410، یا دو رقمی بعد از "مدل"
  let m = t.match(/\b(13[8-9]\d|14[0-1]\d)\b/);
  if (m) return parseInt(m[1], 10);

  m = t.match(/مدل\D{0,3}(\d{2})\b/);
  if (m) {
    const yy = parseInt(m[1], 10);
    return yy < 50 ? 1400 + yy : 1300 + yy; // حدس منطقی برای سال دو رقمی
  }
  return null;
}

// ---------- تشخیص شهر ----------
function extractCity(text, knownCities) {
  return knownCities.find(city => text.includes(city)) || null;
}

// ---------- تشخیص مدل خودرو (تطبیق فازی ساده) ----------
function extractModel(text, listings) {
  const models = [...new Set(listings.map(l => l.model))];
  // اول تطبیق کامل
  let found = models.find(m => text.includes(m));
  if (found) return found;

  // بعد تطبیق بخشی از کلمات مدل (مثلاً "207" یا "سمند" به‌تنهایی)
  for (const model of models) {
    const parts = model.split(' ');
    if (parts.some(p => p.length > 2 && text.includes(p))) {
      return model;
    }
  }
  return null;
}

// ---------- تشخیص قصد کاربر (Intent) ----------
function detectIntent(text) {
  if (/قیمت|ارزش|چند(؟| |$)|میلیون|تومان/.test(text)) return 'price';
  if (/زیر|کمتر از|ارزان|بودجه/.test(text)) return 'budget_search';
  if (/اعتماد|trust|امتیاز/.test(text)) return 'trust_info';
  if (/سلام|درود|وقت بخیر/.test(text)) return 'greeting';
  return 'unknown';
}

// ---------- موتور قیمت‌گذاری اصلی (همون فرمول قبلی) ----------
function estimatePrice({ model, mileage, trustScore }, listings) {
  const similar = listings.filter(l => l.model.trim() === String(model).trim());

  let basePrice;
  if (similar.length > 0) {
    basePrice = similar.reduce((sum, l) => sum + l.price, 0) / similar.length;
  } else {
    basePrice = listings.reduce((sum, l) => sum + l.price, 0) / listings.length;
  }

  const avgMileage = listings.reduce((s, l) => s + l.mileage, 0) / listings.length;
  const mileageDiff = avgMileage - Number(mileage || avgMileage);
  const mileageAdjustment = (mileageDiff / 10000) * 0.015;

  const ts = Number(trustScore || 70);
  const trustAdjustment = ((ts - 70) / 10) * 0.01;

  const finalPrice = basePrice * (1 + mileageAdjustment + trustAdjustment);

  return {
    estimated: Math.round(finalPrice / 1000000) * 1000000,
    basedOnSamples: similar.length,
    label: finalPrice > basePrice * 1.05 ? 'به‌صرفه'
         : finalPrice < basePrice * 0.95 ? 'کمی بالاتر از بازار'
         : 'قیمت منصفانه'
  };
}

function formatToman(num) {
  return (num / 1000000).toLocaleString('fa-IR') + ' میلیون تومان';
}

// ---------- تابع اصلی: گرفتن جمله فارسی، برگردوندن پاسخ ----------
function answer(userText) {
  const listings = loadListings();
  const knownCities = [...new Set(listings.map(l => l.city))];
  const text = userText.trim();
  const intent = detectIntent(text);

  if (intent === 'greeting') {
    return 'سلام! من دستیار قیمت‌گذاری AJM هستم. اسم مدل ماشین، سال، و کارکردش رو بگو تا قیمت منصفانه رو بهت بگم.';
  }

  if (intent === 'trust_info') {
    return 'امتیاز اعتماد (از ۱۰۰) بر اساس سابقه تصادف، مطابقت کارکرد با اسناد، و احراز هویت فروشنده محاسبه می‌شه. هرچی بالاتر باشه، ریسک معامله کمتره.';
  }

  const model = extractModel(text, listings);
  const year = extractYear(text);
  const mileage = extractMileage(text);
  const city = extractCity(text, knownCities);

  if (intent === 'budget_search') {
    const t = normalizeDigits(text);
    const budgetMatch = t.match(/(\d[\d,]*)\s*میلیارد/);
    let maxPrice = null;
    if (budgetMatch) maxPrice = parseFloat(budgetMatch[1].replace(/,/g, '')) * 1000000000;

    let results = listings;
    if (maxPrice) results = results.filter(l => l.price <= maxPrice);
    if (city) results = results.filter(l => l.city === city);

    if (results.length === 0) {
      return 'با این شرایط آگهی‌ای پیدا نکردم. می‌تونی بودجه یا شهر رو تغییر بدی؟';
    }
    const lines = results.slice(0, 4).map(l =>
      `• ${l.model} (${l.year}) — ${formatToman(l.price)} — ${l.city} — اعتماد ${l.trustScore}`
    );
    return `${results.length} آگهی پیدا شد:\n${lines.join('\n')}`;
  }

  // پیش‌فرض: قصد قیمت‌گذاری
  if (!model) {
    return 'اسم مدل ماشین رو دقیق‌تر بگو (مثلاً «پژو 207» یا «BMW 520i») تا بتونم قیمتش رو بررسی کنم.';
  }

  // اگه کارکرد یا سال داده نشده، از میانگین بازار همون مدل استفاده می‌کنیم
  const sameModel = listings.filter(l => l.model === model);
  const assumedMileage = mileage || (sameModel.length ? sameModel[0].mileage : 60000);
  const assumedTrust = sameModel.length ? sameModel[0].trustScore : 70;

  const result = estimatePrice({ model, mileage: assumedMileage, trustScore: assumedTrust }, listings);

  let reply = `برای ${model}`;
  if (year) reply += ` مدل ${year}`;
  reply += `:\nقیمت تخمینی: ${formatToman(result.estimated)}\nوضعیت: ${result.label}`;
  if (result.basedOnSamples > 0) {
    reply += `\n(بر اساس ${result.basedOnSamples} آگهی مشابه در پایگاه داده)`;
  } else {
    reply += `\n(مدل دقیقاً مشابهی توی آگهی‌های فعلی نبود؛ این تخمین بر اساس میانگین کل بازاره)`;
  }

  return reply;
}

module.exports = { answer, estimatePrice, extractModel, extractYear, extractMileage, extractCity, detectIntent };
