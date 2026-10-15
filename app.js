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
var holdStage = false, heldDice = null, anim = { a: false, b: false }, faces = { a: null, b: null };
var chosenTool = null;      // 'hand' | 'fork' (არჩევის ეკრანზე)
var roomStake = 0;
var FACES = '\u2680\u2681\u2682\u2683\u2684\u2685';
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
    sip: function (t) {
      tone(220, t, 0.14, 'sine', 0.3, 130); tone(170, t + 0.17, 0.14, 'sine', 0.3, 100);
      noise(t, 0.3, 0.25, 500, 0.8, 'lowpass');
    },
    spill: function (t) { tone(320, t, 0.55, 'sawtooth', 0.12, 80); noise(t, 0.45, 0.45, 600, 0.8, 'lowpass'); },
    dice: function (t) {
      for (var i = 0; i < 6; i++) noise(t + i * 0.06, 0.05, 0.5, 2200 + Math.random() * 1800, 1.5);
      tone(700, t + 0.42, 0.06, 'triangle', 0.18);
    },
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
  else if (k === 'sip') Sound.play('sip');
  else if (k === 'spill' || k === 'wrong_method') Sound.play('spill');
  else if (k === 'ready') Sound.play('start');
  else if (k === 'roll' || k === 'roll_tie' || k === 'roll_done') Sound.play('dice');
  else if (k === 'locked') Sound.play('click');
  if (!mine && (k === 'bite' || k === 'risky_hit')) {
    try { if (navigator.vibrate) navigator.vibrate(k === 'bite' ? 60 : [60, 40, 60]); } catch (e) {}
  }
  clearTimeout(timers.after); clearTimeout(timers.after2);
  if (s.over) {
    timers.after = setTimeout(function () { Sound.play(s.over === role ? 'win' : 'lose'); }, 650);
  } else if (k === 'roll_done' && s.turn === role) {
    timers.after = setTimeout(function () { Sound.play('turn'); }, 900);
  }
}

/* ---------- ხინკლის ნახატი ---------- */
// ქართული ფერები: ღვინისფერი, ოქროსფერი, სპილოსძვლისფერი
var BITES = [[156, 128, 18], [164, 152, 17], [128, 170, 18], [40, 140, 18], [72, 168, 18]];
function plateSVG(uid) {
  // ქსოვილი ქართული ორნამენტით (ბორჯღალის მსგავსი ხვეული ბადე), ზემოდან თეფში
  var tile = '<pattern id="o-' + uid + '" width="26" height="26" patternUnits="userSpaceOnUse">' +
    '<rect width="26" height="26" fill="#7E1625"/>' +
    '<path d="M13 3 L23 13 L13 23 L3 13 Z" fill="none" stroke="#D9A441" stroke-width="1.3"/>' +
    '<path d="M13 8 C17 8 18 12 14 13 C10 14 9 18 13 18 M8 13 C8 9 12 8 13 12 C14 16 18 17 18 13" fill="none" stroke="#E9C46A" stroke-width="1.1" stroke-linecap="round"/>' +
    '<circle cx="0" cy="0" r="1.6" fill="#D9A441"/><circle cx="26" cy="0" r="1.6" fill="#D9A441"/><circle cx="0" cy="26" r="1.6" fill="#D9A441"/><circle cx="26" cy="26" r="1.6" fill="#D9A441"/>' +
    '</pattern>';
  return '<defs>' + tile + '<clipPath id="k-' + uid + '"><rect x="0" y="0" width="200" height="200" rx="22"/></clipPath></defs>' +
    '<g clip-path="url(#k-' + uid + ')"><rect width="200" height="200" fill="url(#o-' + uid + ')"/>' +
    '<rect x="5" y="5" width="190" height="190" rx="18" fill="none" stroke="#E9C46A" stroke-width="3"/>' +
    '<rect x="11" y="11" width="178" height="178" rx="13" fill="none" stroke="#D9A441" stroke-width="1" stroke-dasharray="3 4"/></g>' +
    '<ellipse cx="100" cy="166" rx="92" ry="28" fill="#5E0F1B" opacity=".55"/>' +
    '<ellipse cx="100" cy="160" rx="90" ry="29" fill="#F4ECDD" stroke="#D9A441" stroke-width="2.5"/>' +
    '<ellipse cx="100" cy="160" rx="76" ry="22" fill="#EADFC8" stroke="#A3192B" stroke-width="2"/>' +
    '<ellipse cx="100" cy="158" rx="62" ry="16" fill="#F7F0E1"/>';
}
function khinkaliSVG(hp, shield, uid) {
  if (hp <= 0) {
    return '<svg viewBox="0 0 200 200" role="img" aria-label="ხინკალი გაქრა">' + plateSVG(uid) +
      '<circle class="crumb" cx="84" cy="158" r="3.5"/><circle class="crumb" cx="112" cy="162" r="3"/><circle class="crumb" cx="128" cy="156" r="2.4"/></svg>';
  }
  var n = Math.max(0, Math.min(5, MAX - hp)), holes = '', pleats = '', i, k;
  for (i = 0; i < n; i++) { var b = BITES[i]; holes += '<circle cx="' + b[0] + '" cy="' + b[1] + '" r="' + b[2] + '" fill="#000"/>'; }
  // დაბალი და ბუთქუნა სხეული; ნაოჭები კვანძიდან ვრცელდება
  var body = 'M24 150 C20 118 54 96 100 94 C146 96 180 118 176 150 C174 170 142 176 100 176 C58 176 26 170 24 150 Z';
  for (k = -7; k <= 7; k++) {
    pleats += '<path d="M100 102 Q ' + (100 + k * 14) + ' 120 ' + (100 + k * 11) + ' ' + (176 - k * k * 0.12) + '"/>';
  }
  // დიდი კვანძი (კუდი)
  var knob = 'M83 104 C76 88 84 70 100 66 C116 70 124 88 117 104 Z';
  return '<svg viewBox="0 0 200 200" role="img" aria-label="ხინკალი, ' + hp + ' ნაჭერი">' +
    '<defs>' +
    '<radialGradient id="d-' + uid + '" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#FBF3E2"/><stop offset=".6" stop-color="#F0E2C6"/><stop offset="1" stop-color="#D8C197"/></radialGradient>' +
    '<clipPath id="c-' + uid + '"><path d="' + body + '"/></clipPath>' +
    '<mask id="m-' + uid + '" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#fff"/>' + holes + '</mask>' +
    '</defs>' +
    plateSVG(uid) +
    '<ellipse cx="100" cy="177" rx="70" ry="6" fill="#000" opacity=".2"/>' +
    '<g mask="url(#m-' + uid + ')">' +
    '<path class="dough" d="' + body + '" fill="url(#d-' + uid + ')"/>' +
    '<g class="pleats" clip-path="url(#c-' + uid + ')">' + pleats + '</g>' +
    '<ellipse cx="100" cy="104" rx="22" ry="7" fill="none" stroke="#C9B48C" stroke-width="1.6" opacity=".85"/>' +
    '</g>' +
    '<path class="dough" d="' + knob + '" fill="url(#d-' + uid + ')"/>' +
    '<path d="M90 78 Q100 72 110 78 M87 90 Q100 84 113 90 M91 99 Q100 95 109 99" fill="none" stroke="#C9B48C" stroke-width="1.6" stroke-linecap="round"/>' +
    '<ellipse cx="78" cy="118" rx="16" ry="7" fill="#fff" opacity=".3" transform="rotate(-20 78 118)"/>' +
    (shield ? '<ellipse class="ring" cx="100" cy="122" rx="94" ry="68"/>' : '') +
    '</svg>';
}

/* კამათლის ნახატი */
var PIPS = {
  1: [[50, 50]], 2: [[28, 28], [72, 72]], 3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]], 5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]]
};
function dieSVG(n) {
  var out = '<svg viewBox="0 0 100 100" role="img" aria-label="' + (n ? 'კამათელი ' + n : 'კამათელი ჯერ არ გაგორებულა') + '">' +
    '<rect x="5" y="5" width="90" height="90" rx="18" fill="#FBF3E2" stroke="#8E1B2A" stroke-width="5"/>';
  if (n && PIPS[n]) {
    PIPS[n].forEach(function (p) { out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="8.5" fill="' + (n === 1 ? '#A3192B' : '#3B1018') + '"/>'; });
  } else {
    out += '<text x="50" y="66" text-anchor="middle" font-size="46" font-weight="700" fill="#8E1B2A" opacity=".5">?</text>';
  }
  return out + '</svg>';
}

function eventText(ev) {
  if (!ev) return 'აირჩიე, როგორ შეჭამ ხინკალს.';
  var mine = (ev.who === role);
  switch (ev.kind) {
    case 'bite': return mine ? 'ჩაკბიჩე! მოწინააღმდეგეს −1 ნაჭერი.' : 'მოწინააღმდეგემ ჩაკბიჩა! შენ −1 ნაჭერი.';
    case 'risky_hit': return mine ? 'გაგიმართლა! მოწინააღმდეგეს −2 ნაჭერი.' : 'მოწინააღმდეგეს გაუმართლა! შენ −2 ნაჭერი.';
    case 'risky_miss': return mine ? 'ვერ მოახერხე, ცხელი ბულიონი დაიღვარა.' : 'მოწინააღმდეგეს ვერ გამოუვიდა.';
    case 'defend': return mine ? 'ხინკალი დაიფარე.' : 'მოწინააღმდეგემ ხინკალი დაიფარა.';
    case 'blocked': return mine ? 'შენი ნაკბენი დაიბლოკა!' : 'დაიცავი! ნაკბენი დაიბლოკა.';
    case 'sip': return mine ? 'ბულიონი დალიე, არაფერი დაიღვარა.' : 'მოწინააღმდეგემ ბულიონი დალია.';
    case 'locked': return mine ? 'არჩევანი მიღებულია.' : 'მოწინააღმდეგემ ხინკლის აღების წესი აირჩია.';
    case 'ready': return 'ორივემ ხინკალი სწორად აიღო. გააგორეთ კამათელი!';
    case 'roll': return mine ? 'შენ გააგორე: ' + ev.value + '.' : 'მოწინააღმდეგემ გააგორა: ' + ev.value + '.';
    case 'roll_tie': return 'ფრე! კამათელი თავიდან უნდა გაგორდეს.';
    case 'roll_done': return '';
  }
  return '';
}

function resultSub(s, me) {
  var won = (s.over === me), t;
  switch (s.why) {
    case 'knife_fork': t = won ? 'მოწინააღმდეგემ ხინკალს დანა-ჩანგალი მიაკარა.' : 'ხინკალს დანა-ჩანგლით არ ჭამენ!'; break;
    case 'fork_belly': t = won ? 'მოწინააღმდეგემ ჩანგალი მუცელში ჩაარჭო.' : 'ჩანგალი მუცელში ჩაარჭე და ბულიონი გამოვიდა.'; break;
    case 'hand_belly': t = won ? 'მოწინააღმდეგემ ხინკალი მუცლიდან დაიჭირა.' : 'ხინკალი მუცლიდან დაიჭირე და გასკდა.'; break;
    case 'spill': t = won ? 'მოწინააღმდეგემ ბულიონი არ დალია და დაიღვარა.' : 'ბულიონი არ დალიე და დაიღვარა.'; break;
    default: t = won ? 'მოწინააღმდეგის ხინკალი გაქრა.' : 'შენი ხინკალი გაქრა.';
  }
  if (s.stake > 0) {
    t += (won ? ' +' + (s.stake * R.WIN_MULT) : ' −' + s.stake) + ' ხინკალი.';
    if (s.bal.a < 1 || s.bal.b < 1) t += ' ბალანსი ნულია, ახალ თამაშზე ორივეს ისევ ' + R.START_BAL + ' ხინკალი ექნება.';
  }
  return t;
}

function diceText(s, me) {
  if (s.phase !== 'play' || s.step !== 'act' || s.over || s.dice.a === null || s.dice.b === null) return '';
  var op = (me === 'a') ? 'b' : 'a';
  return '🎲 შენ ' + s.dice[me] + '  ·  მოწინააღმდეგე ' + s.dice[op] + (s.turn === me ? ' — რაუნდს შენ იგებ' : ' — რაუნდს მოწინააღმდეგე იგებს');
}

/* ---------- ეკრანის განახლება ---------- */
function fillPanel(k, r) {
  var s = state, hp = s.hp[r], pips = $('pips' + k), i;
  $('name' + k).textContent = s.names[r];
  $('kh' + k).innerHTML = khinkaliSVG(hp, s.shield[r], k);
  $('shield' + k).hidden = !s.shield[r];
  $('count' + k).textContent = hp + ' / ' + MAX + ' ნაჭერი' + (s.stake > 0 ? ' · ' + s.bal[r] + ' ხინკალი ბანკში' : '');
  var kids = [];
  for (i = 0; i < MAX; i++) {
    var p = document.createElement('span');
    p.className = 'pip' + (i < hp ? '' : ' off');
    kids.push(p);
  }
  pips.replaceChildren.apply(pips, kids);
  var panel = $('p' + k);
  panel.classList.toggle('turn', s.phase === 'play' && s.step === 'act' && s.turn === r && !s.over && !closed);
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

function animateDie(x) {
  var count = 0;
  anim[x] = true;
  clearTimeout(timers['die' + x]);
  (function step() {
    faces[x] = 1 + Math.floor(Math.random() * 6);
    renderStage();
    if (++count < 9) timers['die' + x] = setTimeout(step, 90);
    else { anim[x] = false; renderStage(); }
  })();
}

/* კამათლის ეკრანი: დანარჩენი ყველაფერი ფონზე გადადის, წინა პლანზე ორი კამათელია */
function renderStage() {
  var s = state, me = role, op = (me === 'a') ? 'b' : 'a';
  var on = !!s && s.phase === 'play' && !s.over && !closed && (s.step === 'roll' || holdStage);
  $('diceStage').hidden = !on;
  $('appMain').classList.toggle('staged', on);
  if (!on) return;
  var d = (holdStage && heldDice) ? heldDice : s.dice;
  function val(x) { return anim[x] ? faces[x] : d[x]; }
  $('dieMe').innerHTML = dieSVG(val(me));
  $('dieOpp').innerHTML = dieSVG(val(op));
  $('dieMe').classList.toggle('rolling', anim[me]);
  $('dieOpp').classList.toggle('rolling', anim[op]);
  $('dieMeName').textContent = s.names[me] + ' (შენ)';
  $('dieOppName').textContent = s.names[op];
  var mineRoll = s.step === 'roll' && s.roller === me;
  var busy = anim.a || anim.b;
  $('rollBtn').hidden = s.step !== 'roll';
  $('rollBtn').disabled = !(mineRoll && !pending && !connLost && !busy);
  var m;
  if (s.step !== 'roll') m = (s.turn === me) ? 'შენ იგებ რაუნდს. შენი სვლაა!' : 'მოწინააღმდეგე იგებს რაუნდს.';
  else if (mineRoll) m = (s.tie ? 'ფრე! ' : '') + 'შენი რიგია, გააგორე კამათელი!';
  else m = (s.tie ? 'ფრე! ' : '') + 'მოწინააღმდეგე აგორებს...';
  $('diceMsg').textContent = m;
}

function render() {
  var s = state;
  if (!s) return;
  var me = role, op = (me === 'a') ? 'b' : 'a';
  fillPanel('Me', me); fillPanel('Opp', op);
  var choosing = s.phase === 'choose' && !s.over && !closed;
  var playing = s.phase === 'play' && !s.over && !closed;
  var mineTurn = playing && s.step === 'act' && s.turn === me;
  var t = $('turnTxt');
  if (closed) t.textContent = '';
  else if (s.over) t.textContent = 'თამაში დასრულდა';
  else if (choosing) t.textContent = s.picked[me] ? 'ველოდებით მოწინააღმდეგეს...' : 'როგორ შეჭამ ხინკალს?';
  else if (playing && s.step === 'roll') t.textContent = (s.roller === me) ? 'გააგორე კამათელი' : 'მოწინააღმდეგე აგორებს...';
  else t.textContent = mineTurn ? 'შენი სვლაა' : 'მოწინააღმდეგე ფიქრობს...';
  t.classList.toggle('mine', mineTurn || (choosing && !s.picked[me]));
  $('eventTxt').textContent = eventText(s.ev);
  $('diceTxt').textContent = closed ? '' : diceText(s, me);
  $('stakeChip').hidden = !(s.stake > 0);
  $('stakeChip').textContent = 'ფსონი: ' + s.stake;

  var net = !pending && !connLost;
  if (s.picked[me]) chosenTool = null;
  $('choose').hidden = !(choosing && !s.picked[me]);
  $('spotRow').hidden = !chosenTool;
  $('spotQ').textContent = 'ჩანგალს სად ჩაარჭობ?';
  $('toolHand').disabled = !net; $('toolFork').disabled = !net; $('toolKnife').disabled = !net;
  $('spotHead').disabled = !net; $('spotBelly').disabled = !net;
  $('toolFork').classList.toggle('sel', chosenTool === 'fork');

  var can = mineTurn && net;
  var needSip = s.broth[me] === 'pending';
  $('actBite').disabled = !can;
  $('actRisky').disabled = !can;
  $('actDefend').disabled = !can || s.shield[me];
  $('actSip').disabled = !can;
  $('actSip').hidden = !needSip;
  $('brothHint').hidden = !(needSip && mineTurn);
  var done = !!s.over || closed;
  $('actions').hidden = !playing;
  $('result').hidden = !done;
  if (closed) {
    $('resTitle').textContent = 'მოწინააღმდეგე გავიდა';
    $('resSub').textContent = 'თამაში დასრულდა.';
    $('againBtn').hidden = true;
  } else if (s.over) {
    $('resTitle').textContent = (s.over === me) ? 'გაიმარჯვე!' : 'წააგე';
    $('resSub').textContent = resultSub(s, me);
    $('againBtn').hidden = false;
  }
  updateBanner();
  renderStage();
}

/* ---------- მდგომარეობის ცვლილება ---------- */
function setState(next) {
  var prev = state;
  state = next;
  pending = false;
  if (!prev || prev.game !== next.game) {
    prevHp = { a: next.hp.a, b: next.hp.b };
    closed = false;
    chosenTool = null; holdStage = false; clearTimeout(timers.hold);
    clearTimeout(timers.after); clearTimeout(timers.after2);
    show('s-game');
    $('roomChip').textContent = (mode === 'online') ? ('ოთახი ' + code) : 'ვარჯიში';
    render();
    if (next.n === 0) Sound.play('start');
    maybeBotTurn();
    return;
  }
  if (next.n !== prev.n) {
    eventSound(next);
    if (next.ev && /^roll/.test(next.ev.kind)) animateDie(next.ev.who);
  }
  if (next.step === 'roll' || next.phase !== 'play') { holdStage = false; clearTimeout(timers.hold); }
  if (prev.step === 'roll' && next.step === 'act' && next.phase === 'play' && next.n !== prev.n) {
    holdStage = true;
    heldDice = { a: next.dice.a, b: next.dice.b };
    clearTimeout(timers.hold);
    timers.hold = setTimeout(function () { holdStage = false; render(); }, 1900);
  }
  render();
  maybeBotTurn();
}

/* ---------- ვარჯიში კომპიუტერთან ---------- */
function maybeBotTurn() {
  clearTimeout(timers.bot);
  if (mode !== 'bot' || !state || state.over) return;
  if (state.phase === 'choose' && !state.picked.b) timers.bot = setTimeout(botPick, 800 + Math.random() * 600);
  else if (state.phase === 'play' && state.step === 'roll' && state.roller === 'b') timers.bot = setTimeout(botRoll, 1100 + Math.random() * 500);
  else if (state.phase === 'play' && state.step === 'act' && state.turn === 'b') timers.bot = setTimeout(botMove, 2500 + Math.random() * 600);
}
function botPick() {
  if (mode !== 'bot' || !state || state.over || state.phase !== 'choose' || state.picked.b) return;
  var nx = R.reduceMethod(state, 'b', 'hand', 'head', Math.random);
  if (nx) setState(nx);
}
function botRoll() {
  if (mode !== 'bot' || !state || state.over || state.phase !== 'play' || state.step !== 'roll' || state.roller !== 'b') return;
  var nx = R.reduceRoll(state, 'b', Math.random);
  if (nx) setState(nx);
}
function botMove() {
  if (mode !== 'bot' || !state || state.over || state.phase !== 'play' || state.step !== 'act' || state.turn !== 'b') return;
  var r = Math.random(), canDef = !state.shield.b, act;
  if (state.broth.b === 'pending') act = 'sip';
  else if (canDef && state.hp.b <= 2 && r < 0.45) act = 'defend';
  else if (r < 0.55) act = 'bite';
  else if (r < 0.8) act = 'risky';
  else act = canDef ? 'defend' : 'bite';
  var nx = R.reduceMove(state, act, Math.random);
  if (nx) setState(nx);
}
function startBot() {
  myName = cleanName($('name').value); lsSet(NAME_KEY, myName);
  resetNet();
  mode = 'bot'; role = 'a';
  setState(R.freshState(1, 'a', { a: myName, b: 'კომპიუტერი' }, 0));
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
  clearTimeout(timers.bot); clearTimeout(timers.after); clearTimeout(timers.after2); clearTimeout(timers.hold); clearTimeout(timers.dieA); clearTimeout(timers.dieB);
  holdStage = false; heldDice = null; anim = { a: false, b: false };
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
  $('waitStake').hidden = !(host && roomStake > 0);
  $('waitStake').textContent = 'ფსონი: ' + roomStake + ' ხინკალი';
  show('s-wait');
}

function onServer(m) {
  switch (m.t) {
    case 'created':
      role = 'a'; code = m.code; roomStake = m.stake || 0;
      session = { code: m.code, token: m.token, role: 'a', name: myName };
      ssSet(session);
      showWait(true);
      break;
    case 'joined':
      role = 'b'; code = m.code; roomStake = m.stake || 0;
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
  if (!s || s.over || s.phase !== 'play' || s.step !== 'act' || closed || pending || s.turn !== role) return;
  if (a === 'defend' && s.shield[role]) return;
  if (a === 'sip' && s.broth[role] !== 'pending') return;
  if (mode === 'bot') {
    var nx = R.reduceMove(s, a, Math.random);
    if (nx) setState(nx);
    return;
  }
  if (mode === 'online' && ws && wsOpen) {
    pending = true; render();
    rawSend({ t: 'move', act: a });
    setTimeout(function () { if (pending) { pending = false; render(); } }, 4000);
  }
}
function rollDice() {
  var s = state;
  if (!s || s.over || s.phase !== 'play' || s.step !== 'roll' || s.roller !== role || closed || pending || anim.a || anim.b) return;
  if (mode === 'bot') {
    var nx = R.reduceRoll(s, role, Math.random);
    if (nx) setState(nx);
    return;
  }
  if (mode === 'online' && ws && wsOpen) {
    pending = true; render();
    rawSend({ t: 'roll' });
    setTimeout(function () { if (pending) { pending = false; render(); } }, 4000);
  }
}
function chooseMethod(tool, spot) {
  var s = state;
  if (!s || s.phase !== 'choose' || s.picked[role] || closed || pending) return;
  if (mode === 'bot') {
    var nx = R.reduceMethod(s, role, tool, spot, Math.random);
    if (nx) setState(nx);
    return;
  }
  if (mode === 'online' && ws && wsOpen) {
    pending = true; render();
    rawSend({ t: 'method', tool: tool, spot: spot || null });
    setTimeout(function () { if (pending) { pending = false; render(); } }, 4000);
  }
}
function again() {
  if (!state || !state.over) return;
  if (mode === 'bot') {
    setState(R.rematch(state, Math.random() < 0.5 ? 'a' : 'b'));
  } else if (mode === 'online' && ws && wsOpen) {
    rawSend({ t: 'again' });
  }
}
function startCreate() {
  myName = cleanName($('name').value); lsSet(NAME_KEY, myName);
  resetNet();
  mode = 'online'; role = 'a';
  showWait(true);
  roomStake = parseInt($('stake').value, 10) || 1;
  sendMsg({ t: 'create', name: myName, stake: roomStake });
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
$('actSip').onclick = function () { act('sip'); };
$('toolHand').onclick = function () { chooseMethod('hand', null); };
$('rollBtn').onclick = rollDice;
$('toolFork').onclick = function () { chosenTool = 'fork'; render(); };
$('toolKnife').onclick = function () { chooseMethod('forknife', null); };
$('spotHead').onclick = function () { if (chosenTool) chooseMethod(chosenTool, 'head'); };
$('spotBelly').onclick = function () { if (chosenTool) chooseMethod(chosenTool, 'belly'); };
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
