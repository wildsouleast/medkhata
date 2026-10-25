
// Wake the server early (the free server sleeps when idle and can take up to a minute to start).
window.mkWarm = (function () {
  var started = Date.now();
  function ping() {
    return fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.ok) return true;
      throw new Error('not ready');
    }).catch(function () {
      if (Date.now() - started > 120000) return false;
      return new Promise(function (res) { setTimeout(res, 3000); }).then(ping);
    });
  }
  return ping();
})();
// Dawalekh marketing pages: menu, business details, contact form.
(function () {
  var btn = document.querySelector('.menu-btn');
  var links = document.getElementById('nav-links');
  if (btn && links) {
    btn.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    links.addEventListener('click', function (e) { if (e.target.tagName === 'A') { links.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
  }
  document.querySelectorAll('[data-toggle-pw]').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = document.getElementById(b.getAttribute('data-toggle-pw'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
    });
  });

  function setAll(sel, fn) { document.querySelectorAll(sel).forEach(fn); }
  if (document.querySelector('[data-biz-name],[data-biz-email-line]')) {
    fetch('/api/config', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      if (!c || !c.business) return;
      var b = c.business;
      if (b.name) setAll('[data-biz-name]', function (el) { el.textContent = b.name; });
      if (b.email) {
        setAll('[data-biz-email]', function (el) { el.textContent = b.email; el.href = 'mailto:' + b.email; });
        setAll('[data-biz-email-line]', function (el) { el.hidden = false; });
      }
      if (b.phone) {
        setAll('[data-biz-phone]', function (el) { el.textContent = b.phone; });
        setAll('[data-biz-phone-line]', function (el) { el.hidden = false; });
      }
      if (b.address) {
        setAll('[data-biz-address]', function (el) { el.textContent = b.address; });
        setAll('[data-biz-address-line]', function (el) { el.hidden = false; });
      }
    }).catch(function () {});
  }

  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('c-err'), ok = document.getElementById('c-ok');
      var submit = form.querySelector('button[type=submit]');
      err.hidden = true; ok.hidden = true; submit.disabled = true; submit.textContent = 'Sending…';
      var data = { name: form.name.value, contact: form.contact.value, message: form.message.value };
      fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) { form.reset(); ok.hidden = false; }
          else { err.textContent = (res.j && res.j.message) || 'Could not send. Please try again.'; err.hidden = false; }
        })
        .catch(function () { err.textContent = 'Network problem. Please check your internet and try again.'; err.hidden = false; })
        .finally(function () { submit.disabled = false; submit.textContent = 'Send message'; });
    });
  }
})();
