const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, n, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
    return crypto.timingSafeEqual(expected, got);
  } catch (e) {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Indian mobile: 10 digits starting 6-9, optional +91 / 0 prefix.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

function normalizeEmail(input) {
  const e = String(input || '').trim().toLowerCase();
  if (!e) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

// Very small in-memory rate limiter (per key, sliding window).
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return list.length > max;
}

// Check without counting this attempt.
function isLimited(key, max, windowMs) {
  const now = Date.now();
  return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= max;
}
function clearLimit(key) { hits.delete(key); }

module.exports = { isLimited, clearLimit, hashPassword, verifyPassword, newToken, tokenHash, normalizePhone, normalizeEmail, rateLimited };
