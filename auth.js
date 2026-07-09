const fs = require('fs');
const path = require('path');

// ---------- حافظه موقت کد و توکن (برای نسخه فعلی، بدون دیتابیس) ----------
const otpStore = new Map();      // phone -> { code, expires }
const sessionTokens = new Map(); // token -> phone

function normalizeDigits(str) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return String(str).replace(/[۰-۹]/g, ch => String(persian.indexOf(ch)));
}

function isValidIranPhone(phone) {
  const p = normalizeDigits(phone).replace(/\s/g, '');
  return /^09\d{9}$/.test(p);
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function generateToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

function sendCode(phoneRaw) {
  const phone = normalizeDigits(phoneRaw).replace(/\s/g, '');
  if (!isValidIranPhone(phone)) {
    return { ok: false, error: 'شماره موبایل معتبر نیست.' };
  }
  const code = generateCode();
  otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });
  // نکته: در نسخه واقعی، اینجا باید به یک سرویس پیامکی (کاوه‌نگار و مشابه) وصل بشه.
  // فعلاً کد را مستقیم برمی‌گردونیم تا بشه تست کرد (فقط برای توسعه، نه نسخه نهایی).
  return { ok: true, demoCode: code };
}

function verifyCode(phoneRaw, codeRaw) {
  const phone = normalizeDigits(phoneRaw).replace(/\s/g, '');
  const code = normalizeDigits(codeRaw).trim();
  const record = otpStore.get(phone);

  if (!record) return { ok: false, error: 'ابتدا درخواست کد بده.' };
  if (Date.now() > record.expires) {
    otpStore.delete(phone);
    return { ok: false, error: 'کد منقضی شده؛ دوباره درخواست بده.' };
  }
  if (record.code !== code) return { ok: false, error: 'کد اشتباه است.' };

  otpStore.delete(phone);
  const token = generateToken();
  sessionTokens.set(token, phone);
  return { ok: true, token };
}

function getPhoneFromToken(token) {
  return sessionTokens.get(token) || null;
}

module.exports = { sendCode, verifyCode, getPhoneFromToken, isValidIranPhone };
