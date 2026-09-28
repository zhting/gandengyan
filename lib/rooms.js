/* 房间与对局管理：匹配、发牌、出牌回合、AI 代打、结算。 */
'use strict';
var GDY = require('./game');
var store = require('./store');

var SEAT_N = 4;
var HAND_N = 5;
var TURN_MS = 30000;          // 人类回合超时
var BOT_DELAY = [700, 1600];  // AI 出牌延迟区间
var WAIT_MS = 20000;          // 匹配等待倒计时
var OVER_MS = 8000;           // 结算后自动开下一局

var MODES = {
  practice: { label: '练习场', mult: 1,  entry: 0,  free: true, botLevel: 0 },
  arena:    { label: '竞技场', mult: 5,  entry: 5,  free: false, botLevel: 1 },
  master:   { label: '大师场', mult: 20, entry: 20, free: false, botLevel: 2 }
};

var BOT_NAMES = ['小智', '阿童木', '钢铁侠', '机械师', '星云', '铁蛋'];
var BOT_AVATARS = ['a5', 'a6', 'a7', 'a8', 'a9', 'a10'];

var rooms = new Map();      // roomId -> room
var userRoom = new Map();   // userId(lc) -> roomId
var roomSeq = 0;

function newId() { return 'R' + (++roomSeq) + Math.floor(Math.random() * 900 + 100); }

/* ---------- 房间创建 / 匹配 ---------- */

function makeBot(seatIdx, name, avatar, level) {
  return {
    userId: 'bot:' + newId(), isBot: true, name: name,
    avatar: avatar, seat: seatIdx, hand: [], connected: true, auto: false,
    playedBombs: { bomb: 0, hbomb: 0, rocket: 0 }, lastPlay: null, bubble: '',
    energy: 1000, bot: true, level: level == null ? 1 : level
  };
}

function createRoom(mode, hostUser, hostSocket) {
  var room = {
    id: newId(), mode: mode,
    seats: new Array(SEAT_N).fill(null),
    phase: 'waiting', deck: [], turn: 0, dealer: 0,
    pending: null, passes: 0, roundNo: 0, entryPot: 0,
    timer: null, deadline: 0, overTimer: null,
    countdown: WAIT_MS, waitTimer: null
  };
  rooms.set(room.id, room);
  joinRoom(room, hostUser, hostSocket);
  return room;
}

function freeSeats(room) {
  var idx = [];
  for (var i = 0; i < SEAT_N; i++) if (!room.seats[i]) idx.push(i);
  return idx;
}

function seatOf(room, userId) {
  for (var i = 0; i < SEAT_N; i++) {
    var s = room.seats[i];
    if (s && s.userId === userId) return i;
  }
  return -1;
}

function humans(room) {
  var n = 0;
  room.seats.forEach(function (s) { if (s && !s.isBot) n++; });
  return n;
}

function joinRoom(room, user, socket) {
  var uid = user.name.toLowerCase();
  var existing = seatOf(room, uid);
  if (existing >= 0) { // 重连
    room.seats[existing].connected = true;
    room.seats[existing].socket = socket;
    return existing;
  }
  var free = freeSeats(room);
  if (!free.length) return -1;
  var seatIdx = free[0];
  room.seats[seatIdx] = {
    userId: uid, isBot: false, name: user.name, avatar: user.avatar,
    seat: seatIdx, hand: [], connected: true, auto: false,
    playedBombs: { bomb: 0, hbomb: 0, rocket: 0 }, lastPlay: null, bubble: '',
    energy: user.energy, user: user, socket: socket
  };
  userRoom.set(uid, room.id);
  return seatIdx;
}

/* 进入模式：练习场直接开局；竞技/大师进入等待房（人满或超时补AI开局） */
function enterMode(user, socket, mode, cb) {
  if (!MODES[mode]) return cb({ ok: false, msg: '未知场地' });
  // 已在房间（重连/误触）直接回去
  var rid = userRoom.get(user.name.toLowerCase());
  if (rid) {
    var r0 = rooms.get(rid);
    if (r0 && r0.mode === mode) {
      var st = seatOf(r0, user.name.toLowerCase());
      if (st >= 0) {
        r0.seats[st].socket = socket;
        r0.seats[st].connected = true;
        return cb({ ok: true, room: r0, seat: st, rejoined: true });
      }
    }
    leaveRoom(user, socket); // 换了模式，离开旧房
  }

  if (mode === 'practice') {
    var room = createRoom(mode, user, socket);
    fillBots(room);
    startRound(room);
    return cb({ ok: true, room: room, seat: 0 });
  }

  // 联网匹配：找未满的等待房
  var found = null;
  rooms.forEach(function (r) {
    if (!found && r.mode === mode && r.phase === 'waiting' && humans(r) < SEAT_N &&
        seatOf(r, user.name.toLowerCase()) < 0) found = r;
  });
  var room2 = found || createRoom(mode, user, socket);
  var seat2 = joinRoom(room2, user, socket);
  if (seat2 < 0) return cb({ ok: false, msg: '房间已满，请稍后再试' });
  if (humans(room2) >= SEAT_N) { fillBots(room2); startRound(room2); }
  else ensureWaitTimer(room2);
  cb({ ok: true, room: room2, seat: seat2 });
}

function fillBots(room) {
  var start = Math.floor(Math.random() * BOT_NAMES.length);
  var lv = MODES[room.mode].botLevel;
  for (var i = 0; i < SEAT_N; i++) {
    if (!room.seats[i]) {
      var k = (start + i) % BOT_NAMES.length;
      room.seats[i] = makeBot(i, '电脑·' + BOT_NAMES[k], BOT_AVATARS[k], lv);
    }
  }
  stopWaitTimer(room);
}

function ensureWaitTimer(room) {
  if (room.waitTimer) return;
  var end = Date.now() + WAIT_MS;
  room.countdown = WAIT_MS;
  room.waitTimer = setInterval(function () {
    room.countdown = Math.max(0, end - Date.now());
    broadcastRoom(room);
    if (room.countdown <= 0) {
      stopWaitTimer(room);
      fillBots(room);
      startRound(room);
    }
  }, 500);
}
function stopWaitTimer(room) {
  if (room.waitTimer) { clearInterval(room.waitTimer); room.waitTimer = null; }
}

/* 换桌：离开当前等待房重新匹配 */
function changeTable(user, socket) {
  leaveRoom(user, socket);
}

function leaveRoom(user, socket, silentCb) {
  var uid = user.name.toLowerCase();
  var rid = userRoom.get(uid);
  if (!rid) return;
  var room = rooms.get(rid);
  userRoom.delete(uid);
  if (!room) return;
  var st = seatOf(room, uid);
  if (st < 0) return;
  var seat = room.seats[st];
  seat.socket = null;
  seat.connected = false;

  if (room.phase === 'waiting') {
    room.seats[st] = null;
    if (humans(room) === 0) destroyRoom(room);
    else broadcastRoom(room);
    return;
  }
  // 对局中离开：座位交给电脑接管
  var bot = makeBot(st, seat.name, seat.avatar, MODES[room.mode].botLevel);
  bot.name = seat.name; // 保留名字，减少跳戏
  bot.hand = seat.hand;
  bot.playedBombs = seat.playedBombs;
  bot.lastPlay = seat.lastPlay;
  bot.bubble = seat.bubble;
  room.seats[st] = bot;
  if (room.turn === st) scheduleTurn(room, true);
  broadcastRoom(room);
  pushState(room);
}

/* 断线处理：等待房移出座位；对局中交给电脑接管。
 * 仅当断开的 socket 是座位当前绑定的 socket 时才生效（重连换连接的场景会先绑新 socket）。 */
function handleDisconnect(room, seatIdx, socket) {
  var seat = room.seats[seatIdx];
  if (!seat) return;
  if (socket && seat.socket && seat.socket !== socket) return;
  seat.connected = false;
  seat.socket = null;
  if (room.phase === 'waiting') {
    room.seats[seatIdx] = null;
    if (humans(room) === 0) destroyRoom(room);
    else broadcastRoom(room);
    return;
  }
  if (room.phase === 'playing' && room.turn === seatIdx) {
    scheduleTurn(room, true); // 立刻按 AI 节奏接管
  } else {
    pushState(room);
  }
}

function destroyRoom(room) {
  stopWaitTimer(room);
  clearTimeout(room.timer);
  clearTimeout(room.overTimer);
  rooms.delete(room.id);
  room.seats.forEach(function (s) {
    if (s && !s.isBot && s.userId) {
      if (userRoom.get(s.userId) === room.id) userRoom.delete(s.userId);
    }
  });
}

/* ---------- 回合流程 ---------- */

function startRound(room) {
  room.phase = 'playing';
  room.roundNo++;
  var deck = GDY.shuffle(GDY.freshDeck());
  for (var i = 0; i < SEAT_N; i++) {
    var s = room.seats[i];
    s.hand = GDY.sortHand(deck.splice(0, HAND_N));
    s.playedBombs = { bomb: 0, hbomb: 0, rocket: 0 };
    s.lastPlay = null;
    s.bubble = '';
  }
  room.deck = deck; // 34 张
  room.dealer = room.nextDealer != null ? room.nextDealer : Math.floor(Math.random() * SEAT_N);
  room.nextDealer = null;
  room.turn = room.dealer;
  room.pending = null;
  room.passes = 0;

  // 入场费
  if (!MODES[room.mode].free) {
    room.entryPot = 0;
    room.seats.forEach(function (s) {
      var fee = Math.min(MODES[room.mode].entry, s.energy);
      s.energy -= fee;
      if (!s.isBot) { s.user.energy = Math.max(0, s.user.energy - fee); store.save(); }
      room.entryPot += fee;
    });
  } else {
    room.entryPot = 0;
  }

  pushEvent(room, { type: 'deal' });
  pushState(room);
  broadcastRoom(room);
  scheduleTurn(room, true);
}

function scheduleTurn(room, immediate) {
  clearTimeout(room.timer);
  var seat = room.seats[room.turn];
  if (!seat) return;
  var isBotTurn = seat.isBot || !seat.connected || seat.auto;
  var delay = isBotTurn
    ? (immediate ? BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]) : BOT_DELAY[1])
    : TURN_MS;
  room.deadline = Date.now() + (seat.isBot ? delay : TURN_MS);
  room.timer = setTimeout(function () { autoAct(room); }, delay);
  pushState(room);
}

function rivalMinHand(room, seatIdx) {
  var m = 99;
  for (var i = 0; i < SEAT_N; i++) {
    if (i !== seatIdx && room.seats[i]) m = Math.min(m, room.seats[i].hand.length);
  }
  return m;
}

function autoAct(room) {
  var seat = room.seats[room.turn];
  if (!seat || room.phase !== 'playing') return;
  var ctx = {
    rivalMinHand: rivalMinHand(room, room.turn),
    level: seat.level != null ? seat.level : 1
  };
  var choice = GDY.aiChoose(seat.hand, room.pending ? room.pending.combo : null, ctx);
  if (choice) doPlay(room, room.turn, choice.cards);
  else doPass(room, room.turn);
}

/* 尝试出牌（客户端请求或 AI） */
function tryPlay(room, seatIdx, cardIds) {
  var seat = room.seats[seatIdx];
  if (!seat || room.phase !== 'playing' || room.turn !== seatIdx) return { ok: false, msg: '还没轮到你' };
  // 校验所选牌都在手牌中
  var hand = seat.hand.slice();
  for (var i = 0; i < cardIds.length; i++) {
    var k = hand.indexOf(cardIds[i]);
    if (k < 0) return { ok: false, msg: '出牌不合法' };
    hand.splice(k, 1);
  }
  var combo = GDY.parseCombo(cardIds);
  if (!combo) return { ok: false, msg: '不是合法牌型' };
  if (room.pending && !GDY.beats(combo, room.pending.combo)) return { ok: false, msg: '压不上上家' };
  doPlay(room, seatIdx, cardIds);
  return { ok: true };
}

function doPlay(room, seatIdx, cardIds) {
  clearTimeout(room.timer);
  var seat = room.seats[seatIdx];
  var combo = GDY.parseCombo(cardIds);
  cardIds.forEach(function (id) {
    var k = seat.hand.indexOf(id);
    if (k >= 0) seat.hand.splice(k, 1);
  });
  seat.bubble = '';
  room.seats.forEach(function (s) { if (s) s.lastPlay = null; });
  seat.lastPlay = { combo: combo, cards: cardIds.slice() };
  if (GDY.isBombType(combo.type)) seat.playedBombs[combo.type]++;
  room.pending = { seat: seatIdx, combo: combo };
  room.passes = 0;

  pushEvent(room, {
    type: GDY.isBombType(combo.type) ? 'bomb' : 'play',
    seat: seatIdx, cards: cardIds.slice(), combo: combo
  });

  if (seat.hand.length === 0) return endRound(room, seatIdx);
  room.turn = (seatIdx + 1) % SEAT_N;
  scheduleTurn(room, true);
}

function tryPass(room, seatIdx) {
  if (room.phase !== 'playing' || room.turn !== seatIdx) return { ok: false, msg: '还没轮到你' };
  if (!room.pending) return { ok: false, msg: '你是首家，必须出牌' };
  doPass(room, seatIdx);
  return { ok: true };
}

function doPass(room, seatIdx) {
  clearTimeout(room.timer);
  var seat = room.seats[seatIdx];
  seat.bubble = '要不起';
  var drew = 0;
  if (room.deck.length) { seat.hand.push(room.deck.pop()); drew = 1; }
  seat.hand = GDY.sortHand(seat.hand);
  room.passes++;

  pushEvent(room, { type: 'pass', seat: seatIdx, drew: drew });

  if (room.passes >= SEAT_N - 1) {
    // 一圈都不要：清空牌桌，由最后出牌者领出
    var leader = room.pending ? room.pending.seat : seatIdx;
    room.seats.forEach(function (s) { if (s) s.lastPlay = null; });
    room.pending = null;
    room.passes = 0;
    room.turn = leader;
  } else {
    room.turn = (seatIdx + 1) % SEAT_N;
  }
  scheduleTurn(room, true);
}

/* ---------- 结算 ---------- */

function endRound(room, winnerIdx) {
  clearTimeout(room.timer);
  room.phase = 'over';
  room.pending = null;
  var M = MODES[room.mode];
  var wSeat = room.seats[winnerIdx];
  var pb = wSeat.playedBombs;
  var results = [];
  var totalPot = room.entryPot;

  // 输家赔付
  var payments = 0;
  room.seats.forEach(function (s, i) {
    var remain = s.hand.length;
    var delta = 0;
    if (i !== winnerIdx && !M.free) {
      var pay = (remain + 2 * pb.bomb + 4 * pb.hbomb + 8 * pb.rocket) * M.mult;
      pay = Math.min(pay, Math.max(0, s.energy));
      delta = -pay;
      s.energy -= pay;
      payments += pay;
      if (!s.isBot) { s.user.energy = Math.max(0, s.user.energy - pay); }
    }
    results.push({ seat: i, remain: remain, delta: delta, win: i === winnerIdx });
  });
  // 赢家收底池 + 全部赔付
  if (!M.free) {
    results[winnerIdx].delta = totalPot + payments;
    wSeat.energy += totalPot + payments;
    if (!wSeat.isBot) { wSeat.user.energy += totalPot + payments; }
  }
  store.save();

  // 统计 / 积分 / 任务（异常不阻断对局）
  room.seats.forEach(function (s, i) {
    if (s.isBot) return;
    try {
      var u = s.user;
      var st = u.stats[room.mode] || (u.stats[room.mode] = { games: 0, wins: 0, losses: 0, wonE: 0, lostE: 0, points: 0 });
      var win = i === winnerIdx;
      st.games++;
      if (win) {
        st.wins++;
        st.wonE += Math.max(0, results[i].delta);
        st.points += 100;
        u.streak++;
        u.maxStreak = Math.max(u.maxStreak, u.streak);
        if (room.mode !== 'practice') u.trophies++;
        store.addMissionProgress(u, 'm3', 1);
        if (room.mode === 'arena') store.addMissionProgress(u, 'm1', 1);
        if (room.mode === 'practice') store.addMissionProgress(u, 'm4', 1);
      } else {
        st.losses++;
        st.lostE += Math.max(0, -results[i].delta);
        st.points = Math.max(0, st.points - 50);
        u.streak = 0;
        if (room.mode === 'arena') store.setMissionProgress(u, 'm1', 0);
        store.addMissionProgress(u, 'm3', 1);
      }
      store.addMissionProgress(u, 'm2', s.playedBombs.bomb + s.playedBombs.hbomb + s.playedBombs.rocket);
    } catch (e) {
      console.error('[rooms] stat update failed:', e.message);
    }
  });

  room.nextDealer = winnerIdx;
  room.lastResult = {
    winner: winnerIdx, results: results, bombs: pb, mode: room.mode,
    mult: M.mult, free: M.free
  };
  pushEvent(room, { type: 'over', winner: winnerIdx });
  pushState(room);
  broadcastRoom(room);

  room.overTimer = setTimeout(function () {
    if (rooms.has(room.id) && humans(room) > 0) {
      // 有人退出留下的空位补电脑
      fillBots(room);
      startRound(room);
    } else if (rooms.has(room.id)) {
      destroyRoom(room);
    }
  }, OVER_MS);
}

/* ---------- 状态快照（按座位裁剪隐私） ---------- */

function publicSeat(room, s, i, viewerIdx) {
  return {
    seat: i, name: s.name, avatar: s.avatar, isBot: !!s.isBot,
    connected: s.connected, auto: !!s.auto,
    count: s.hand.length,
    lastPlay: s.lastPlay,
    bubble: s.bubble,
    dealer: room.dealer === i,
    hand: i === viewerIdx ? GDY.sortHand(s.hand) : undefined,
    energy: i === viewerIdx ? s.energy : undefined
  };
}

function stateFor(room, viewerIdx) {
  return {
    roomId: room.id, mode: room.mode, modeLabel: MODES[room.mode].label,
    mult: MODES[room.mode].mult, free: MODES[room.mode].free,
    phase: room.phase, roundNo: room.roundNo,
    deckCount: room.deck.length,
    turn: room.turn, deadline: room.deadline,
    pending: room.pending,
    seats: room.seats.map(function (s, i) {
      if (!s) return null;
      return publicSeat(room, s, i, viewerIdx);
    }),
    result: room.phase === 'over' ? room.lastResult : null,
    countdown: room.phase === 'waiting' ? room.countdown : null
  };
}

/* ---------- 推送 ---------- */

// 每个 socket 注册这三个回调（由 server.js 注入）
var hooks = { send: null, broadcast: null, sendRoom: null };

function pushState(room) {
  room.seats.forEach(function (s, i) {
    if (s && !s.isBot && s.socket && s.socket.emit) {
      s.socket.emit('g', { room: room.id, seat: i, state: stateFor(room, i) });
    }
  });
}
function pushEvent(room, evt) {
  room.seats.forEach(function (s) {
    if (s && !s.isBot && s.socket && s.socket.emit) s.socket.emit('evt', evt);
  });
}
function broadcastRoom(room) {
  room.seats.forEach(function (s, i) {
    if (s && !s.isBot && s.socket && s.socket.emit) {
      s.socket.emit('r', {
        room: room.id, mode: room.mode, phase: room.phase,
        countdown: room.countdown,
        seats: room.seats.map(function (x, j) {
          return x ? { seat: j, name: x.name, avatar: x.avatar, isBot: !!x.isBot, connected: x.connected } : null;
        })
      });
    }
  });
}

module.exports = {
  MODES: MODES, SEAT_N: SEAT_N,
  enterMode: enterMode, leaveRoom: leaveRoom, changeTable: changeTable,
  tryPlay: tryPlay, tryPass: tryPass,
  handleDisconnect: handleDisconnect,
  stateFor: stateFor, pushState: pushState, broadcastRoom: broadcastRoom,
  userRoom: userRoom, rooms: rooms
};
