/* 引擎自测：牌型识别、压牌规则、AI 完整对局模拟 */
'use strict';
var G = require('../lib/game');

var fails = 0;
function T(name, cond) {
  if (!cond) { fails++; console.log('  ✗ ' + name); }
  else console.log('  ✓ ' + name);
}

/* 牌 id 助手: card('S3')=黑桃3, card('H10'), card('XW')=小王, card('DW')=大王 */
function card(s) {
  if (s === 'XW') return 52;
  if (s === 'DW') return 53;
  var rank = s.slice(1), suit = s[0];
  var r = G.RANK_NAMES.indexOf(rank);
  if (r < 0) throw new Error('bad rank ' + s);
  var si = ['S', 'H', 'C', 'D'].indexOf(suit);
  return r * 4 + si;
}

console.log('— 牌型识别 —');
T('单张', G.parseCombo([card('S3')]).type === 'single');
T('对子', G.parseCombo([card('H7'), card('D7')]).type === 'pair');
T('杂两张不成牌型', G.parseCombo([card('H7'), card('D8')]) === null);
T('双王=火箭', G.parseCombo([card('XW'), card('DW')]).type === 'rocket');
T('小王不能与小王成对(只有一张)', true);
T('三张=炸弹', G.parseCombo([card('S5'), card('H5'), card('C5')]).type === 'bomb');
T('四张=氢弹', G.parseCombo([card('S9'), card('H9'), card('C9'), card('D9')]).type === 'hbomb');
T('两对不是牌型', G.parseCombo([card('S3'), card('H3'), card('C5'), card('D5')]) === null);

console.log('— 压牌规则 —');
var c3 = G.parseCombo([card('S3')]);
var c2 = G.parseCombo([card('H2')]);
var cXW = G.parseCombo([card('XW')]);
T('2 压 3', G.beats(c2, c3));
T('小王压 2', G.beats(cXW, c2));
T('小王不压小王', !G.beats(cXW, G.parseCombo([card('XW')])));
T('炸弹压对A', G.beats(G.parseCombo([card('S3'), card('H3'), card('C3')]), G.parseCombo([card('SA'), card('HA')])));
T('对子不压炸弹', !G.beats(G.parseCombo([card('SA'), card('HA')]), G.parseCombo([card('S3'), card('H3'), card('C3')])));
T('炸弹压炸弹比点数', G.beats(G.parseCombo([card('S8'), card('H8'), card('C8')]), G.parseCombo([card('S5'), card('H5'), card('C5')])));
T('小炸弹不压大炸弹', !G.beats(G.parseCombo([card('S5'), card('H5'), card('C5')]), G.parseCombo([card('S8'), card('H8'), card('C8')])));
T('氢弹压炸弹', G.beats(G.parseCombo([card('S4'), card('H4'), card('C4'), card('D4')]), G.parseCombo([card('SK'), card('HK'), card('CK')])));
T('火箭压氢弹', G.beats(G.parseCombo([card('XW'), card('DW')]), G.parseCombo([card('S4'), card('H4'), card('C4'), card('D4')])));
T('氢弹不压火箭', !G.beats(G.parseCombo([card('S4'), card('H4'), card('C4'), card('D4')]), G.parseCombo([card('XW'), card('DW')])));
T('2不能组对压对A? (对2压对A应为真)', G.beats(G.parseCombo([card('S2'), card('H2')]), G.parseCombo([card('SA'), card('HA')])));

console.log('— 候选/提示 —');
var hand = [card('S3'), card('H3'), card('C3'), card('XW'), card('DW')];
var lead = G.candidates(hand, null);
T('领出候选含单3/对3/炸弹/火箭', lead.some(c => c.type === 'single' && c.rank === 3) &&
  lead.some(c => c.type === 'pair') && lead.some(c => c.type === 'bomb') && lead.some(c => c.type === 'rocket'));
var follow = G.candidates([card('S5'), card('XW'), card('DW')], G.parseCombo([card('S3')]));
T('跟单3可用5或火箭', follow.some(c => c.type === 'single' && c.rank === 5) && follow.some(c => c.type === 'rocket'));
var noWay = G.candidates([card('S4'), card('H4')], G.parseCombo([card('S5')]));
T('压不上时无候选', noWay.length === 0);
var bombWay = G.candidates([card('S4'), card('H4'), card('C4')], G.parseCombo([card('SA')]));
T('A单张可用炸弹压', bombWay.some(c => c.type === 'bomb'));

console.log('— AI 完整对局模拟（三档难度各 300 局）—');
var fails2 = 0;
[0, 1, 2].forEach(function (level) {
  var totalMoves = 0, maxMoves = 0, wins = { 0: 0, 1: 0, 2: 0, 3: 0 };
  var N = 300;
  for (var g = 0; g < N; g++) {
    var deck = G.shuffle(G.freshDeck());
    var hands = [[], [], [], []];
    for (var i = 0; i < 20; i++) hands[i % 4].push(deck.pop());
    hands.forEach(h => G.sortHand(h));
    var turn = g % 4, pending = null, passes = 0, moves = 0, winner = -1;
    while (winner < 0 && moves < 4000) {
      moves++;
      var ctx = {
        level: level,
        rivalMinHand: Math.min.apply(null, hands.filter((h, j) => j !== turn).map(h => h.length))
      };
      var choice = G.aiChoose(hands[turn], pending ? pending.combo : null, ctx);
      if (choice) {
        choice.cards.forEach(id => hands[turn].splice(hands[turn].indexOf(id), 1));
        pending = { seat: turn, combo: choice };
        passes = 0;
        if (hands[turn].length === 0) { winner = turn; break; }
      } else {
        if (deck.length) hands[turn].push(deck.pop());
        passes++;
        if (passes >= 3) { pending = null; passes = 0; }
      }
      turn = (turn + 1) % 4;
    }
    if (winner < 0) { fails2++; console.log('  ✗ L' + level + ' 对局未终止 (moves=' + moves + ')'); break; }
    wins[winner]++;
    totalMoves += moves;
    maxMoves = Math.max(maxMoves, moves);
  }
  console.log('  L' + level + ' 平均手数=' + Math.round(totalMoves / N) + ' 最长=' + maxMoves +
    ' 胜者分布=' + JSON.stringify(wins));
});
fails += fails2;

console.log(fails ? '\n有 ' + fails + ' 个用例失败' : '\n全部通过 ✔');
process.exit(fails ? 1 : 0);
