const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const port = Number(process.env.PORT || 8088);
const paymentUrl = process.env.PAYMENT_URL || 'http://localhost:4004';
const postgrestUrl = process.env.POSTGREST_URL || 'http://localhost:3000';
// Matches PostgREST's default db-pool of 10; callers queue for a free slot instead of failing at once.
const databasePoolSize = Number(process.env.DATABASE_POOL_SIZE || 10);
const databasePoolTimeoutMs = Number(process.env.DATABASE_POOL_TIMEOUT_MS || 2000);
const databaseWaiters = [];
let databaseConnectionsInUse = 0;
const products = [
  { id: 'aurora-mug', name: 'Aurora Field Mug', description: 'A durable enamel mug for early starts and late ideas.', priceCents: 2400, category: 'Desk', emoji: '☕' },
  { id: 'signal-notebook', name: 'Signal Notebook', description: 'Dot-grid pages for diagrams, traces, and half-formed plans.', priceCents: 1800, category: 'Desk', emoji: '📓' },
  { id: 'orbit-lamp', name: 'Orbit Desk Lamp', description: 'A warm, adjustable glow for focused work.', priceCents: 6400, category: 'Studio', emoji: '💡' },
  { id: 'cloud-socks', name: 'Cloudline Socks', description: 'Soft merino socks for long pairing sessions.', priceCents: 1600, category: 'Wear', emoji: '🧦' },
  { id: 'field-bag', name: 'Field Notes Bag', description: 'A compact canvas carry for your everyday kit.', priceCents: 5200, category: 'Carry', emoji: '👜' },
  { id: 'night-hoodie', name: 'Night Shift Hoodie', description: 'A heavyweight layer for cool offices and warmer thinking.', priceCents: 7200, category: 'Wear', emoji: '🧥' },
];

const send = (res, status, value, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
const readBody = req => new Promise((resolve, reject) => { let value = ''; req.on('data', chunk => { value += chunk; }); req.on('end', () => resolve(value ? JSON.parse(value) : {})); req.on('error', reject); });
const acquireDatabaseConnection = url => new Promise((resolve, reject) => {
  if (databaseConnectionsInUse < databasePoolSize) { databaseConnectionsInUse += 1; return resolve(); }
  const waiter = { resolve, timer: setTimeout(() => {
    databaseWaiters.splice(databaseWaiters.indexOf(waiter), 1);
    console.error(JSON.stringify({ event: 'database_pool_exhausted', poolSize: databasePoolSize, waiting: databaseWaiters.length, databaseUrl: url }));
    reject(Object.assign(new Error('database connection pool exhausted'), { status: 503 }));
  }, databasePoolTimeoutMs) };
  databaseWaiters.push(waiter);
});
// A freed slot passes straight to the next waiter, so the in-use count only drops when nobody is queued.
const releaseDatabaseConnection = () => {
  const next = databaseWaiters.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); } else databaseConnectionsInUse -= 1;
};
const database = async (url, options = {}) => {
  await acquireDatabaseConnection(url);
  try {
    const response = await fetch(`${postgrestUrl}${url}`, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!response.ok) throw new Error(data?.message || data?.details || `Database request failed: ${response.status}`);
    return data;
  } finally {
    releaseDatabaseConnection();
  }
};
const mapProduct = product => ({ ...product, priceCents: product.price_cents, price_cents: undefined });
const cart = userId => database(`/carts?user_id=eq.${encodeURIComponent(userId)}&select=quantity,products(*)`).then(items => items.map(item => ({ product: mapProduct(item.products), quantity: item.quantity })));

async function route(req, res, url) {
  if (url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'shop-api' });
  if (url.pathname === '/api/products' && req.method === 'GET') return send(res, 200, (await database('/products?select=*&order=name')).map(mapProduct));
  const userId = url.searchParams.get('userId') || 'workshop-user';
  if (url.pathname === '/api/cart' && req.method === 'GET') return send(res, 200, await cart(userId));
  if (url.pathname === '/api/cart' && req.method === 'POST') {
    const input = await readBody(req); const existing = await database(`/carts?user_id=eq.${encodeURIComponent(userId)}&product_id=eq.${encodeURIComponent(input.productId)}&select=quantity`);
    const quantity = (existing[0]?.quantity || 0) + Number(input.quantity || 1);
    await database('/carts', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ user_id: userId, product_id: input.productId, quantity }) });
    return send(res, 200, await cart(userId));
  }
  if (url.pathname === '/api/cart' && req.method === 'DELETE') { await database(`/carts?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' }); return send(res, 204, null); }
  if (url.pathname === '/api/checkout' && req.method === 'POST') {
    const input = await readBody(req); const items = await cart(userId); if (!items.length) return send(res, 400, { error: 'Your cart is empty' });
    const totalCents = items.reduce((total, item) => total + item.product.priceCents * item.quantity, 0);
    const orderId = `order_${randomUUID().slice(0, 8)}`;
    const charge = attempt => {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 150);
      return fetch(`${paymentUrl}/charge`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountCents: totalCents, email: input.email, orderId, attempt, cardLast4: input.cardNumber?.slice(-4) }) }).then(response => response.json()).finally(() => clearTimeout(timeout));
    };
    let payment;
    try { payment = await charge(1); } catch (error) {
      console.error(JSON.stringify({ event: 'payment_timeout_retrying', orderId, reason: error.name }));
      payment = await charge(2);
    }
    if (payment.status !== 'approved') return send(res, 402, { error: 'Payment was declined' });
    await database(`/carts?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
    return send(res, 200, { orderId, totalCents, payment, shipping: input.shipping });
  }
  if (['/', '/index.html', '/cart', '/checkout'].includes(url.pathname)) return send(res, 200, fs.readFileSync(path.join(__dirname, 'frontend/index.html'), 'utf8'), 'text/html');
  if (url.pathname === '/app.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'frontend/app.js'), 'utf8'), 'text/javascript');
  if (url.pathname === '/styles.css') return send(res, 200, fs.readFileSync(path.join(__dirname, 'frontend/styles.css'), 'utf8'), 'text/css');
  return send(res, 404, { error: 'Not found' });
}
http.createServer((req, res) => route(req, res, new URL(req.url, `http://${req.headers.host}`)).catch(error => { console.error(error); send(res, error.status || 500, { error: error.message }); })).listen(port, () => console.log(`shop API and frontend running at http://localhost:${port}`));
