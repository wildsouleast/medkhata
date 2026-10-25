const crypto = require('crypto');

function config() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  return {
    keyId, keySecret, webhookSecret,
    enabled: Boolean(keyId && keySecret),
    testMode: keyId.startsWith('rzp_test_'),
    liveMode: keyId.startsWith('rzp_live_'),
  };
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyPaymentSignature(orderId, paymentId, signature, keySecret) {
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// Webhook signature: HMAC_SHA256(raw request body, webhook_secret)
function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

async function createOrder({ amountPaise, receipt, notes }) {
  const c = config();
  const auth = Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.error && body.error.description) || `Razorpay answered ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

module.exports = { config, verifyPaymentSignature, verifyWebhookSignature, createOrder };
