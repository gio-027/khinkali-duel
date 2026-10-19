'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// მხოლოდ ეს ფაილები ეგზავნება ბრაუზერს; server.js და package.json არასოდეს
const STATIC_FILES = ['index.html', 'app.js', 'rules.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'bg.svg', 'tile.svg'];
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
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
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

/* ფილმების კლიპები (.gif, .mp4, .webm). ფაილის სახელი განსაზღვრავს, სად გამოჩნდება:
   მოგება (win) / წაგება (lose) / წყვილი ანუ ფრე (tie); თუ სახელში წერია „საბოლოო“ (final), ის თამაშის დასასრულზეც გამოჩნდება.
   ფაილები შეიძლება ეწეროს საცავის მთავარ გვერდზე ან ერთი საქაღალდის შიგნით. */
const MEDIA_RE = /\.(gif|mp4|webm)$/i;
const MAX_CLIP = 25 * 1024 * 1024;
const MAX_CLIPS_TOTAL = 1024 * 1024 * 1024;
const clipList = { win: [], lose: [], tie: [], finalWin: [], finalLose: [] };
function classifyClip(name) {
  const n = name.normalize('NFC').toLowerCase();
  const fin = /საბოლოო|final/.test(n);
  let type = null;
  if (/მოგება|მოიგო|win/.test(n)) type = 'win';
  else if (/წაგება|წააგო|lose|loss/.test(n)) type = 'lose';
  else if (/წყვილ|ფრე|tie|pair|draw|double/.test(n)) type = 'tie';
  return type ? { type, fin } : null;
}
let clipTotal = 0;
function scanClips(dir, rel) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    if (ent.isDirectory()) { if (!rel) scanClips(path.join(dir, ent.name), ent.name + '/'); continue; }
    if (!ent.isFile() || !MEDIA_RE.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const st = fs.statSync(full);
    const cls = classifyClip(ent.name);
    if (!cls) { console.log('clip skipped (name has no win/lose/tie word): ' + rel + ent.name); continue; }
    if (st.size > MAX_CLIP || clipTotal + st.size > MAX_CLIPS_TOTAL) { console.log('clip skipped (too big): ' + rel + ent.name); continue; }
    clipTotal += st.size;
    const key = (rel + ent.name).normalize('NFC');
    files.set('/' + key, { file: full, size: st.size, type: TYPES[path.extname(ent.name).toLowerCase()], media: true });
    if (cls.fin) clipList[cls.type === 'win' ? 'finalWin' : cls.type === 'lose' ? 'finalLose' : 'tie'].push(key);
    clipList[cls.type].push(key);
  }
}
scanClips(__dirname, '');
console.log('clips: win ' + clipList.win.length + ', lose ' + clipList.lose.length + ', tie ' + clipList.tie.length + ', final win ' + clipList.finalWin.length + ', final lose ' + clipList.finalLose.length);
const clipsJson = JSON.stringify(clipList);

const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (p === '/clips.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    return res.end(clipsJson);
  }
  if (p === '/') p = '/index.html';
  try { p = decodeURIComponent(p).normalize('NFC'); } catch (e) { /* ignore */ }
  const f = files.get(p);
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (f.media) {                                   // ვიდეო/გიფი დისკიდან იგზავნება ნაწილ-ნაწილ (Safari-სთვის Range სჭირდება)
    const total = f.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const hdr = { 'content-type': f.type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' };
    let a = 0, b = total - 1, code = 200;
    if (m && (m[1] !== '' || m[2] !== '')) {
      a = m[1] === '' ? Math.max(0, total - parseInt(m[2], 10)) : parseInt(m[1], 10);
      b = m[1] === '' || m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
      if (a > b || a >= total) { res.writeHead(416, { 'content-range': 'bytes */' + total }); return res.end(); }
      hdr['content-range'] = 'bytes ' + a + '-' + b + '/' + total;
      code = 206;
    }
    hdr['content-length'] = b - a + 1;
    res.writeHead(code, hdr);
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(f.file, { start: a, end: b });
    rs.on('error', () => res.destroy());
    return rs.pipe(res);
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

// არჩევის ფაზაში მოწინააღმდეგის არჩევანი არ ჩანს; ჩანს მხოლოდ, ვინ დაადასტურა
function stateFor(s) {
  if (s.phase !== 'choose') return s;
  return Object.assign({}, s, { method: { a: null, b: null } });
}

function sendState(ws, room) {
  send(ws, { t: 'state', state: stateFor(room.state) });
}

function broadcastState(room) {
  for (const role of ['a', 'b']) {
    const pl = room.p[role];
    if (pl && pl.ws) sendState(pl.ws, room);
  }
}

// დაცული შემთხვევითი რიცხვი [0,1) კამათლისთვის და რისკიანი სვლისთვის
function rng() {
  return crypto.randomInt(1000000) / 1000000;
}

function cleanStake(v) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, Rules.MAX_STAKE);
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
    stake: cleanStake(m.stake),
    p: { a: { ws, token, name: cleanName(m.name), off: 0 }, b: null }
  };
  rooms.set(code, room);
  ws.ctx = { code, role: 'a' };
  send(ws, { t: 'created', code, token, role: 'a', stake: room.stake });
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
  send(ws, { t: 'joined', code, token, role: 'b', stake: room.stake });
  room.state = Rules.freshState(1, firstTurn(), { a: room.p.a.name, b: room.p.b.name }, room.stake);
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
  if (room.state) sendState(ws, room);
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
  const valid = act === 'bite' || act === 'sip';
  if (!valid || s.over || s.phase !== 'play' || s.turn !== c.role) return sendState(ws, room);
  const next = Rules.reduceMove(s, act, rng);
  if (!next) return sendState(ws, room);
  room.state = next;
  broadcastState(room);
}

function onRoll(ws) {
  const c = ws.ctx;
  const room = c && rooms.get(c.code);
  if (!room || !room.state) return;
  const next = Rules.reduceRoll(room.state, c.role, rng);
  if (!next) return sendState(ws, room);
  room.state = next;
  broadcastState(room);
}

function onMethod(ws, m) {
  const c = ws.ctx;
  const room = c && rooms.get(c.code);
  if (!room || !room.state) return;
  const tool = typeof m.tool === 'string' ? m.tool.slice(0, 12) : '';
  const spot = typeof m.spot === 'string' ? m.spot.slice(0, 12) : null;
  const next = Rules.reduceMethod(room.state, c.role, tool, spot, rng);
  if (!next) return sendState(ws, room);
  room.state = next;
  broadcastState(room);
}

function onAgain(ws) {
  const c = ws.ctx;
  const room = c && rooms.get(c.code);
  if (!room || !room.state || !room.state.over) return;
  const s = room.state;
  room.state = Rules.rematch(s, firstTurn());
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
    case 'method': return onMethod(ws, m);
    case 'roll': return onRoll(ws);
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
