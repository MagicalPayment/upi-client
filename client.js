// client/server.js — async + small hardening for concurrency
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAYMENTGATEWAY_URL = process.env.PAYMENTGATEWAY_URL || 'http://localhost:3000';
const PORT = Number(process.env.PORT || 3001);
const WAIT_MIN = Math.max(1, Number(process.env.WAIT_TIME || 10));
const SESSION_TTL_MS = WAIT_MIN * 60 * 1000;

/** comment -> session */
const sessionMap = Object.create(null);

// Random 10-char token
function gen() {
  const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = ''; for (let i = 0; i < 10; i++) out += s[(Math.random() * s.length) | 0];
  return out;
}

app.get('/config', (req, res) => {
  res.json({ gatewayUrl: PAYMENTGATEWAY_URL, socketUrl: `https://gradz.in`, waitMinutes: WAIT_MIN });
});

app.get('/session/:comment', (req, res) => {
  const s = sessionMap[req.params.comment];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ amount: s.amount, expiresAt: s.expiresAt, status: s.status || 'PENDING' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', socket => {
  socket.on('join-session', c => socket.join(c));

  // Start payment (non-blocking; just allocates memory/timer)
  socket.on('payment', (amount) => {
    const amt = Number(amount);
    if (!amt || isNaN(amt) || amt <= 0) {
      socket.emit('payment-error', `Invalid amount: ${amount}`); return;
    }
    const comment = gen();
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const s = (sessionMap[comment] = { amount: amt, createdAt: now, expiresAt, status: 'PENDING' });

    s.timer = setTimeout(() => {
      const cur = sessionMap[comment]; if (!cur) return;
      delete sessionMap[comment];
      io.to(comment).emit('payment-timeup', comment);
    }, SESSION_TTL_MS + 1000);

    socket.emit('session-created', { comment, amount: amt, expiresAt });
  });

  socket.on('payment-cancel', async (comment) => {
    const s = sessionMap[comment];
    if (s?.timer) clearTimeout(s.timer);
    delete sessionMap[comment];
    io.to(comment).emit('payment-cancelled', comment);
    try { await axios.post(`${PAYMENTGATEWAY_URL}/api/cancel/${encodeURIComponent(comment)}`, null, { timeout: 5000 }); } catch {}
  });

  socket.on('payment-timeup', (comment) => {
    const s = sessionMap[comment];
    if (s?.timer) clearTimeout(s.timer);
    delete sessionMap[comment];
    io.to(comment).emit('payment-timeup', comment);
  });

  socket.on('payment-failure', (comment) => {
    const s = sessionMap[comment];
    if (s?.timer) clearTimeout(s.timer);
    delete sessionMap[comment];
    io.to(comment).emit('payment-failure', comment);
  });

  socket.on('payment-success', (comment) => {
    const s = sessionMap[comment];
    if (s?.timer) clearTimeout(s.timer);
    delete sessionMap[comment];
    io.to(comment).emit('payment-success', comment);
  });

  socket.on('payment-cancelled', (comment) => {
    const s = sessionMap[comment];
    if (s?.timer) clearTimeout(s.timer);
    delete sessionMap[comment];
    io.to(comment).emit('payment-cancelled', comment);
  });
});

server.listen(PORT, () => {
  console.log(`Client server on http://localhost:${PORT} (WAIT_TIME=${WAIT_MIN}m)`);
});
