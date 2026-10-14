(function () {
'use strict';

var R = window.Rules;
var MAX = R.MAX;
function $(id) { return document.getElementById(id); }

/* ---------- მდგომარეობა ---------- */
var mode = null;            // 'online' | 'bot'
var role = null;            // 'a' | 'b'
var state = null;           // სერვერის (ან ვარჯიშის) მდგომარეობა
var code = '';
var session = null;         // {code, token, role, name}
var myName = '';
var ws = null, wsOpen = false, queue = [], retry = 0, retryTimer = null, intentional = false;
var oppOnline = true, closed = false, connLost = false, pending = false;
var prevHp = { a: MAX, b: MAX };
var timers = {}, toastTimer = null;
var SESSION_KEY = 'khinkali-session', NAME_KEY = 'khinkali-name', MUTE_KEY = 'khinkali-muted';

/* ---------- დამხმარე ფუნქციები ---------- */
function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
  return s || 'მოთამაშე';
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function ssGet() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
function ssSet(v) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch (e) {} }
function ssDel() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }
function notice(t) {
  var el = $('toast');
  el.textContent = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.textContent = ''; }, 5000);
}
function show(id) {
  ['s-lobby', 's-wait', 's-game'].forEach(function (s) { $(s).hidden = (s !== id); });
}
function selectText(el) {
  try {
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) {}
}
function inviteUrl() {
  var u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('room', code);
  return u.href;
}
function dropRoomParam() {
  try {
    var u = new URL(location.href);
    if (u.searchParams.has('room')) {
      u.searchParams.delete('room');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch (e) {}
}

/* ---------- ხმები (WebAudio, ფაილები არ სჭირდება) ---------- */
var Sound = (function () {
  var ctx = null, master = null, noiseBuf = null, muted = (lsGet(MUTE_KEY) === '1');

  function ensure() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      var len = Math.floor(ctx.sampleRate * 0.5);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // iOS-ს პირველ შეხებაზე ჩუმი ბგერა სჭირდება, რომ ხმა გაიღვიძოს
      var s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function env(g, t, peak, dur, attack) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tone(f0, t, dur, type, vol, f1) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, vol, dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(t, dur, vol, freq, q, type) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    var g = ctx.createGain();
    env(g, t, vol, dur, 0.003);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.2); s.stop(t + dur + 0.02);
  }
  var fx = {
    click: function (t) { tone(900, t, 0.04, 'triangle', 0.12); },
    start: function (t) { tone(392, t, 0.14, 'triangle', 0.2); tone(523, t + 0.12, 0.22, 'triangle', 0.2); },
    bite: function (t) {
      noise(t, 0.07, 0.9, 2200, 1.2); noise(t + 0.08, 0.09, 0.8, 1500, 1);
      tone(150, t, 0.14, 'sine', 0.35, 60);
    },
    hurt: function (t) {
      noise(t, 0.08, 0.8, 1400, 1); noise(t + 0.09, 0.1, 0.7, 900, 1);
      tone(260, t, 0.28, 'sawtooth', 0.14, 90);
    },
    crit: function (t) {
      fx.bite(t);
      noise(t + 0.17, 0.09, 0.9, 1800, 1.2); tone(150, t + 0.17, 0.14, 'sine', 0.35, 60);
      [784, 988, 1319].forEach(function (f, i) { tone(f, t + 0.3 + i * 0.07, 0.2, 'triangle', 0.16); });
    },
    hurt2: function (t) {
      fx.hurt(t);
      noise(t + 0.2, 0.1, 0.7, 800, 1); tone(200, t + 0.2, 0.3, 'sawtooth', 0.14, 70);
    },
    defend: function (t) { tone(1760, t, 0.35, 'sine', 0.16); tone(2637, t, 0.25, 'sine', 0.1); },
    blocked: function (t) {
      tone(1760, t, 0.3, 'sine', 0.18); tone(2637, t, 0.22, 'sine', 0.1);
      noise(t, 0.12, 0.5, 300, 0.8, 'lowpass');
    },
    miss: function (t) { tone(420, t, 0.4, 'sawtooth', 0.12, 110); noise(t + 0.05, 0.25, 0.25, 3500, 0.7, 'highpass'); },
    turn: function (t) { tone(660, t, 0.09, 'sine', 0.14); tone(880, t + 0.09, 0.12, 'sine', 0.14); },
    win: function (t) {
      [523, 659, 784, 1047].forEach(function (f, i) { tone(f, t + i * 0.12, 0.3, 'triangle', 0.22); });
      tone(1047, t + 0.5, 0.5, 'triangle', 0.2);
    },
    lose: function (t) { [392, 330, 262, 196].forEach(function (f, i) { tone(f, t + i * 0.2, 0.35, 'triangle', 0.2); }); }
  };
  return {
    unlock: function () { ensure(); },
    play: function (name) {
      if (muted) return;
      var c = ensure();
      if (!c || !fx[name]) return;
      try { fx[name](c.currentTime + 0.01); } catch (e) {}
    },
    isMuted: function () { return muted; },
    setMuted: function (m) { muted = !!m; lsSet(MUTE_KEY, muted ? '1' : '0'); }
  };
})();

function eventSound(s) {
  var ev = s.ev;
  if (!ev) return;
  var mine = (ev.who === role), k = ev.kind;
  if (k === 'bite') Sound.play(mine ? 'bite' : 'hurt');
  else if (k === 'risky_hit') Sound.play(mine ? 'crit' : 'hurt2');
  else if (k === 'risky_miss') Sound.play('miss');
  else if (k === 'defend') Sound.play('defend');
  else if (k === 'blocked') Sound.play('blocked');
  if (!mine && (k === 'bite' || k === 'risky_hit')) {
    try { if (navigator.vibrate) navigator.vibrate(k === 'bite' ? 60 : [60, 40, 60]); } catch (e) {}
  }
  clearTimeout(timers.after);
  if (s.over) {
    timers.after = setTimeout(function () { Sound.play(s.over === role ? 'win' : 'lose'); }, 650);
  } else if (!mine) {
    timers.after = setTimeout(function () { Sound.play('turn'); }, 550);
  }
}

/* ---------- ხინკლის ნახატი ---------- */
var BITES = [[152, 96, 17], [72, 176, 17], [28, 142, 16], [128, 177, 17], [172, 142, 16]];
function khinkaliSVG(hp, shield, uid) {
  var plate = '<ellipse class="plate" cx="100" cy="184" rx="88" ry="12"/>';
  if (hp <= 0) {
    return '<svg viewBox="0 0 200 200" role="img" aria-label="ხინკალი გაქრა">' + plate +
      '<circle class="crumb" cx="84" cy="176" r="3"/><circle class="crumb" cx="112" cy="179" r="2.5"/><circle class="crumb" cx="126" cy="174" r="2"/></svg>';
  }
  var n = Math.max(0, Math.min(5, MAX - hp)), holes = '', pleats = '', i, k;
  for (i = 0; i < n; i++) { var b = BITES[i]; holes += '<circle cx="' + b[0] + '" cy="' + b[1] + '" r="' + b[2] + '" fill="#000"/>'; }
  for (k = -4; k <= 4; k++) {
    pleats += '<path d="M100 68 Q ' + (100 + k * 10) + ' 112 ' + (100 + k * 17) + ' ' + (172 - Math.abs(k) * 2) + '"/>';
  }
  var body = 'M28 148 C22 112 62 74 100 66 C138 74 178 112 172 148 C168 172 138 178 100 178 C62 178 32 172 28 148 Z';
  return '<svg viewBox="0 0 200 200" role="img" aria-label="ხინკალი, ' + hp + ' ნაჭერი">' +
    '<defs><mask id="m-' + uid + '" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#fff"/>' + holes + '</mask></defs>' +
    plate +
    '<g mask="url(#m-' + uid + ')"><path class="dough" d="' + body + '"/><g class="pleats">' + pleats + '</g></g>' +
    '<path class="dough" d="M92 68 Q94 48 100 46 Q106 48 108 68 Z"/>' +
    (shield ? '<ellipse class="ring" cx="100" cy="116" rx="92" ry="80"/>' : '') +
    '</svg>';
}

function eventText(ev) {
  if (!ev) return 'ხინკლები მზადაა. დაიწყეთ!';
  var mine = (ev.who === role);
  switch (ev.kind) {
    case 'bite': return mine ? 'ჩაკბიჩე! მოწინააღმდეგეს −1 ნაჭერი.' : 'მოწინააღმდეგემ ჩაკბიჩა! შენ −1 ნაჭერი.';
    case 'risky_hit': return mine ? 'გაგიმართლა! მოწინააღმდეგეს −2 ნაჭერი.' : 'მოწინააღმდეგეს გაუმართლა! შენ −2 ნაჭერი.';
    case 'risky_miss': return mine ? 'ვერ მოახერხე, ცხელი ბულიონი დაიღვარა.' : 'მოწინააღმდეგეს ვერ გამოუვიდა.';
    case 'defend': return mine ? 'ხინკალი დაიფარე.' : 'მოწინააღმდეგემ ხინკალი დაიფარა.';
    case 'blocked': return mine ? 'შენი ნაკბენი დაიბლოკა!' : 'დაიცავი! ნაკბენი დაიბლოკა.';
  }
  return '';
}

/* ---------- ეკრანის განახლება ---------- */
function fillPanel(k, r) {
  var s = state, hp = s.hp[r], pips = $('pips' + k), i;
  $('name' + k).textContent = s.names[r];
  $('kh' + k).innerHTML = khinkaliSVG(hp, s.shield[r], k);
  $('shield' + k).hidden = !s.shield[r];
  $('count' + k).textContent = hp + ' / ' + MAX + ' ნაჭერი';
  var kids = [];
  for (i = 0; i < MAX; i++) {
    var p = document.createElement('span');
    p.className = 'pip' + (i < hp ? '' : ' off');
    kids.push(p);
  }
  pips.replaceChildren.apply(pips, kids);
  var panel = $('p' + k);
  panel.classList.toggle('turn', s.turn === r && !s.over && !closed);
  if (hp < prevHp[r]) {
    panel.classList.remove('hit'); void panel.offsetWidth; panel.classList.add('hit');
    setTimeout(function () { panel.classList.remove('hit'); }, 500);
  }
  prevHp[r] = hp;
}

function updateBanner() {
  var b = $('banner'), text = '';
  if (mode === 'online') {
    if (connLost) text = 'კავშირი გაწყდა. ვცდილობთ აღდგენას...';
    else if (state && !state.over && !closed && !oppOnline) text = 'მოწინააღმდეგე გათიშულია. ველოდებით დაბრუნებას.';
  }
  b.textContent = text;
  b.hidden = !text;
}

function render() {
  var s = state;
  if (!s) return;
  var me = role, op = (me === 'a') ? 'b' : 'a';
  fillPanel('Me', me); fillPanel('Opp', op);
  var mineTurn = (s.turn === me) && !s.over && !closed;
  var t = $('turnTxt');
  if (closed) t.textContent = '';
  else t.textContent = s.over ? 'თამაში დასრულდა' : (mineTurn ? 'შენი სვლაა' : 'მოწინააღმდეგე ფიქრობს...');
  t.classList.toggle('mine', mineTurn);
  $('eventTxt').textContent = eventText(s.ev);
  var can = mineTurn && !pending && !connLost;
  $('actBite').disabled = !can;
  $('actRisky').disabled = !can;
  $('actDefend').disabled = !can || s.shield[me];
  var done = !!s.over || closed;
  $('actions').hidden = done;
  $('result').hidden = !done;
  if (closed) {
    $('resTitle').textContent = 'მოწინააღმდეგე გავიდა';
    $('resSub').textContent = 'თამაში დასრულდა.';
    $('againBtn').hidden = true;
  } else if (s.over) {
    var won = (s.over === me);
    $('resTitle').textContent = won ? 'გაიმარჯვე!' : 'წააგე';
    $('resSub').textContent = won ? 'მოწინააღმდეგის ხინკალი გაქრა.' : 'შენი ხინკალი გაქრა.';
    $('againBtn').hidden = false;
  }
  updateBanner();
}

/* ---------- მდგომარეობის ცვლილება ---------- */
function setState(next) {
  var prev = state;
  state = next;
  pending = false;
  if (!prev || prev.game !== next.game) {
    prevHp = { a: next.hp.a, b: next.hp.b };
    closed = false;
    clearTimeout(timers.after);
    show('s-game');
    $('roomChip').textContent = (mode === 'online') ? ('ოთახი ' + code) : 'ვარჯიში';
    render();
    if (next.n === 0) Sound.play('start');
    maybeBotTurn();
    return;
  }
  if (next.n !== prev.n) eventSound(next);
  render();
  maybeBotTurn();
}

/* ---------- ვარჯიში კომპიუტერთან ---------- */
function maybeBotTurn() {
  clearTimeout(timers.bot);
  if (mode !== 'bot' || !state || state.over || state.turn !== 'b') return;
  timers.bot = setTimeout(botMove, 900 + Math.random() * 600);
}
function botMove() {
  if (mode !== 'bot' || !state || state.over || state.turn !== 'b') return;
  var r = Math.random(), canDef = !state.shield.b, act;
  if (canDef && state.hp.b <= 2 && r < 0.45) act = 'defend';
  else if (r < 0.55) act = 'bite';
  else if (r < 0.8) act = 'risky';
  else act = canDef ? 'defend' : 'bite';
  var nx = R.reduceMove(state, act, Math.random());
  if (nx) setState(nx);
}
function startBot() {
  myName = cleanName($('name').value); lsSet(NAME_KEY, myName);
  resetNet();
  mode = 'bot'; role = 'a';
  setState(R.freshState(1, Math.random() < 0.5 ? 'a' : 'b', { a: myName, b: 'კომპიუტერი' }));
}

/* ---------- ქსელი ---------- */
function wsUrl() {
  var u = new URL('ws', location.href);
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  return u.href;
}
function rawSend(m) { try { ws.send(JSON.stringify(m)); } catch (e) {} }
function sendMsg(m) {
  if (ws && wsOpen) { rawSend(m); return; }
  if (m.t === 'create' || m.t === 'join') queue.push(m);
  connect();
}
function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  intentional = false;
  var sock;
  try { sock = new WebSocket(wsUrl()); } catch (e) { scheduleRetry(); return; }
  ws = sock;
  sock.onopen = function () {
    if (sock !== ws) return;
    wsOpen = true; retry = 0;
    if (connLost) { connLost = false; updateBanner(); if (state) render(); }
    if (queue.length) {
      var q = queue; queue = [];
      q.forEach(rawSend);
    } else if (session) {
      rawSend({ t: 'rejoin', code: session.code, role: session.role, token: session.token });
    }
  };
  sock.onmessage = function (ev) {
    if (sock !== ws) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m && typeof m === 'object') onServer(m);
  };
  sock.onclose = function () {
    if (sock !== ws) return;
    wsOpen = false; ws = null;
    if (intentional || mode !== 'online') return;
    connLost = !!state;
    if (state) render();
    scheduleRetry();
  };
  sock.onerror = function () {};
}
function scheduleRetry() {
  if (mode !== 'online' || intentional) return;
  if (!session && retry >= 3) { leaveToLobby('სერვერთან დაკავშირება ვერ მოხერხდა. სცადე თავიდან.'); return; }
  if (retry >= 60) { leaveToLobby('კავშირი ვერ აღდგა.'); return; }
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(800 * Math.pow(1.5, retry), 8000));
  retry++;
}
function resetNet() {
  intentional = true;
  clearTimeout(retryTimer);
  clearTimeout(timers.bot); clearTimeout(timers.after);
  var old = ws;
  ws = null; wsOpen = false; queue = []; retry = 0;
  if (old) { try { old.close(); } catch (e) {} }
  session = null; state = null; mode = null; role = null; code = '';
  pending = false; closed = false; connLost = false; oppOnline = true;
  prevHp = { a: MAX, b: MAX };
}
function leaveToLobby(msg) {
  ssDel();
  resetNet();
  show('s-lobby');
  if (msg) notice(msg);
}
function leaveGame() {
  if (mode === 'online' && ws && wsOpen) rawSend({ t: 'leave' });
  dropRoomParam();
  $('s-lobby').classList.remove('invited');
  $('invite').hidden = true;
  $('joinBtn').classList.remove('primary'); $('joinBtn').classList.add('secondary');
  leaveToLobby();
}

function showWait(host) {
  $('waitTitle').textContent = host ? 'ელოდები მეორე მოთამაშეს' : 'უერთდები ოთახს';
  $('codeBig').textContent = code || '····';
  $('shareLink').textContent = (host && code) ? inviteUrl() : '';
  $('hostBox').hidden = !host || !code;
  $('waitGuest').hidden = host;
  show('s-wait');
}

function onServer(m) {
  switch (m.t) {
    case 'created':
      role = 'a'; code = m.code;
      session = { code: m.code, token: m.token, role: 'a', name: myName };
      ssSet(session);
      showWait(true);
      break;
    case 'joined':
      role = 'b'; code = m.code;
      session = { code: m.code, token: m.token, role: 'b', name: myName };
      ssSet(session);
      showWait(false);
      break;
    case 'rejoined':
      role = m.role; code = m.code;
      if (!state) showWait(role === 'a');
      break;
    case 'state':
      setState(m.state);
      break;
    case 'peer':
      oppOnline = !!m.online;
      updateBanner();
      break;
    case 'closed':
      ssDel();
      if (state) { closed = true; render(); }
      else leaveToLobby('ოთახი დაიხურა.');
      break;
    case 'err':
      if (m.code === 'no_room') leaveToLobby('ოთახი ვერ ვიპოვეთ ან უკვე დახურულია.');
      else if (m.code === 'room_full') leaveToLobby('ამ ოთახში უკვე ორი მოთამაშეა.');
      else if (m.code === 'busy') leaveToLobby('სერვერი დაკავებულია. სცადე მოგვიანებით.');
      break;
  }
}

/* ---------- მოქმედებები ---------- */
function act(a) {
  var s = state;
  if (!s || s.over || closed || pending || s.turn !== role) return;
  if (a === 'defend' && s.shield[role]) return;
  if (mode === 'bot') {
    var nx = R.reduceMove(s, a, Math.random());
    if (nx) setState(nx);
    return;
  }
  if (mode === 'online' && ws && wsOpen) {
    pending = true; render();
    rawSend({ t: 'move', act: a });
    setTimeout(function () { if (pending) { pending = false; render(); } }, 4000);
  }
}
function again() {
  if (!state || !state.over) return;
  if (mode === 'bot') {
    setState(R.freshState(state.game + 1, Math.random() < 0.5 ? 'a' : 'b', state.names));
  } else if (mode === 'online' && ws && wsOpen) {
    rawSend({ t: 'again' });
  }
}
function startCreate() {
  myName = cleanName($('name').value); lsSet(NAME_KEY, myName);
  resetNet();
  mode = 'online'; role = 'a';
  showWait(true);
  sendMsg({ t: 'create', name: myName });
}
function startJoin() {
  var c = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 3) { notice('შეიყვანე ოთახის კოდი.'); return; }
  myName = cleanName($('name').value); lsSet(NAME_KEY, myName);
  resetNet();
  mode = 'online'; role = 'b'; code = c;
  showWait(false);
  sendMsg({ t: 'join', code: c, name: myName });
}
function copyLink() {
  var done = function () {
    var b = $('copyBtn');
    b.textContent = 'დაკოპირდა';
    setTimeout(function () { b.textContent = 'ბმულის კოპირება'; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(inviteUrl()).then(done, function () { selectText($('shareLink')); });
  } else {
    selectText($('shareLink'));
  }
}

/* ---------- ღილაკები ---------- */
$('heroKh').innerHTML = khinkaliSVG(MAX, false, 'hero');
$('name').value = lsGet(NAME_KEY) || '';
$('createBtn').onclick = startCreate;
$('joinBtn').onclick = startJoin;
$('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') startJoin(); });
$('botBtn').onclick = startBot;
$('cancelBtn').onclick = leaveGame;
$('leaveBtn').onclick = leaveGame;
$('homeBtn').onclick = leaveGame;
$('actBite').onclick = function () { act('bite'); };
$('actDefend').onclick = function () { act('defend'); };
$('actRisky').onclick = function () { act('risky'); };
$('againBtn').onclick = again;
$('copyBtn').onclick = copyLink;
if (navigator.share) {
  $('shareBtn').onclick = function () {
    navigator.share({ title: 'ხინკლის დუელი', text: 'ითამაშე ჩემთან ხინკლის დუელი! ოთახი: ' + code, url: inviteUrl() }).catch(function () {});
  };
} else {
  $('shareBtn').hidden = true;
}

var soundBtns = document.querySelectorAll('.soundbtn');
function paintSound() {
  Array.prototype.forEach.call(soundBtns, function (b) { b.setAttribute('aria-pressed', Sound.isMuted() ? 'false' : 'true'); });
}
Array.prototype.forEach.call(soundBtns, function (b) {
  b.onclick = function () {
    Sound.setMuted(!Sound.isMuted());
    paintSound();
    Sound.play('click');
  };
});
paintSound();
['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (ev) {
  document.addEventListener(ev, function () { Sound.unlock(); }, { passive: true });
});

/* ტელეფონზე ეკრანის გამოღვიძების შემდეგ კავშირს ვაახლებთ */
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && mode === 'online' && !ws && (session || queue.length)) { retry = 0; connect(); }
});
window.addEventListener('online', function () {
  if (mode === 'online' && !ws && (session || queue.length)) { retry = 0; connect(); }
});

/* ---------- გვერდის გახსნა: მოწვევა ან გაგრძელება ---------- */
var inv = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
if (!/^[A-Z0-9]{3,8}$/.test(inv)) inv = '';
if (inv) {
  $('code').value = inv;
  $('inviteCode').textContent = inv;
  $('invite').hidden = false;
  $('s-lobby').classList.add('invited');
  $('joinBtn').classList.remove('secondary'); $('joinBtn').classList.add('primary');
}
var saved = ssGet();
if (saved && saved.code && saved.token && (!inv || saved.code === inv)) {
  mode = 'online'; session = saved; code = saved.code; role = saved.role; myName = saved.name || '';
  showWait(role === 'a');
  connect();
}
})();
