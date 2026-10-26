const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');
const BASE = 'https://dawalekh.netlify.app';
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const indexable = ['index.html', 'pricing.html', 'about.html', 'contact.html', 'signup.html', 'privacy.html', 'terms.html', 'refund.html', 'shipping.html',
  'blog/index.html', 'blog/medical-store-expiry-dawai-kaise-track-karein.html', 'blog/pharmacy-stock-register-vs-app.html', 'blog/medical-store-kholne-ke-liye-licence-checklist.html'];

test('indexable pages have unique titles, descriptions, canonical, OG and Twitter tags', () => {
  const titles = new Set(); const descs = new Set();
  for (const f of indexable) {
    const h = read(f);
    const t = h.match(/<title>([^<]+)<\/title>/)[1]; const d = h.match(/<meta name="description" content="([^"]+)"/)[1];
    assert.ok(!titles.has(t), `duplicate title ${f}`); titles.add(t);
    assert.ok(!descs.has(d), `duplicate description ${f}`); descs.add(d);
    assert.ok(d.length >= 70 && d.length <= 200, `${f} description length ${d.length}`);
    assert.match(h, new RegExp(`<link rel="canonical" href="${BASE}/`), `${f} canonical`);
    for (const m of ['og:title', 'og:description', 'og:url', 'og:image', 'twitter:card']) assert.ok(h.includes(m), `${f} ${m}`);
    assert.equal((h.match(/<h1[\s>]/g) || []).length, 1, `${f} exactly one h1`);
  }
});

test('private pages are noindex', () => {
  for (const f of ['app.html', 'forgot.html', 'reset.html', '404.html', 'login.html']) assert.match(read(f), /name="robots" content="noindex/, f);
});

test('home JSON-LD is valid and honest (no ratings/reviews)', () => {
  const h = read('index.html');
  const raw = h.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  const ld = JSON.parse(raw);
  const types = ld.map((x) => x['@type']);
  for (const t of ['Organization', 'SoftwareApplication', 'FAQPage', 'WebSite']) assert.ok(types.includes(t), t);
  assert.doesNotMatch(raw, /aggregateRating|"review"/i);
  const app = ld.find((x) => x['@type'] === 'SoftwareApplication');
  assert.deepEqual(app.offers.map((o) => o.price), ['0', '149', '1499']);
});

test('sitemap lists every indexable page and robots points to it', () => {
  const sm = read('sitemap.xml');
  for (const f of indexable) {
    const u = f === 'index.html' ? '/' : '/' + f.replace(/index\.html$/, '').replace(/\.html$/, '');
    assert.ok(sm.includes(`<loc>${BASE}${u}</loc>`), `sitemap missing ${u}`);
    const p = path.join(PUB, f); assert.ok(fs.existsSync(p), `file ${f}`);
  }
  const brand = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brand.json'), 'utf8'));
  if (brand.indexing) assert.match(read('robots.txt'), /Sitemap: /); else assert.doesNotMatch(read('robots.txt'), /Sitemap: /);
  assert.ok(fs.existsSync(path.join(PUB, 'googlec9735b214ab7d95c.html')), 'Search Console verification file must stay');
});

test('blog articles are substantial and link to signup', () => {
  for (const f of indexable.filter((x) => x.startsWith('blog/') && !x.endsWith('index.html'))) {
    const h = read(f); const words = h.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words > 600, `${f} only ${words} words`);
    assert.ok(h.includes('href="/signup"'), `${f} signup link`);
    assert.match(h, /"@type":\s*"Article"/, `${f} Article schema`);
  }
});

test('while brand.indexing is false, every page is noindex (old name stays out of Google)', () => {
  const brand = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brand.json'), 'utf8'));
  if (brand.indexing) return;
  for (const f of indexable) assert.match(read(f), /<meta name="robots" content="noindex">/, f);
  assert.match(read('_headers'), /X-Robots-Tag: noindex/);
});
