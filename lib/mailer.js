// Transactional email over HTTPS APIs (Render's free plan blocks SMTP ports 25/465/587).
// Configure ONE provider with environment variables on Render (never in code):
//   Brevo:   BREVO_API_KEY
//   Resend:  RESEND_API_KEY               (needs a verified domain to email anyone but the account owner)
//   Mailjet: MAILJET_API_KEY + MAILJET_SECRET_KEY
// plus MAIL_FROM_EMAIL (a sender address the provider has verified) and optional MAIL_FROM_NAME.
// With nothing set, enabled() is false and the app falls back to the manual WhatsApp reset path.
const BRAND = () => process.env.BRAND_NAME || 'Dawalekh';

function provider() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY) return 'mailjet';
  return null;
}
function enabled() { return Boolean(provider() && process.env.MAIL_FROM_EMAIL); }

async function send({ to, subject, text, html }) {
  const p = provider();
  if (!p || !process.env.MAIL_FROM_EMAIL) return { ok: false, skipped: true };
  const fromEmail = process.env.MAIL_FROM_EMAIL;
  const fromName = process.env.MAIL_FROM_NAME || BRAND();
  let url; let headers = { 'Content-Type': 'application/json' }; let body;
  if (p === 'brevo') {
    url = 'https://api.brevo.com/v3/smtp/email';
    headers['api-key'] = process.env.BREVO_API_KEY;
    body = { sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject, textContent: text, htmlContent: html };
  } else if (p === 'resend') {
    url = 'https://api.resend.com/emails';
    headers.Authorization = `Bearer ${process.env.RESEND_API_KEY}`;
    body = { from: `${fromName} <${fromEmail}>`, to: [to], subject, text, html };
  } else {
    url = 'https://api.mailjet.com/v3.1/send';
    headers.Authorization = 'Basic ' + Buffer.from(`${process.env.MAILJET_API_KEY}:${process.env.MAILJET_SECRET_KEY}`).toString('base64');
    body = { Messages: [{ From: { Email: fromEmail, Name: fromName }, To: [{ Email: to }], Subject: subject, TextPart: text, HTMLPart: html }] };
  }
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const t = await r.text();
    if (!r.ok) { console.error(`[mail] ${p} ${r.status} ${t.slice(0, 300)}`); return { ok: false, status: r.status }; }
    return { ok: true, provider: p };
  } catch (e) {
    console.error(`[mail] ${p} error ${e.message}`); return { ok: false, error: e.message };
  } finally { clearTimeout(timer); }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function layout(title, paras, button) {
  const b = BRAND();
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:14px;padding:24px;border:1px solid #e2e8f0">
<div style="font-weight:800;font-size:20px;color:#0f766e;margin-bottom:12px">${esc(b)}</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${paras.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px;color:#334155">${esc(p)}</p>`).join('')}
${button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">${esc(button.label)}</a></p><p style="font-size:12px;color:#64748b;word-break:break-all">If the button does not work, open this link: ${esc(button.url)}</p>` : ''}
</div><p style="font-size:12px;color:#64748b;text-align:center;margin-top:12px">You get this email because this address was used to create a ${esc(b)} account. If that was not you, ignore this email.</p></div></body></html>`;
  const text = [b, '', title, '', ...paras, '', button ? `${button.label}: ${button.url}` : ''].join('\n');
  return { html, text };
}

function welcomeVerify({ store, link }) {
  const { html, text } = layout(`Welcome to ${BRAND()}, ${store}!`, [
    'Your account is ready and your 7-day free trial has started. Add your medicines to see expiry and low-stock alerts.',
    'Please confirm this email address. We use it only for important account emails, such as password reset links.',
  ], { label: 'Confirm my email', url: link });
  return { subject: `Welcome to ${BRAND()}: please confirm your email`, html, text };
}
function verifyOnly({ link }) {
  const { html, text } = layout('Confirm your email', ['Tap the button to confirm this email address for your account. The link works for 48 hours.'], { label: 'Confirm my email', url: link });
  return { subject: `Confirm your email for ${BRAND()}`, html, text };
}
function resetMail({ link }) {
  const { html, text } = layout('Reset your password', ['Someone (hopefully you) asked to reset the password for your account. The link works for 1 hour and only once.', 'If you did not ask for this, ignore this email; your password stays the same.'], { label: 'Set a new password', url: link });
  return { subject: `Reset your ${BRAND()} password`, html, text };
}

module.exports = { enabled, provider, send, welcomeVerify, verifyOnly, resetMail };
