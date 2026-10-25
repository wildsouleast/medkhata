// Dawalekh signup and login.
(function () {
  function post(url, data) {
    return (window.mkWarm || Promise.resolve()).then(function () { return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); }); });
  }
  function busy(btn, on, label) { btn.disabled = on; btn.textContent = on ? 'Please wait…' : label; }
  var slow;
  function startSlowNote(errBox) {
    slow = setTimeout(function () { errBox.className = 'alert alert-info'; errBox.textContent = 'Starting up the server, this can take up to a minute the first time. Please wait…'; errBox.hidden = false; }, 6000);
  }
  function stopSlowNote(errBox) { clearTimeout(slow); errBox.className = 'alert alert-error'; errBox.hidden = true; }

  // Already logged in? Go straight to the app.
  (window.mkWarm || Promise.resolve()).then(function () { return fetch('/api/session', { credentials: 'same-origin' }); }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { if (j && j.logged_in) location.replace('/app'); }).catch(function () {});

  var signup = document.getElementById('signup-form');
  if (signup) {
    signup.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('s-err');
      var btn = signup.querySelector('button[type=submit]');
      err.hidden = true;
      var data = {
        store_name: signup.store_name.value, owner_name: signup.owner_name.value, city: signup.city.value,
        phone: signup.phone.value, email: signup.email.value, password: signup.password.value,
        accept_terms: signup.accept_terms.checked,
      };
      busy(btn, true, 'Start free trial');
      startSlowNote(err);
      post('/api/signup', data).then(function (res) {
        stopSlowNote(err);
        if (res.ok) { location.href = '/app?welcome=1'; return; }
        err.textContent = (res.j && res.j.message) || 'Something went wrong. Please try again.';
        err.hidden = false;
        if (res.j && res.j.field && signup[res.j.field]) signup[res.j.field].focus();
        busy(btn, false, 'Start free trial');
      }).catch(function () {
        stopSlowNote(err);
        err.textContent = 'Network problem. Please check your internet and try again.'; err.hidden = false;
        busy(btn, false, 'Start free trial');
      });
    });
  }

  var login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('l-err');
      var btn = login.querySelector('button[type=submit]');
      err.hidden = true;
      busy(btn, true, 'Log in');
      startSlowNote(err);
      post('/api/login', { login: login.login.value, password: login.password.value }).then(function (res) {
        stopSlowNote(err);
        if (res.ok) { location.href = '/app'; return; }
        err.textContent = (res.j && res.j.message) || 'Could not log in. Please try again.';
        err.hidden = false;
        busy(btn, false, 'Log in');
      }).catch(function () {
        stopSlowNote(err);
        err.textContent = 'Network problem. Please check your internet and try again.'; err.hidden = false;
        busy(btn, false, 'Log in');
      });
    });
  }
})();
