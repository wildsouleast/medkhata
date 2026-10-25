// Usage: node scripts/rebrand.js "New Name" https://new-domain.com
// Replaces the brand name and site URL everywhere in public/ (HTML, JS, CSS, sitemap, robots) and lib/mailer defaults.
// The logo splits the name as Dawa<b>lekh</b>; that markup is replaced with the plain new name.
// Server-side texts read BUSINESS_NAME / PUBLIC_URL env vars on Render: set them too.
const fs = require('fs'); const path = require('path');
const [name, url] = process.argv.slice(2); if (!name || !url) { console.error('usage: rebrand.js "Name" https://domain'); process.exit(1); }
const ROOT = path.join(__dirname, '..'); const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'brand.json'), 'utf8'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = [...walk(path.join(ROOT, 'public')).filter((f) => /\.(html|js|css|xml|txt)$/.test(f)), path.join(ROOT, 'server.js'), path.join(ROOT, 'lib', 'mailer.js')];
const oldSplit = { MedKhata: 'Med<b>Khata</b>', Dawalekh: 'Dawa<b>lekh</b>' }[b.name] || null;
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8'); const o = s;
  if (oldSplit) s = s.split(oldSplit).join(name);
  s = s.split(b.site_url).join(url.replace(/\/$/, '')).split(b.name).join(name);
  if (s !== o) { fs.writeFileSync(f, s); console.log('updated', path.relative(ROOT, f)); }
}
b.name = name; b.site_url = url.replace(/\/$/, ''); fs.writeFileSync(path.join(ROOT, 'brand.json'), JSON.stringify(b, null, 2) + '\n');
