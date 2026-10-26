(function () {
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var code = (params.get('s') || params.get('store') || '').trim().toLowerCase();
  var store = null, photo = null;
  function fail() { $('o-loading').hidden = true; $('o-missing').hidden = false; }
  if (!/^[a-z0-9]{6,12}$/.test(code)) { fail(); return; }
  function load(tries) {
    return fetch('/api/public/store/' + encodeURIComponent(code)).then(function (r) {
      if (r.status === 404) { fail(); return null; }
      if (!r.ok) throw new Error('x');
      return r.json();
    }).catch(function () {
      if (tries > 0) { $('o-loading').textContent = 'Server jaag raha hai, thoda ruko… (30–50 sec)'; return new Promise(function (res) { setTimeout(res, 4000); }).then(function () { return load(tries - 1); }); }
      $('o-loading').textContent = 'Store load nahi hua. Internet check karke page refresh karein.'; return null;
    });
  }
  load(15).then(function (s) {
    if (!s) return;
    store = s;
    $('o-store').textContent = s.store_name;
    $('o-city').textContent = [s.store_address, s.city].filter(Boolean).join(', ');
    document.title = 'Dawai order — ' + s.store_name;
    $('o-loading').hidden = true; $('o-form').hidden = false;
  });
  $('o-how').addEventListener('change', function () { $('o-addr-f').hidden = this.value !== 'delivery'; });
  $('o-photo').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    photo = f;
    $('o-img').src = URL.createObjectURL(f); $('o-prev').hidden = false;
    var canShare = navigator.canShare && navigator.canShare({ files: [f] });
    $('o-share').hidden = !canShare;
  });
  $('o-rm').addEventListener('click', function () { photo = null; $('o-photo').value = ''; $('o-prev').hidden = true; $('o-share').hidden = true; $('o-photo-note').hidden = true; });
  function message() {
    var meds = $('o-meds').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    var lines = ['Namaste ' + store.store_name + ' 🙏', 'Mujhe ye dawai chahiye:'];
    if (meds.length) meds.forEach(function (m, i) { lines.push((i + 1) + '. ' + m); });
    if (photo) lines.push(meds.length ? '📷 Parchi ki photo bhi bhej raha/rahi hoon.' : '📷 Parchi ki photo bhej raha/rahi hoon — usme likhi dawai chahiye.');
    var name = $('o-name').value.trim();
    if (name) lines.push('Naam: ' + name);
    if ($('o-how').value === 'delivery') { lines.push('Ghar par delivery chahiye (agar ho sake).'); var a = $('o-addr').value.trim(); if (a) lines.push('Address: ' + a); }
    else lines.push('Main store se le jaunga/jaungi.');
    lines.push('Kripya price aur availability batayein. Dhanyavaad!');
    lines.push('— Dawalekh order link se');
    return { text: lines.join('\n'), meds: meds };
  }
  $('o-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = message(), err = $('o-err');
    if (!m.meds.length && !photo) { err.textContent = 'Dawai ka naam likhein ya parchi ki photo lagayein.'; err.hidden = false; return; }
    err.hidden = true;
    $('o-photo-note').hidden = !photo;
    window.location.href = 'https://wa.me/' + store.wa + '?text=' + encodeURIComponent(m.text);
  });
  $('o-share').addEventListener('click', function () {
    if (!photo) return;
    var m = message();
    navigator.share({ files: [photo], text: m.text }).catch(function () {});
  });
})();
