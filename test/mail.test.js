const test = require('node:test');
const assert = require('node:assert');
for (const k of ['BREVO_API_KEY', 'RESEND_API_KEY', 'MAILJET_API_KEY', 'MAILJET_SECRET_KEY', 'MAIL_FROM_EMAIL']) delete process.env[k];
const MAIL = require('../lib/mailer');

test('mailer is off without env vars and send() is a safe no-op', async () => {
  assert.equal(MAIL.enabled(), false);
  const r = await MAIL.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h' });
  assert.equal(r.skipped, true);
});

test('provider is picked from env and needs a sender', () => {
  process.env.BREVO_API_KEY = 'x'; assert.equal(MAIL.provider(), 'brevo'); assert.equal(MAIL.enabled(), false);
  process.env.MAIL_FROM_EMAIL = 'hello@example.com'; assert.equal(MAIL.enabled(), true);
  delete process.env.BREVO_API_KEY; delete process.env.MAIL_FROM_EMAIL;
});

test('templates carry the link, escape the store name and have text versions', () => {
  const w = MAIL.welcomeVerify({ store: '<Sharma> Medical', link: 'https://x.test/verify-email?token=abc' });
  assert.match(w.html, /verify-email\?token=abc/); assert.match(w.text, /verify-email\?token=abc/);
  assert.match(w.html, /&lt;Sharma&gt; Medical/); assert.doesNotMatch(w.html, /<Sharma>/);
  const r = MAIL.resetMail({ link: 'https://x.test/reset?token=zz' });
  assert.match(r.subject, /Reset/); assert.match(r.text, /reset\?token=zz/);
});
