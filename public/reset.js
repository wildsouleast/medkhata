// Dawalekh: forgot-password request and reset with a one-time link.
(function () {
  function post(url, data) {
    return (window.mkWarm || Promise.resolve()).then(function () {
      return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); });
    });
  }
  var forgot = document.getElementById('forgot-form');
  if (forgot) {
    forgot.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('f-err'), ok = document.getElementById('f-ok'), btn = forgot.querySelector('button[type=submit]');
      err.hidden = true; ok.hidden = true; btn.disabled = true; btn.textContent = 'Please wait…';
      post('/api/password/forgot', { login: forgot.login.value }).then(function (res) {
        if (res.ok) { ok.textContent = res.j.message; ok.hidden = false; forgot.login.value = ''; }
        else { err.textContent = (res.j && res.j.message) || 'Something went wrong. Please try again.'; err.hidden = false; }
      }).catch(function () { err.textContent = 'Network problem. Please check your internet and try again.'; err.hidden = false; })
        .finally(function () { btn.disabled = false; btn.textContent = 'Request reset link'; });
    });
  }
  var reset = document.getElementById('reset-form');
  if (reset) {
    var token = new URLSearchParams(location.search).get('token') || '';
    if (token) history.replaceState(null, '', '/reset');
    reset.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('r-err'), btn = reset.querySelector('button[type=submit]');
      err.hidden = true;
      if (!token) { err.textContent = 'This reset link is incomplete. Please open the full link you received.'; err.hidden = false; return; }
      if (reset.password.value.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Please wait…';
      post('/api/password/reset', { token: token, password: reset.password.value }).then(function (res) {
        if (res.ok) { location.href = '/app'; return; }
        err.textContent = (res.j && res.j.message) || 'Something went wrong. Please try again.'; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Save new password';
      }).catch(function () { err.textContent = 'Network problem. Please check your internet and try again.'; err.hidden = false; btn.disabled = false; btn.textContent = 'Save new password'; });
    });
  }
})();
