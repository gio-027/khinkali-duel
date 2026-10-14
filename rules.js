/* ხინკლის დუელის წესები. ერთი და იგივე ფაილი მუშაობს სერვერზეც და ბრაუზერშიც. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 5;

  function freshState(game, first, names) {
    return {
      game: game,
      n: 0,
      hp: { a: MAX, b: MAX },
      shield: { a: false, b: false },
      turn: first,
      over: null,
      names: names,
      ev: null
    };
  }

  /* act: 'bite' | 'defend' | 'risky'; roll: 0 <= roll < 1.
     აბრუნებს ახალ მდგომარეობას ან null-ს, თუ სვლა დაუშვებელია. */
  function reduceMove(s, act, roll) {
    var who = s.turn;
    var opp = who === 'a' ? 'b' : 'a';
    var hp = { a: s.hp.a, b: s.hp.b };
    var shield = { a: s.shield.a, b: s.shield.b };
    var kind;
    var dmg = 0;

    if (s.over) return null;

    if (act === 'defend') {
      if (shield[who]) return null;
      shield[who] = true;
      kind = 'defend';
    } else if (act === 'bite' || act === 'risky') {
      dmg = act === 'bite' ? 1 : (roll < 0.5 ? 2 : 0);
      if (dmg === 0) {
        kind = 'risky_miss';
      } else if (shield[opp]) {
        shield[opp] = false;
        kind = 'blocked';
        dmg = 0;
      } else {
        hp[opp] = Math.max(0, hp[opp] - dmg);
        kind = act === 'bite' ? 'bite' : 'risky_hit';
      }
    } else {
      return null;
    }

    var over = hp[opp] === 0 ? who : null;
    return {
      game: s.game,
      n: s.n + 1,
      hp: hp,
      shield: shield,
      turn: over ? who : opp,
      over: over,
      names: s.names,
      ev: { who: who, kind: kind, dmg: dmg }
    };
  }

  return { MAX: MAX, freshState: freshState, reduceMove: reduceMove };
});
