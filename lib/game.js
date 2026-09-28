/* =====================================================================
 * 干瞪眼 · 星际版 — 规则引擎（服务端与浏览器共用）
 *
 * 牌的编码：整数 0..53
 *   0..51 : 3,4,5,6,7,8,9,10,J,Q,K,A,2 各 4 花色 (♠♥♣♦)
 *   52    : 小王   53 : 大王
 * 点数序：3 < 4 < ... < K < A < 2 < 小王 < 大王
 *
 * 牌型：
 *   single  单张          pair    对子（双王不算对子，是火箭）
 *   bomb    炸弹 = 三张相同  hbomb  氢弹 = 四张相同
 *   rocket  火箭 = 大王+小王（最大）
 * 压牌规则：同级比点数；炸弹压一切非炸弹；氢弹压炸弹；火箭最大。
 * 流程：每人 5 张，轮流出牌，压不上（或不想压）摸一张牌过。
 *       一圈都不要则由最后出牌者重新领出。先出完者胜。
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GDY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['\u2660', '\u2665', '\u2663', '\u2666']; // ♠ ♥ ♣ ♦
  var RANK_NAMES = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
  var RED = [1, 3]; // ♥ ♦

  function rankOf(id) {
    if (id === 52) return 16;      // 小王
    if (id === 53) return 17;      // 大王
    return 3 + (id >> 2);          // 3..15 (2 = 15)
  }
  function suitOf(id) { return id < 52 ? (id & 3) : -1; }
  function isRed(id) { return RED.indexOf(suitOf(id)) >= 0; }
  function rankName(id) {
    var r = rankOf(id);
    if (r === 16) return '小王';
    if (r === 17) return '大王';
    return RANK_NAMES[r - 3];
  }
  function suitChar(id) { return suitOf(id) < 0 ? '' : SUITS[suitOf(id)]; }

  function freshDeck() {
    var d = [];
    for (var i = 0; i < 54; i++) d.push(i);
    return d;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sortHand(hand) { // 小→大；同点数黑红梅方
    return hand.slice().sort(function (a, b) {
      var ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return suitOf(a) - suitOf(b);
    });
  }

  /* ---------- 牌型识别：cards 为若干牌 id，合法返回 {type,rank,n,cards}，否则 null ---------- */
  function parseCombo(cards) {
    var n = cards.length;
    if (!n) return null;
    var ranks = cards.map(rankOf);
    var r0 = ranks[0], same = true, i;
    for (i = 1; i < n; i++) if (ranks[i] !== r0) { same = false; break; }

    if (n === 1) return { type: 'single', rank: r0, n: 1, cards: cards.slice() };
    if (n === 2) {
      if (r0 === 16 && ranks[1] === 17) return { type: 'rocket', rank: 99, n: 2, cards: cards.slice() };
      if (same) return { type: 'pair', rank: r0, n: 2, cards: cards.slice() };
      return null;
    }
    if (same && n === 3) return { type: 'bomb', rank: r0, n: 3, cards: cards.slice() };
    if (same && n === 4) return { type: 'hbomb', rank: r0, n: 4, cards: cards.slice() };
    return null;
  }

  var TIER = { single: 0, pair: 0, bomb: 1, hbomb: 2, rocket: 3 };
  function beats(a, b) { // a 能压 b?
    if (!a || !b) return false;
    var ta = TIER[a.type], tb = TIER[b.type];
    if (ta !== tb) return ta > tb;
    return a.rank > b.rank;
  }
  function comboName(c) {
    if (!c) return '';
    if (c.type === 'single') return '单张 ' + rankName(c.cards[0]);
    if (c.type === 'pair') return '对子 ' + rankName(c.cards[0]);
    if (c.type === 'bomb') return '炸弹 ' + rankName(c.cards[0]);
    if (c.type === 'hbomb') return '氢弹 ' + rankName(c.cards[0]);
    if (c.type === 'rocket') return '火 箭';
    return '';
  }
  function isBombType(t) { return t === 'bomb' || t === 'hbomb' || t === 'rocket'; }

  /* ---------- 候选牌型生成（提示 / AI / 记牌辅助） ----------
   * pending 为 null 表示领出。返回按“从小到大”排序的合法牌型数组。 */
  function candidates(hand, pending) {
    var res = [];
    var byRank = {}; // rank -> [cards]
    hand.forEach(function (id) {
      var r = rankOf(id);
      (byRank[r] = byRank[r] || []).push(id);
    });
    var rocket = (byRank[16] && byRank[16].length) && (byRank[17] && byRank[17].length)
      ? parseCombo([byRank[16][0], byRank[17][0]]) : null;

    function pushBombs() { // 炸弹/氢弹总能压（领出也可直接出）
      Object.keys(byRank).forEach(function (k) {
        var cs = byRank[k];
        if (cs.length >= 3) res.push(parseCombo(cs.slice(0, 3)));
        if (cs.length >= 4) res.push(parseCombo(cs.slice(0, 4)));
      });
      if (rocket) res.push(rocket);
    }

    if (!pending) {
      // 领出：单张、对子、炸弹、氢弹、火箭
      Object.keys(byRank).forEach(function (k) {
        var cs = byRank[k];
        res.push(parseCombo([cs[0]]));
        if (cs.length >= 2) res.push(parseCombo(cs.slice(0, 2)));
      });
      pushBombs();
    } else {
      var t = pending.type;
      if (t === 'single' || t === 'pair') {
        Object.keys(byRank).forEach(function (k) {
          var r = +k, cs = byRank[k];
          if (r > pending.rank) {
            if (t === 'single') res.push(parseCombo([cs[0]]));
            else if (cs.length >= 2) res.push(parseCombo(cs.slice(0, 2)));
          }
        });
        pushBombs();
      } else if (t === 'bomb') {
        Object.keys(byRank).forEach(function (k) {
          var r = +k, cs = byRank[k];
          if (r > pending.rank && cs.length >= 3) res.push(parseCombo(cs.slice(0, 3)));
        });
        // 氢弹、火箭可压炸弹
        Object.keys(byRank).forEach(function (k) {
          var cs = byRank[k];
          if (cs.length >= 4) res.push(parseCombo(cs.slice(0, 4)));
        });
        if (rocket) res.push(rocket);
      } else if (t === 'hbomb') {
        Object.keys(byRank).forEach(function (k) {
          var r = +k, cs = byRank[k];
          if (r > pending.rank && cs.length >= 4) res.push(parseCombo(cs.slice(0, 4)));
        });
        if (rocket) res.push(rocket);
      } // rocket: 无解
    }
    return res.filter(Boolean).sort(function (a, b) {
      var ta = TIER[a.type], tb = TIER[b.type];
      if (ta !== tb) return ta - tb;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.n - b.n;
    });
  }

  /* ---------- AI（三档难度：0 新手 / 1 普通 / 2 高手） ---------- */
  function aiChoose(hand, pending, ctx) {
    ctx = ctx || {};
    var level = ctx.level == null ? 1 : ctx.level;
    var cands = candidates(hand, pending);
    if (!cands.length) return null;

    // 手牌能一次出完就直接出
    var whole = parseCombo(sortHand(hand));
    if (!pending && whole && whole.cards.length === hand.length) return whole;

    if (!pending) {
      var nonBomb = cands.filter(function (c) { return !isBombType(c.type); });
      var pool = nonBomb.length ? nonBomb : cands;
      var singles = pool.filter(function (c) { return c.type === 'single'; });
      var pick = singles.length ? singles[0] : pool[0];
      // 高手：有人只剩 1 张时不送小单张，改出对子或最大单张
      if (level >= 2 && ctx.rivalMinHand != null && ctx.rivalMinHand <= 1) {
        var pairs = pool.filter(function (c) { return c.type === 'pair'; });
        if (pairs.length) return pairs[0];
        if (singles.length) return singles[singles.length - 1];
      }
      // 新手偶尔随机出牌
      if (level === 0 && Math.random() < 0.15 && pool.length > 1) {
        return pool[Math.floor(Math.random() * Math.min(3, pool.length))];
      }
      return pick;
    }

    // 跟牌：能压就压最小的；高手优先整组出（不拆对子/炸弹）
    var normal = cands.filter(function (c) { return !isBombType(c.type); });
    if (normal.length) {
      if (level >= 2) {
        var byRank = {};
        hand.forEach(function (id) {
          var r = rankOf(id);
          (byRank[r] = byRank[r] || []).push(id);
        });
        var tidy = normal.filter(function (c) {
          var group = byRank[c.rank] || [];
          return group.length <= c.n;
        });
        if (tidy.length) return tidy[0];
      }
      return normal[0];
    }
    // 只剩炸弹能压：对手快出完必须压，否则按档位概率动用
    var threat = ctx.rivalMinHand != null && ctx.rivalMinHand <= 2;
    var bombs = cands.filter(function (c) { return isBombType(c.type); });
    if (bombs.length) {
      if (threat) return bombs[0];
      var chance = level === 2 ? 0.35 : level === 1 ? 0.25 : 0.08;
      if (Math.random() < chance) return bombs[0];
    }
    return null; // 摸牌过
  }

  /* ---------- 记牌器：各点数剩余可见数（含自己手牌与已出牌之外的未知牌） ---------- */
  function counterRanks(seenIds) {
    var seen = {};
    seenIds.forEach(function (id) { seen[id] = 1; });
    var out = [];
    for (var r = 3; r <= 15; r++) {
      var cnt = 4;
      for (var s = 0; s < 4; s++) if (seen[(r - 3) * 4 + s]) cnt--;
      out.push({ rank: r, name: RANK_NAMES[r - 3], left: cnt });
    }
    out.push({ rank: 16, name: '小王', left: seen[52] ? 0 : 1 });
    out.push({ rank: 17, name: '大王', left: seen[53] ? 0 : 1 });
    return out;
  }

  return {
    SUITS: SUITS, RANK_NAMES: RANK_NAMES,
    rankOf: rankOf, suitOf: suitOf, isRed: isRed,
    rankName: rankName, suitChar: suitChar,
    freshDeck: freshDeck, shuffle: shuffle, sortHand: sortHand,
    parseCombo: parseCombo, beats: beats, comboName: comboName, isBombType: isBombType,
    candidates: candidates, aiChoose: aiChoose, counterRanks: counterRanks,
    TIER: TIER
  };
});
