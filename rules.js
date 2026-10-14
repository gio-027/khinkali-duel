/* ხინკლის დუელის წესები. ერთი და იგივე ფაილი მუშაობს სერვერზეც და ბრაუზერშიც.
   ყველა შემთხვევითობა (კამათელი, რისკიანი სვლა) მოდის rng ფუნქციიდან (0 <= rng() < 1),
   სერვერზე ის დაცული შემთხვევითი რიცხვებით იკვებება. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 5;            // ნაჭერი ერთ ხინკალში
  var START_BAL = 10;     // ვირტუალური ხინკალი თითო მოთამაშეს (ფულის ღირებულება არ აქვს)
  var MAX_STAKE = 10;

  /* სწორი ადგილი ხინკლის დასაჭერად ან ჩასაჭედად არის ხინკლის თავი (ზედა კვანძი).
     მუცელი არასწორია. თუ პირიქით გინდა, შეცვალე 'head' → 'belly'. */
  var GOOD_SPOT = 'head';
  var TOOLS = ['hand', 'fork', 'forknife'];
  var SPOTS = ['head', 'belly'];

  function opp(r) { return r === 'a' ? 'b' : 'a'; }
  function die(rng) { return 1 + Math.floor(rng() * 6); }

  /* ორივე აგორებს კამათელს; ვისაც მეტი მოუვა, ის მოქმედებს. ფრეზე თავიდან. */
  function rollRound(rng) {
    var a, b, i = 0;
    do { a = die(rng); b = die(rng); i++; } while (a === b && i < 20);
    if (a === b) b = (a === 6) ? 5 : a + 1;
    return { a: a, b: b, turn: a > b ? 'a' : 'b' };
  }

  /* null: არასწორი შეყვანა; {ok:true}: სწორად ჭამს; {ok:false, why}: მაშინვე წააგებს */
  function judgeMethod(tool, spot) {
    if (TOOLS.indexOf(tool) < 0) return null;
    if (tool === 'forknife') return { ok: false, why: 'knife_fork' };
    if (SPOTS.indexOf(spot) < 0) return null;
    if (spot !== GOOD_SPOT) return { ok: false, why: tool === 'fork' ? 'fork_belly' : 'hand_belly' };
    return { ok: true, why: null };
  }

  /* stake: ფსონი ხინკლებში (0 = ფსონის გარეშე, მაგ. ვარჯიში); bal: ბალანსები */
  function freshState(game, first, names, stake, bal) {
    var b = bal ? { a: bal.a, b: bal.b } : { a: START_BAL, b: START_BAL };
    var st = Math.floor(Number(stake) || 0);
    if (st < 0) st = 0;
    if (st > MAX_STAKE) st = MAX_STAKE;
    if (st > b.a) st = b.a;
    if (st > b.b) st = b.b;
    return {
      game: game,
      n: 0,
      phase: 'choose',                       // 'choose' | 'play' | 'over'
      hp: { a: MAX, b: MAX },
      shield: { a: false, b: false },
      broth: { a: 'none', b: 'none' },       // 'none' | 'pending' | 'done'
      picked: { a: false, b: false },
      method: { a: null, b: null },
      dice: null,                            // {a, b}: ბოლო რაუნდის კამათლები
      stake: st,
      bal: b,
      turn: first,                           // თამაშის დაწყების შემდეგ კამათელი წყვეტს
      over: null,                            // გამარჯვებული
      why: null,                             // 'bites' | 'knife_fork' | 'fork_belly' | 'hand_belly' | 'spill'
      names: names,
      ev: null
    };
  }

  function copy(s) {
    return {
      game: s.game, n: s.n, phase: s.phase,
      hp: { a: s.hp.a, b: s.hp.b },
      shield: { a: s.shield.a, b: s.shield.b },
      broth: { a: s.broth.a, b: s.broth.b },
      picked: { a: s.picked.a, b: s.picked.b },
      method: { a: s.method.a, b: s.method.b },
      dice: s.dice ? { a: s.dice.a, b: s.dice.b } : null,
      stake: s.stake,
      bal: { a: s.bal.a, b: s.bal.b },
      turn: s.turn, over: s.over, why: s.why, names: s.names, ev: s.ev
    };
  }

  /* თამაში მთავრდება: გამარჯვებული იღებს ფსონს */
  function finish(next, winner, why) {
    next.phase = 'over';
    next.over = winner;
    next.why = why;
    if (next.stake > 0) {
      next.bal[winner] += next.stake;
      next.bal[opp(winner)] -= next.stake;
    }
  }

  /* როგორ შეჭამს მოთამაშე ხინკალს. აბრუნებს ახალ მდგომარეობას ან null-ს. */
  function reduceMethod(s, who, tool, spot, rng) {
    if (s.phase !== 'choose' || s.picked[who]) return null;
    var j = judgeMethod(tool, spot);
    if (!j) return null;
    var next = copy(s);
    next.n = s.n + 1;
    next.method[who] = { tool: tool, spot: tool === 'forknife' ? null : spot };
    if (!j.ok) {
      finish(next, opp(who), j.why);
      next.ev = { who: who, kind: 'wrong_method', why: j.why };
      return next;
    }
    next.picked[who] = true;
    if (next.picked.a && next.picked.b) {
      var r = rollRound(rng || Math.random);
      next.phase = 'play';
      next.dice = { a: r.a, b: r.b };
      next.turn = r.turn;
      next.ev = { who: who, kind: 'ready' };
    } else {
      next.ev = { who: who, kind: 'locked' };
    }
    return next;
  }

  /* act: 'bite' | 'defend' | 'risky' | 'sip'. მოქმედებს ის, ვინც კამათელი მოიგო (s.turn).
     აბრუნებს ახალ მდგომარეობას ან null-ს, თუ სვლა დაუშვებელია. */
  function reduceMove(s, act, rng) {
    if (s.over || s.phase !== 'play') return null;
    if (act !== 'bite' && act !== 'defend' && act !== 'risky' && act !== 'sip') return null;
    rng = rng || Math.random;
    var who = s.turn;
    var other = opp(who);
    var next = copy(s);
    next.n = s.n + 1;

    // პირველი ნაკბენის შემდეგ ბულიონი უნდა დალიო, თორემ დაიღვრება
    if (s.broth[who] === 'pending' && act !== 'sip') {
      finish(next, other, 'spill');
      next.ev = { who: who, kind: 'spill', dmg: 0 };
      return next;
    }

    var kind;
    var dmg = 0;
    if (act === 'sip') {
      if (s.broth[who] !== 'pending') return null;
      next.broth[who] = 'done';
      kind = 'sip';
    } else if (act === 'defend') {
      if (s.shield[who]) return null;
      next.shield[who] = true;
      kind = 'defend';
    } else {
      dmg = act === 'bite' ? 1 : (rng() < 0.5 ? 2 : 0);
      if (dmg === 0) {
        kind = 'risky_miss';
      } else if (s.shield[other]) {
        next.shield[other] = false;
        kind = 'blocked';
        dmg = 0;
      } else {
        next.hp[other] = Math.max(0, s.hp[other] - dmg);
        kind = act === 'bite' ? 'bite' : 'risky_hit';
      }
      if (s.broth[who] === 'none') next.broth[who] = 'pending';
    }

    next.ev = { who: who, kind: kind, dmg: dmg };
    if (next.hp[other] === 0) {
      finish(next, who, 'bites');
      next.turn = who;
    } else {
      var r = rollRound(rng);
      next.dice = { a: r.a, b: r.b };
      next.turn = r.turn;
    }
    return next;
  }

  /* სახელმძღვანელო ახალი თამაშისთვის: ბალანსი გადადის, გაღარიბებულებს ახლიდან ეძლევათ */
  function rematch(s, first) {
    var bal = (s.bal.a < 1 || s.bal.b < 1) ? null : s.bal;
    return freshState(s.game + 1, first, s.names, s.stake, bal);
  }

  return {
    MAX: MAX, START_BAL: START_BAL, MAX_STAKE: MAX_STAKE, GOOD_SPOT: GOOD_SPOT,
    freshState: freshState, reduceMethod: reduceMethod, reduceMove: reduceMove,
    judgeMethod: judgeMethod, rollRound: rollRound, rematch: rematch
  };
});
