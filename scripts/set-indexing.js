// Usage: node scripts/set-indexing.js on|off
// off = every page gets <meta name="robots" content="noindex"> + an X-Robots-Tag header (keeps the old name out of Google).
// on  = public pages go back to index,follow (app/login/forgot/reset/verify/404 stay noindex).
const fs = require('fs'); const path = require('path');
const mode = process.argv[2]; if (!['on', 'off'].includes(mode)) { console.error('usage: on|off'); process.exit(1); }
const ROOT = path.join(__dirname, '..'); const PUB = path.join(ROOT, 'public');
const PRIVATE = new Set(['app.html', 'login.html', 'forgot.html', 'reset.html', 'verify-email.html', '404.html']);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(PUB).filter((x) => x.endsWith('.html') && !/google[0-9a-f]+\.html$/.test(x))) {
  const rel = path.relative(PUB, f); let h = fs.readFileSync(f, 'utf8');
  const want = mode === 'on' && !PRIVATE.has(rel) ? 'index,follow,max-image-preview:large' : 'noindex';
  if (/<meta name="robots" content="[^"]*">/.test(h)) h = h.replace(/<meta name="robots" content="[^"]*">/, `<meta name="robots" content="${want}">`);
  else h = h.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="robots" content="${want}">`);
  fs.writeFileSync(f, h);
}
const hdr = path.join(PUB, '_headers');
if (mode === 'off') fs.writeFileSync(hdr, '/*\n  X-Robots-Tag: noindex\n'); else if (fs.existsSync(hdr)) fs.unlinkSync(hdr);
const robots = path.join(PUB, 'robots.txt'); const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'brand.json'), 'utf8'));
fs.writeFileSync(robots, 'User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\n' + (mode === 'on' ? `\nSitemap: ${b.site_url}/sitemap.xml\n` : ''));
b.indexing = mode === 'on'; fs.writeFileSync(path.join(ROOT, 'brand.json'), JSON.stringify(b, null, 2) + '\n');
console.log('indexing', mode);
