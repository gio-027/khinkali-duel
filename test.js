'use strict';
/* ავტომატური შემოწმება: node test.js (ჯერ npm install). */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const Rules = require('./public/rules.js');

/* ---------- 1. წესები ---------- */
(function rulesTest() {
  const names = { a: 'ა', b: 'ბ' };
  let s = Rules.freshState(1, 'a', names);
  s = Rules.reduceMove(s, 'bite', 0.9);
  assert.strictEqual(s.hp.b, 4); assert.strictEqual(s.turn, 'b');

  // დაცვა ბლოკავს ერთ ნაკბენს
  let d = Rules.freshState(1, 'a', names);
  d = Rules.reduceMove(d, 'defend', 0.9);                 // a იცავს
  d = Rules.reduceMove(d, 'bite', 0.9);                   // b კბენს, დაიბლოკა
  assert.strictEqual(d.hp.a, 5); assert.strictEqual(d.shield.a, false); assert.strictEqual(d.ev.kind, 'blocked');
  assert.strictEqual(Rules.reduceMove(Rules.reduceMove(Rules.freshState(1, 'a', names), 'defend', 0), 'bite', 0).turn, 'a');

  // ორჯერ დაცვა არ შეიძლება
  let e = Rules.freshState(1, 'a', names);
  e = Rules.reduceMove(e, 'defend', 0.9);
  e = Rules.reduceMove(e, 'defend', 0.9);                 // b იცავს
  assert.strictEqual(Rules.reduceMove(e, 'defend', 0.9), null);

  // რისკიანი სვლა
  const hit = Rules.reduceMove(Rules.freshState(1, 'a', names), 'risky', 0.2);
  assert.strictEqual(hit.hp.b, 3);
  const miss = Rules.reduceMove(Rules.freshState(1, 'a', names), 'risky', 0.7);
  assert.strictEqual(miss.hp.b, 5); assert.strictEqual(miss.ev.kind, 'risky_miss');

  // გამარჯვება
  let w = Rules.freshState(1, 'a', names);
  w.hp.b = 1;
  w = Rules.reduceMove(w, 'bite', 0.9);
  assert.strictEqual(w.over, 'a'); assert.strictEqual(w.hp.b, 0);
  assert.strictEqual(Rules.reduceMove(w, 'bite', 0.9), null);

  // ჰპ ნულს ქვემოთ არ ეცემა
  let z = Rules.freshState(1, 'a', names);
  z.hp.b = 1;
  z = Rules.reduceMove(z, 'risky', 0.1);
  assert.strictEqual(z.hp.b, 0);
  console.log('ok  rules');
})();

/* ---------- 2. სერვერი ---------- */
const PORT = 3111;
const base = 'http://127.0.0.1:' + PORT;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'pipe', 'inherit']
    });
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
    p.on('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
}

function client() {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    const msgs = [];
    const waiters = [];
    ws.on('message', (d) => { msgs.push(JSON.parse(d)); waiters.slice().forEach((w) => w()); });
    const c = {
      ws, msgs,
      send: (m) => ws.send(JSON.stringify(m)),
      take: (pred, ms) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting for message; have: ' + JSON.stringify(msgs))), ms || 2000);
        const check = () => {
          const i = msgs.findIndex(pred);
          if (i < 0) return false;
          clearTimeout(t);
          const j = waiters.indexOf(check); if (j >= 0) waiters.splice(j, 1);
          res(msgs.splice(i, 1)[0]);
          return true;
        };
        if (!check()) waiters.push(check);
      }),
      type: (t, ms) => c.take((m) => m.t === t, ms)
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = await startServer();
  try {
    // HTTP
    let r = await fetch(base + '/healthz'); assert.strictEqual(r.status, 200);
    r = await fetch(base + '/'); assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').startsWith('text/html'));
    assert.ok(r.headers.get('content-security-policy'));
    assert.ok((await r.text()).includes('ხინკლის დუელი'));
    r = await fetch(base + '/rules.js'); assert.strictEqual(r.status, 200);
    r = await fetch(base + '/server.js'); assert.strictEqual(r.status, 404);
    r = await fetch(base + '/..%2fserver.js'); assert.strictEqual(r.status, 404);
    console.log('ok  http');

    // ოთახის შექმნა
    const A = await client();
    A.send({ t: 'create', name: 'გიორგი' });
    const created = await A.type('created');
    assert.strictEqual(created.code.length, 4); assert.strictEqual(created.role, 'a');

    // არასწორი კოდი
    const B = await client();
    B.send({ t: 'join', code: 'ZZZZ', name: 'ნინო' });
    assert.strictEqual((await B.type('err')).code, 'no_room');

    // შეერთება
    B.send({ t: 'join', code: created.code.toLowerCase(), name: 'ნინო' });
    const joined = await B.type('joined'); assert.strictEqual(joined.role, 'b');
    let sa = (await A.type('state')).state;
    let sb = (await B.type('state')).state;
    assert.deepStrictEqual(sa, sb);
    assert.strictEqual(sa.n, 0); assert.strictEqual(sa.names.a, 'გიორგი'); assert.strictEqual(sa.names.b, 'ნინო');

    // მესამე მოთამაშე
    const C = await client();
    C.send({ t: 'join', code: created.code, name: 'სხვა' });
    assert.strictEqual((await C.type('err')).code, 'room_full');
    C.ws.close();
    console.log('ok  create/join');

    const by = { a: A, b: B };
    // არასწორი რიგი: სვლა უგულებელყოფილია, სერვერი მდგომარეობას უბრუნებს
    const wrong = sa.turn === 'a' ? 'b' : 'a';
    by[wrong].send({ t: 'move', act: 'bite' });
    const back = (await by[wrong].type('state')).state;
    assert.strictEqual(back.n, 0);

    // სწორი სვლა
    const first = sa.turn, second = first === 'a' ? 'b' : 'a';
    by[first].send({ t: 'move', act: 'bite' });
    sa = (await A.type('state')).state; sb = (await B.type('state')).state;
    assert.deepStrictEqual(sa, sb);
    assert.strictEqual(sa.n, 1); assert.strictEqual(sa.hp[second], 4); assert.strictEqual(sa.turn, second);

    // უცნობი სვლა
    by[second].send({ t: 'move', act: 'cheat' });
    assert.strictEqual((await by[second].type('state')).state.n, 1);
    console.log('ok  moves');

    // გათიშვა და დაბრუნება
    B.ws.close();
    assert.strictEqual((await A.type('peer')).online, false);
    const B2 = await client();
    B2.send({ t: 'rejoin', code: created.code, role: 'b', token: 'wrong' });
    assert.strictEqual((await B2.type('err')).code, 'no_room');
    const B3 = await client();
    B3.send({ t: 'rejoin', code: created.code, role: 'b', token: joined.token });
    assert.strictEqual((await B3.type('rejoined')).role, 'b');
    const resumed = (await B3.type('state')).state;
    assert.strictEqual(resumed.n, 1);
    assert.strictEqual((await A.type('peer')).online, true);
    by.b = B3;
    console.log('ok  reconnect');

    // თამაში ბოლომდე
    let cur = resumed;
    for (let i = 0; i < 30 && !cur.over; i++) {
      by[cur.turn].send({ t: 'move', act: 'bite' });
      cur = (await A.type('state')).state;
      await B3.type('state');
    }
    assert.ok(cur.over, 'game should end');
    assert.strictEqual(cur.hp[cur.over === 'a' ? 'b' : 'a'], 0);

    // ხელახლა
    A.send({ t: 'again' });
    sa = (await A.type('state')).state; await B3.type('state');
    assert.strictEqual(sa.game, 2); assert.strictEqual(sa.n, 0); assert.strictEqual(sa.hp.a, 5);
    A.send({ t: 'again' });                                // მიმდინარე თამაშზე არაფერი ხდება
    await sleep(150);
    assert.strictEqual(A.msgs.filter((m) => m.t === 'state').length, 0);
    console.log('ok  full game and rematch');

    // გასვლა
    A.send({ t: 'leave' });
    await B3.type('closed');
    const D = await client();
    D.send({ t: 'join', code: created.code, name: 'x' });
    assert.strictEqual((await D.type('err')).code, 'no_room');
    console.log('ok  leave');

    console.log('ALL TESTS PASSED');
  } finally {
    srv.kill('SIGTERM');
  }
}

main().then(() => process.exit(0), (e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
