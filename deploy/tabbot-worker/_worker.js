// Tab.bot Worker for Dawalekh: serves public/ as static assets and proxies /api/* to the Render backend
// (same job as Netlify's _redirects line). Cookies are first-party on this host.
const BACKEND = 'https://medkhata.onrender.com';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const headers = new Headers(request.headers);
      headers.delete('host');
      const ip = request.headers.get('cf-connecting-ip');
      if (ip) headers.set('x-nf-client-connection-ip', ip);
      const init = { method: request.method, headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
      const r = await fetch(BACKEND + url.pathname + url.search, init);
      const out = new Response(r.body, r);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
