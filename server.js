const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Server } = require('socket.io');

// ---- Réglages ----
const SIGMA_URL = process.env.SIGMA_URL || 'https://sigma-exchange.onrender.com';
const LOGIN_ROUTE = '/api/login';                      // route de connexion de Sigma Exchange (reçoit { email, password })
const FEED_ROUTES = ['/api/companies', '/api/cards'];  // routes de Sigma Exchange affichées dans « Découvrir »
const ROOMS = ['general', 'bourse', 'cartes'];         // salons autorisés (mêmes ids que dans index.html)
// ------------------

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) { console.error('Variable SESSION_SECRET manquante'); process.exit(1); }

const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && !dbUrl.includes('localhost') ? { rejectUnauthorized: false } : false
});

pool.query(`CREATE TABLE IF NOT EXISTS social_messages(
  id SERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now())`
).then(() => pool.query('ALTER TABLE social_messages ADD COLUMN IF NOT EXISTS sigma_user_id TEXT'))
 .catch(e => console.error('Erreur base de données :', e.message));

// ---- Jetons de session signés (7 jours) ----
const hmac = body => crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
const sign = p => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + hmac(body); };
const verify = t => {
  try {
    const [body, sig] = String(t).split('.');
    const good = hmac(body);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
};
const auth = (req, res, next) => {
  const u = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'auth' });
  req.user = u; next();
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ---- Connexion : on demande à Sigma Exchange de vérifier le compte (rien n'est stocké ici) ----
const attempts = new Map();
app.post('/api/login', async (req, res) => {
  const now = Date.now();
  const a = (attempts.get(req.ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (a.length >= 10) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes' });
  a.push(now); attempts.set(req.ip, a);

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail et mot de passe requis' });
  try {
    const r = await fetch(SIGMA_URL + LOGIN_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d.success === false) return res.status(401).json({ error: 'Identifiants incorrects' });
    const u = d.user || d;
    const id = String(u.id ?? u.userId ?? email);
    const name = String(u.username || u.name || u.pseudo || email.split('@')[0]).slice(0, 40);
    res.json({ token: sign({ id, name, exp: Date.now() + 7 * 864e5 }), user: { id, name } });
  } catch (e) {
    res.status(502).json({ error: 'Sigma Exchange ne répond pas (il se réveille peut-être), réessayez' });
  }
});

app.get('/api/social/messages/:room', auth, async (req, res) => {
  if (!ROOMS.includes(req.params.room)) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT room, username AS "user", text, extract(epoch from created_at)*1000 AS at
       FROM social_messages WHERE room=$1 ORDER BY id DESC LIMIT 100`, [req.params.room]);
    res.json(rows.reverse());
  } catch (e) { res.json([]); }
});

// Le serveur va chercher les données de Sigma Exchange (pas de souci de CORS côté site)
app.get('/api/feed', async (req, res) => {
  const items = [];
  const abs = u => !u ? null : u.startsWith('/') ? SIGMA_URL + u : u;
  for (const r of FEED_ROUTES) {
    try {
      const d = await (await fetch(SIGMA_URL + r, { signal: AbortSignal.timeout(8000) })).json();
      (Array.isArray(d) ? d : d.items || []).slice(0, 12).forEach(x => items.push({
        title: x.name || x.title || x.symbol || 'Sans titre',
        subtitle: x.description || (x.price != null ? x.price + ' €' : ''),
        image: abs(x.image || x.image_url || x.img)
      }));
    } catch (e) { /* route absente ou site endormi : on passe */ }
  }
  res.json(items);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const u = verify(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('auth'));
  socket.user = u; next();
});

io.on('connection', socket => {
  let last = 0;
  socket.on('join', room => { if (ROOMS.includes(room)) socket.join(room); });
  socket.on('message', async m => {
    const now = Date.now(); if (now - last < 500) return; last = now;   // anti-spam
    const text = String((m && m.text) || '').slice(0, 1000);
    const room = String((m && m.room) || '');
    if (!text || !ROOMS.includes(room)) return;
    const user = socket.user.name;   // l'identité vient du jeton, jamais du client
    try {
      await pool.query('INSERT INTO social_messages(room, username, text, sigma_user_id) VALUES($1,$2,$3,$4)',
        [room, user, text, socket.user.id]);
    } catch (e) {}
    io.to(room).emit('message', { room, user, text, at: Date.now() });
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Sigma Chat en ligne'));
