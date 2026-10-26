#!/bin/sh
# Builds /tmp/dawalekh-tabbot: public/ (minus Netlify-only _redirects) + _worker.js + tab-site.json
set -e
cd "$(dirname "$0")/../.."
OUT=${1:-/tmp/dawalekh-tabbot}
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r public/. "$OUT"/
rm -f "$OUT/_redirects"
cp deploy/tabbot-worker/_worker.js "$OUT/_worker.js"
printf '{"kind":"worker","entry":"_worker.js","worker":{"not_found_handling":"404-page","html_handling":"auto-trailing-slash"}}\n' > "$OUT/tab-site.json"
echo "$OUT"
