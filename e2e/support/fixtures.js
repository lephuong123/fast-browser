// Tiny local fixture site for the e2e suite (no network beyond 127.0.0.1).
import http from 'node:http';

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const routes = {
  '/form': () =>
    page(
      'Fixture form',
      `<main>
  <h1>New order</h1>
  <form action="/done" method="get">
    <label>Email <input name="email" type="email"></label>
    <label>Customer name <input name="name" type="text"></label>
    <label>Password <input name="pw" type="password"></label>
    <label>Status
      <select name="status"><option value="">--</option><option value="open">Open</option><option value="closed">Closed</option></select>
    </label>
    <label><input name="agree" type="checkbox" value="yes"> I agree</label>
    <button type="submit">Submit order</button>
  </form>
</main>`,
    ),
  '/done': (url) => {
    const p = url.searchParams;
    return page(
      'Fixture done',
      `<main>
  <h1>Done</h1>
  <p id="msg">Saved: ${esc(p.get('name') || '')}</p>
  <p>Status: ${esc(p.get('status') || '')} / agree: ${esc(p.get('agree') || 'no')} / pw-length: ${(p.get('pw') || '').length}</p>
  <a href="/table">Go to table</a>
  <a href="/form">Back to form</a>
</main>`,
    );
  },
  '/modal': () =>
    page(
      'Fixture modal',
      `<main>
  <h1>Modal page</h1>
  <button id="open" onclick="document.getElementById('dlg').showModal()">Open dialog</button>
  <button>Background button</button>
  <dialog id="dlg">
    <h2>Confirm delete</h2>
    <button onclick="document.getElementById('dlg').close(); document.getElementById('out').textContent='deleted'">Delete it</button>
    <button onclick="document.getElementById('dlg').close()">Cancel</button>
  </dialog>
  <p id="out"></p>
</main>`,
    ),
  '/table': () =>
    page(
      'Fixture table',
      `<main>
  <h1>Inventory</h1>
  <table>
    <thead><tr><th>Item</th><th>Qty</th></tr></thead>
    <tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Banana</td><td>12</td></tr></tbody>
  </table>
</main>`,
    ),
};

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const fn = routes[url.pathname];
    if (!fn) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fn(url));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(() => r()));
  return port;
}
