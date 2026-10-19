const express = require('express');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const { Server } = require('socket.io');

// ---- Réglages ----
const SIGMA_URL = process.env.SIGMA_URL || 'https://sigma-exchange.onrender.com';
const FEED_ROUTES = ['/api/companies', '/api/cards']; // routes de Sigma Exchange à afficher dans « Découvrir »
// ------------------

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
).catch(e => console.error('Erreur base de données :', e.message));

const app = express();
app.use('/api', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); }); // utile pour l'APK
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/social/messages/:room', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT room, username AS "user", text, extract(epoch from created_at)*1000 AS at
       FROM social_messages WHERE room=$1 ORDER BY id DESC LIMIT 100`, [req.params.room]);
    res.json(rows.reverse());
  } catch (e) { res.json([]); }
});

// Le serveur va chercher les données de Sigma Exchange (pas de problème de CORS côté site)
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
io.on('connection', socket => {
  socket.on('join', room => socket.join(String(room)));
  socket.on('message', async m => {
    const text = String(m.text || '').slice(0, 1000);
    const user = String(m.user || '').slice(0, 40);
    const room = String(m.room || '').slice(0, 40);
    if (!text || !user || !room) return;
    try { await pool.query('INSERT INTO social_messages(room, username, text) VALUES($1,$2,$3)', [room, user, text]); } catch (e) {}
    io.to(room).emit('message', { room, user, text, at: Date.now() });
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Sigma Chat en ligne'));
