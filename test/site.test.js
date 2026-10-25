const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));

test('all required pages exist', () => {
  for (const p of ['index.html', 'pricing.html', 'signup.html', 'login.html', 'app.html', 'contact.html', 'about.html', 'privacy.html', 'terms.html', 'refund.html', 'shipping.html', '404.html']) {
    assert.ok(pages.includes(p), `missing ${p}`);
  }
});

test('every page has viewport, title and no placeholders', () => {
  for (const p of pages) {
    const html = fs.readFileSync(path.join(PUB, p), 'utf8');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/, `${p} viewport`);
    assert.match(html, /<title>[^<]{5,}<\/title>/, `${p} title`);
    assert.doesNotMatch(html, /lorem ipsum|TODO|FIXME|\{\{|DEMO website|sample prices/i, `${p} placeholder`);
  }
});

test('local asset references resolve', () => {
  for (const p of pages) {
    const html = fs.readFileSync(path.join(PUB, p), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]);
    for (const r of refs) {
      if (r === '/' || r.startsWith('/api/')) continue;
      const f = path.join(PUB, r);
      const ok = fs.existsSync(f) || fs.existsSync(f + '.html');
      assert.ok(ok, `${p} -> ${r} not found`);
    }
  }
});

test('home page carries the core content', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const s of ['MedKhata', '2-day free trial', '₹299', '₹599', '₹999', 'Expiry alerts at 30, 60 and 90 days', 'Register vs Excel vs MedKhata', 'Privacy Policy', 'Terms of Service', 'Refund &amp; Cancellation', 'Contact us']) {
    assert.ok(html.includes(s), `index missing ${s}`);
  }
});
