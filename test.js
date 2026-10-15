'use strict';
/* ავტომატური შემოწმება: node test.js (ჯერ npm install). */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const Rules = require('./rules.js');

/* ---------- 1. წესები ---------- */
(function rulesTest() {
  const names = { a: 'ა', b: 'ბ' };
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };      // მართვადი შემთხვევითობა
  // კამათლის მნიშვნელობა: 0.99 -> 6, 0.0 -> 1, 0.5 -> 4

  // ready: ორივემ აირჩია; a-მ პირველმა გააგორა 6, b-მ 1, a იგებს და მოქმედებს
  function ready(stake) {
    let s = Rules.freshState(1, 'a', names, stake);
    s = Rules.reduceMethod(s, 'a', 'hand', null, Math.random);
    s = Rules.reduceMethod(s, 'b', 'fork', 'head', Math.random);
    assert.strictEqual(s.step, 'roll'); assert.strictEqual(s.roller, 'a');
    s = Rules.reduceRoll(s, 'a', seq(0.99));
    s = Rules.reduceRoll(s, 'b', seq(0.0));
    return s;
  }
  let s = ready(2);
  assert.strictEqual(s.phase, 'play'); assert.strictEqual(s.step, 'act'); assert.strictEqual(s.turn, 'a');
  assert.deepStrictEqual(s.dice, { a: 6, b: 1 });
  assert.strictEqual(Rules.reduceMove(Rules.freshState(1, 'a', names, 1), 'bite', seq(0.5)), null, 'no moves before both chose');

  // კამათელი: რიგი, ფრე, მეორეს გაგორება
  let r = Rules.reduceMethod(Rules.reduceMethod(Rules.freshState(1, 'b', names, 1), 'a', 'hand', null), 'b', 'hand', null);
  assert.strictEqual(r.roller, 'b');
  assert.strictEqual(Rules.reduceRoll(r, 'a', seq(0.5)), null, 'wrong roller');
  assert.strictEqual(Rules.reduceMove(r, 'bite', seq(0.5)), null, 'cannot act before rolling');
  r = Rules.reduceRoll(r, 'b', seq(0.5));                                     // 4
  assert.strictEqual(r.roller, 'a'); assert.strictEqual(r.dice.b, 4); assert.strictEqual(r.dice.a, null);
  assert.strictEqual(Rules.reduceRoll(r, 'b', seq(0.5)), null, 'cannot roll twice');
  r = Rules.reduceRoll(r, 'a', seq(0.5));                                     // 4 = ფრე
  assert.strictEqual(r.tie, true); assert.strictEqual(r.step, 'roll'); assert.strictEqual(r.ev.kind, 'roll_tie');
  r = Rules.reduceRoll(r, r.roller, seq(0.0));                                // ახალი რაუნდი: ძველი ქულები იშლება
  assert.strictEqual(r.tie, false); assert.strictEqual(r.dice[r.roller === 'a' ? 'b' : 'a'] === null || true, true);
  const first2 = r.ev.who; assert.strictEqual(r.dice[first2], 1);
  assert.strictEqual(r.dice[first2 === 'a' ? 'b' : 'a'], null);
  r = Rules.reduceRoll(r, r.roller, seq(0.99));
  assert.strictEqual(r.step, 'act'); assert.strictEqual(r.turn, r.dice.a > r.dice.b ? 'a' : 'b');

  // ჭამის წესები: ხელით ნებისმიერ ადგილას კარგია; ჩანგალი მუცელში და დანა-ჩანგალი აგებინებს
  const eat = (tool, spot) => Rules.reduceMethod(Rules.freshState(1, 'a', names, 3), 'a', tool, spot, Math.random);
  assert.strictEqual(eat('hand', null).over, null); assert.strictEqual(eat('hand', 'belly').over, null); assert.strictEqual(eat('hand', 'head').over, null);
  assert.strictEqual(eat('fork', 'head').over, null);
  const lose = (tool, spot, why) => {
    const x = eat(tool, spot);
    assert.strictEqual(x.over, 'b'); assert.strictEqual(x.why, why);
    assert.deepStrictEqual(x.bal, { a: 7, b: 16 });              // წაგებული -3, გამარჯვებული +6 (ფსონის ორმაგი)
  };
  lose('forknife', null, 'knife_fork'); lose('fork', 'belly', 'fork_belly');
  assert.strictEqual(eat('spoon', 'head'), null);
  assert.strictEqual(eat('fork', 'x'), null);

  // ბულიონი
  let t = Rules.reduceMove(s, 'bite', seq(0.5));
  assert.strictEqual(t.hp.b, 4); assert.strictEqual(t.broth.a, 'pending');
  assert.strictEqual(t.step, 'roll'); assert.strictEqual(t.roller, 'b');
  const mine = Object.assign({}, t, { step: 'act', turn: 'a' });
  const spill = Rules.reduceMove(mine, 'defend', seq(0.5));
  assert.strictEqual(spill.over, 'b'); assert.strictEqual(spill.why, 'spill'); assert.deepStrictEqual(spill.bal, { a: 8, b: 14 });
  const sip = Rules.reduceMove(mine, 'sip', seq(0.5));
  assert.strictEqual(sip.broth.a, 'done'); assert.strictEqual(sip.over, null);
  assert.strictEqual(Rules.reduceMove(s, 'sip', seq(0.5)), null, 'cannot sip without a bite');

  // დაცვა ბლოკავს ერთ ნაკბენს
  let d = Rules.reduceMove(ready(0), 'defend', seq(0.5));
  d = Object.assign({}, d, { step: 'act', turn: 'b' });
  d = Rules.reduceMove(d, 'bite', seq(0.5));
  assert.strictEqual(d.hp.a, 5); assert.strictEqual(d.shield.a, false); assert.strictEqual(d.ev.kind, 'blocked');

  // რისკიანი სვლა
  assert.strictEqual(Rules.reduceMove(ready(0), 'risky', seq(0.2)).hp.b, 3);
  const miss = Rules.reduceMove(ready(0), 'risky', seq(0.7));
  assert.strictEqual(miss.hp.b, 5); assert.strictEqual(miss.ev.kind, 'risky_miss');

  // გამარჯვება: ფსონის ორმაგი
  let w = ready(2);
  w.hp.b = 1;
  w = Rules.reduceMove(w, 'bite', seq(0.5));
  assert.strictEqual(w.over, 'a'); assert.strictEqual(w.why, 'bites');
  assert.deepStrictEqual(w.bal, { a: 14, b: 8 });
  assert.strictEqual(Rules.reduceMove(w, 'bite', seq(0.5)), null);
  const rm = Rules.rematch(w, 'b');
  assert.deepStrictEqual(rm.bal, { a: 14, b: 8 }); assert.strictEqual(rm.phase, 'choose'); assert.strictEqual(rm.game, 2);
  const broke = Rules.rematch(Object.assign({}, w, { bal: { a: 20, b: 0 } }), 'a');
  assert.deepStrictEqual(broke.bal, { a: 10, b: 10 });
  assert.strictEqual(Rules.freshState(1, 'a', names, 999).stake, 10);
  assert.strictEqual(Rules.freshState(1, 'a', names, 5, { a: 3, b: 10 }).stake, 3);
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
    A.send({ t: 'create', name: 'გიორგი', stake: 2 });
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
    assert.strictEqual(sa.phase, 'choose'); assert.strictEqual(sa.stake, 2);

    // მესამე მოთამაშე
    const C = await client();
    C.send({ t: 'join', code: created.code, name: 'სხვა' });
    assert.strictEqual((await C.type('err')).code, 'room_full');
    C.ws.close();
    console.log('ok  create/join');

    const by = { a: A, b: B };
    // ჯერ ორივე ირჩევს, როგორ შეჭამს; მერე კამათელი წყვეტს, ვინ იწყებს
    A.send({ t: 'move', act: 'bite' });                       // არჩევამდე სვლა არ შეიძლება
    assert.strictEqual((await A.type('state')).state.phase, 'choose');
    A.send({ t: 'method', tool: 'hand', spot: 'head' });
    await A.type('state'); await B.type('state');
    B.send({ t: 'method', tool: 'fork', spot: 'head' });
    sa = (await A.type('state')).state; sb = (await B.type('state')).state;
    assert.strictEqual(sa.phase, 'play'); assert.strictEqual(sa.step, 'roll');
    for (let g = 0; g < 30 && sa.step === 'roll'; g++) {            // კამათელს რიგრიგობით აგორებენ
      by[sa.roller].send({ t: 'roll' });
      sa = (await A.type('state')).state; sb = (await B.type('state')).state;
    }
    assert.strictEqual(sa.step, 'act'); assert.ok(sa.dice.a !== sa.dice.b);
    assert.strictEqual(sa.turn, sa.dice.a > sa.dice.b ? 'a' : 'b');
    // არასწორი რიგი: სვლა უგულებელყოფილია, სერვერი მდგომარეობას უბრუნებს
    const wrong = sa.turn === 'a' ? 'b' : 'a';
    by[wrong].send({ t: 'move', act: 'bite' });
    const back = (await by[wrong].type('state')).state;
    assert.strictEqual(back.n, sa.n);

    // სწორი სვლა
    const first = sa.turn, second = first === 'a' ? 'b' : 'a';
    by[first].send({ t: 'move', act: 'bite' });
    sa = (await A.type('state')).state; sb = (await B.type('state')).state;
    assert.deepStrictEqual(sa, sb);
    assert.strictEqual(sa.hp[second], 4); assert.strictEqual(sa.broth[first], 'pending'); assert.strictEqual(sa.step, 'roll');

    // უცნობი სვლა
    by[sa.roller].send({ t: 'move', act: 'cheat' });
    assert.strictEqual((await by[sa.roller].type('state')).state.n, sa.n);
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
    assert.strictEqual(resumed.n, sa.n);
    assert.strictEqual((await A.type('peer')).online, true);
    by.b = B3;
    console.log('ok  reconnect');

    // თამაში ბოლომდე
    let cur = resumed;
    for (let i = 0; i < 200 && !cur.over; i++) {
      if (cur.step === 'roll') by[cur.roller].send({ t: 'roll' });
      else by[cur.turn].send({ t: 'move', act: cur.broth[cur.turn] === 'pending' ? 'sip' : 'bite' });
      cur = (await A.type('state')).state;
      await B3.type('state');
    }
    assert.ok(cur.over, 'game should end');
    assert.strictEqual(cur.hp[cur.over === 'a' ? 'b' : 'a'], 0);

    // ხელახლა
    A.send({ t: 'again' });
    sa = (await A.type('state')).state; await B3.type('state');
    assert.strictEqual(sa.game, 2); assert.strictEqual(sa.n, 0); assert.strictEqual(sa.hp.a, 5); assert.strictEqual(sa.phase, 'choose'); assert.strictEqual(sa.bal[cur.over], 14);
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
