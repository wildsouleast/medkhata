/* Dawalekh API base. On hosts that proxy /api (tab.bot worker, Render, Netlify) nothing changes.
   On the own-domain static copy (GitHub Pages: *.publicvm.com, *.github.io) every "/api/..." request goes
   straight to the backend with the session as a Bearer token kept in this browser (no third-party cookies). */
(function () {
  var h = location.hostname;
  var direct = /(^|\.)publicvm\.com$/.test(h) || /\.github\.io$/.test(h);
  window.DL_API = direct ? 'https://medkhata.onrender.com' : '';
  if (!direct || !window.fetch) return;
  var KEY = 'dl_token';
  var orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (typeof input !== 'string' || url.indexOf('/api') !== 0) return orig(input, init);
    init = Object.assign({}, init || {});
    var headers = new Headers(init.headers || {});
    var tok = null; try { tok = localStorage.getItem(KEY); } catch (e) {}
    if (tok) headers.set('Authorization', 'Bearer ' + tok);
    var path = url.split('?')[0];
    var isAuth = path === '/api/login' || path === '/api/signup';
    if (isAuth) headers.set('X-Token-Auth', '1');
    init.headers = headers;
    init.credentials = 'omit';
    init.mode = 'cors';
    return orig(window.DL_API + url, init).then(function (r) {
      if (path === '/api/logout') { try { localStorage.removeItem(KEY); } catch (e) {} }
      if (r.status === 401 && !isAuth) { try { localStorage.removeItem(KEY); } catch (e) {} }
      if (isAuth && r.ok) {
        return r.clone().json().then(function (j) { if (j && j.token) { try { localStorage.setItem(KEY, j.token); } catch (e) {} } return r; }, function () { return r; });
      }
      return r;
    });
  };
  // Plain links to /api files (CSV downloads) need the token too: fetch them and save the file.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="/api/"]') : null;
    if (!a || e.defaultPrevented) return;
    e.preventDefault();
    window.fetch(a.getAttribute('href')).then(function (r) {
      if (!r.ok) throw new Error('Download nahi hua (' + r.status + ')');
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="?([^";]+)"?/.exec(cd);
      return r.blob().then(function (b) {
        var u = URL.createObjectURL(b), x = document.createElement('a');
        x.href = u; x.download = m ? m[1] : 'dawalekh.csv'; document.body.appendChild(x); x.click();
        setTimeout(function () { URL.revokeObjectURL(u); x.remove(); }, 1000);
      });
    }).catch(function (err) { alert(err.message); });
  }, true);
})();
