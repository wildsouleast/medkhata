// Confirm an email address from the link in the welcome email.
(function () {
  var msg = document.getElementById('v-msg');
  var token = new URLSearchParams(location.search).get('token') || '';
  if (token) history.replaceState(null, '', '/verify-email');
  if (!token) { msg.textContent = 'This link is incomplete. Please open the full link from the email.'; return; }
  (window.mkWarm || Promise.resolve()).then(function () {
    return fetch('/api/email/verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) });
  }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { msg.textContent = (j && j.message) || (r.ok ? 'Email confirmed.' : 'Something went wrong. Please try again.'); msg.className = r.ok ? 'alert alert-ok' : 'alert alert-error'; }); })
    .catch(function () { msg.textContent = 'Network problem. Please check your internet and open the link again.'; });
})();
