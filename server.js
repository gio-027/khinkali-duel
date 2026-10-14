'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// მხოლოდ ეს ფაილები ეგზავნება ბრაუზერს; server.js და package.json არასოდეს
const STATIC_FILES = ['index.html', 'app.js', 'rules.js', 'style.css', 'manifest.webmanifest', 'icon.svg'];
const missing = STATIC_FILES.filter((n) => !fs.existsSync(path.join(__dirname, n)));
if (missing.length) {
  console.error('ფაილები აკლია / Missing files: ' + missing.join(', '));
  console.error('ატვირთე არქივის ყველა ფაილი ერთ ადგილას (საცავის მთავარ გვერდზე). / Upload ALL files from the zip to the repository root.');
  process.exit(1);
}
const Rules = require('./rules.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;

const MAX_ROOMS = 300;
const OFFLINE_GRACE_MS = 3 * 60 * 1000;       // ორივე მოთამაშე გათიშულია ამდენ ხანს -> ოთახი იხურება
const PLAYER_OFFLINE_MAX_MS = 10 * 60 * 1000; // ერთი მოთამაშე ამდენ ხანს არ დაბრუნდა -> ოთახი იხურება
const ROOM_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

/* ---------- სტატიკური ფაილები (იტვირთება გაშვებისას) ---------- */
const files = new Map();
for (const name of STATIC_FILES) {
  files.set('/' + name, {
    body: fs.readFileSync(path.join(__dirname, name)),
    type: TYPES[path.extname(name)] || 'application/octet-stream'
  });
}

const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (p === '/') p = '/index.html';
  const f = files.get(p);
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': f.type,
    'cache-control': p === '/index.html' ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP
  });
  res.end(req.method === 'HEAD' ? undefined : f.body);
});

/* ---------- ოთახები ---------- */
// room = { code, born, state, p: { a: Player, b: Player|null } }
// Player = { ws, token, name, off }
const rooms = new Map();

function cleanName(s) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f<>​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 14);
  return t || 'მოთამაშე';
}

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function other(room, role) {
  return room.p[role === 'a' ? 'b' : 'a'];
}

function broadcastState(room) {
  for (const role of ['a', 'b']) {
    const pl = room.p[role];
    if (pl && pl.ws) send(pl.ws, { t: 'state', state: room.state });
  }
}

function firstTurn() {
  return crypto.randomInt(2) === 0 ? 'a' : 'b';
}

function closeRoom(room, notify) {
  for (const role of ['a', 'b']) {
    const pl = room.p[role];
    if (!pl || !pl.ws) continue;
    if (notify) send(pl.ws, { t: 'closed' });
    pl.ws.ctx = null;
  }
  rooms.delete(room.code);
}

function leaveCurrent(ws) {
  const c = ws.ctx;
  ws.ctx = null;
  if (!c) return;
  const room = rooms.get(c.code);
  if (!room) return;
  const pl = room.p[c.role];
  if (!pl || pl.ws !== ws) return;
  closeRoom(room, true);
}

/* ---------- შეტყობინებები ---------- */
function onCreate(ws, m) {
  leaveCurrent(ws);
  if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', code: 'busy' });
  const code = newCode();
  const token = newToken();
  const room = {
    code,
    born: Date.now(),
    state: null,
    p: { a: { ws, token, name: cleanName(m.name), off: 0 }, b: null }
  };
  rooms.set(code, room);
  ws.ctx = { code, role: 'a' };
  send(ws, { t: 'created', code, token, role: 'a' });
}

function onJoin(ws, m) {
  leaveCurrent(ws);
  const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', code: 'no_room' });
  if (room.p.b) return send(ws, { t: 'err', code: 'room_full' });
  const token = newToken();
  room.p.b = { ws, token, name: cleanName(m.name), off: 0 };
  ws.ctx = { code, role: 'b' };
  send(ws, { t: 'joined', code, token, role: 'b' });
  room.state = Rules.freshState(1, firstTurn(), { a: room.p.a.name, b: room.p.b.name });
  send(ws, { t: 'peer', online: !!room.p.a.ws });
  broadcastState(room);
}

function onRejoin(ws, m) {
  const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const role = m.role === 'b' ? 'b' : 'a';
  const room = rooms.get(code);
  const pl = room && room.p[role];
  if (!room || !pl || !safeEqual(pl.token, m.token)) return send(ws, { t: 'err', code: 'no_room' });
  if (pl.ws && pl.ws !== ws) {
    pl.ws.ctx = null;
    try { pl.ws.close(); } catch (e) { /* ignore */ }
  }
  pl.ws = ws;
  pl.off = 0;
  ws.ctx = { code, role };
  send(ws, { t: 'rejoined', code, role });
  if (room.state) send(ws, { t: 'state', state: room.state });
  const op = other(room, role);
  send(ws, { t: 'peer', online: !!(op && op.ws) });
  if (op && op.ws) send(op.ws, { t: 'peer', online: true });
}

function onMove(ws, m) {
  const c = ws.ctx;
  const room = c && rooms.get(c.code);
  if (!room || !room.state) return;
  const s = room.state;
  const act = m.act;
  const valid = act === 'bite' || act === 'defend' || act === 'risky';
  if (!valid || s.over || s.turn !== c.role) return send(ws, { t: 'state', state: s });
  const roll = crypto.randomInt(1000000) / 1000000;
  const next = Rules.reduceMove(s, act, roll);
  if (!next) return send(ws, { t: 'state', state: s });
  room.state = next;
  broadcastState(room);
}

function onAgain(ws) {
  const c = ws.ctx;
  const room = c && rooms.get(c.code);
  if (!room || !room.state || !room.state.over) return;
  const s = room.state;
  room.state = Rules.freshState(s.game + 1, firstTurn(), s.names);
  broadcastState(room);
}

function onClose(ws) {
  const c = ws.ctx;
  if (!c) return;
  const room = rooms.get(c.code);
  if (!room) return;
  const pl = room.p[c.role];
  if (!pl || pl.ws !== ws) return;
  pl.ws = null;
  pl.off = Date.now();
  const op = other(room, c.role);
  if (op && op.ws) send(op.ws, { t: 'peer', online: false });
}

function handle(ws, m) {
  switch (m.t) {
    case 'create': return onCreate(ws, m);
    case 'join': return onJoin(ws, m);
    case 'rejoin': return onRejoin(ws, m);
    case 'move': return onMove(ws, m);
    case 'again': return onAgain(ws);
    case 'leave': return leaveCurrent(ws);
  }
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.winStart = Date.now();
  ws.winCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - ws.winStart > 5000) { ws.winStart = now; ws.winCount = 0; }
    if (++ws.winCount > 25) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    handle(ws, m);
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// ტელეფონები ხშირად ჩუმად წყვეტენ კავშირს; ping-ი კავშირს ცოცხალს ინახავს
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000).unref();

// მიტოვებული ოთახების გაწმენდა
setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const players = [room.p.a, room.p.b].filter(Boolean);
    const allOff = players.every((p) => !p.ws);
    const allGone = allOff && players.every((p) => now - p.off > OFFLINE_GRACE_MS);
    const oneGone = players.some((p) => !p.ws && now - p.off > PLAYER_OFFLINE_MAX_MS);
    if (allGone || oneGone || now - room.born > ROOM_MAX_AGE_MS) closeRoom(room, true);
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log('Khinkali Duel listening on port ' + PORT);
});

function shutdown() {
  console.log('Shutting down');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
