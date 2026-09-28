/* 干瞪眼 · 星际版 — 服务端入口
 * Express 提供静态页面；Socket.IO 处理登录、匹配、对局。 */
'use strict';
var path = require('path');
var http = require('http');
var express = require('express');
var io = require('socket.io')();

var store = require('./lib/store');
var rooms = require('./lib/rooms');

var PORT = process.env.PORT || 3000;

// 对局服务容错：定时器回调里的未捕获异常只记日志，不整服退出
process.on('uncaughtException', function (err) {
  console.error('[server] uncaughtException:', err);
});

var app = express();
app.use(express.static(path.join(__dirname, 'public')));
// 规则引擎同一份代码供浏览器使用
app.get('/js/game-shared.js', function (req, res) {
  res.sendFile(path.join(__dirname, 'lib', 'game.js'));
});
app.get('/logo.png', function (req, res) {
  res.sendFile(path.join(__dirname, '设计稿', 'logo512.png'));
});

var server = http.createServer(app);
io.attach(server, { cors: { origin: '*' } });

/* 每个 socket 的用户上下文 */
io.on('connection', function (socket) {
  var ctx = { user: null, token: null };

  function ok(event, data) { socket.emit(event, data); }

  function userPayload(u) {
    return {
      name: u.name, avatar: u.avatar, energy: u.energy,
      stats: u.stats, streak: u.streak, maxStreak: u.maxStreak,
      trophies: u.trophies, missionsDone: u.missionsDone,
      missions: store.ensureMissions(u)
    };
  }

  /* ---- 登录 / 注册 / 游客 / 会话恢复 ---- */
  socket.on('login', function (data) {
    data = data || {};
    var name = String(data.name || '').trim().slice(0, 12);
    var pass = String(data.pass || '');
    if (data.guest || !name) {
      name = '用户' + Math.floor(100000 + Math.random() * 899999);
      while (store.getUser(name)) name = '用户' + Math.floor(100000 + Math.random() * 899999);
      var guest = store.createUser(name, '');
      ctx.user = guest; ctx.token = store.createSession(guest);
      return ok('login', { ok: true, token: ctx.token, user: userPayload(guest), fresh: true });
    }
    var existing = store.getUser(name);
    if (existing) {
      if (!store.verifyPass(existing, pass)) return ok('login', { ok: false, msg: '密码错误' });
      ctx.user = existing; ctx.token = store.createSession(existing);
      return ok('login', { ok: true, token: ctx.token, user: userPayload(existing) });
    }
    if (name.length < 2) return ok('login', { ok: false, msg: '用户名至少 2 个字符' });
    var fresh = store.createUser(name, pass);
    ctx.user = fresh; ctx.token = store.createSession(fresh);
    ok('login', { ok: true, token: ctx.token, user: userPayload(fresh), fresh: true });
  });

  socket.on('auth', function (data) {
    var u = store.sessionUser(data && data.token);
    if (!u) return ok('auth', { ok: false });
    ctx.user = u; ctx.token = data.token;
    ok('auth', { ok: true, user: userPayload(u) });
    // 若正在房间中（断线重连），立即推送房间与对局状态
    var rid = rooms.userRoom.get(u.name.toLowerCase());
    var room = rid && rooms.rooms.get(rid);
    if (room) {
      var seatIdx = -1;
      for (var i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && room.seats[i].userId === u.name.toLowerCase()) seatIdx = i;
      }
      if (seatIdx >= 0) {
        room.seats[seatIdx].connected = true;
        room.seats[seatIdx].socket = socket;
        socket.emit('g', { room: room.id, seat: seatIdx, state: rooms.stateFor(room, seatIdx) });
        rooms.broadcastRoom(room);
      }
    }
  });

  socket.on('logout', function () {
    if (ctx.user) rooms.leaveRoom(ctx.user, socket);
    if (ctx.token) store.dropSession(ctx.token);
    ctx.user = null; ctx.token = null;
    ok('logout', { ok: true });
  });

  /* ---- 进入 / 离开房间 ---- */
  socket.on('enter', function (data, cb) {
    if (!ctx.user) return ok('err', { msg: '请先登录' });
    rooms.enterMode(ctx.user, socket, data && data.mode, function (res) {
      if (!res.ok) return cb ? cb(res) : ok('err', res);
      if (cb) cb({ ok: true, phase: res.room.phase, state: rooms.stateFor(res.room, res.seat) });
      rooms.pushState(res.room);
      rooms.broadcastRoom(res.room);
    });
  });

  socket.on('leaveRoom', function () {
    if (ctx.user) rooms.leaveRoom(ctx.user, socket);
  });

  socket.on('changeTable', function () {
    if (!ctx.user) return;
    rooms.changeTable(ctx.user, socket);
    // 换桌 = 回到匹配队列，客户端随后再发 enter
  });

  /* ---- 对局操作 ---- */
  socket.on('play', function (data, cb) {
    if (!ctx.user) return;
    var rid = rooms.userRoom.get(ctx.user.name.toLowerCase());
    var room = rid && rooms.rooms.get(rid);
    if (!room) return cb && cb({ ok: false, msg: '不在对局中' });
    var seatIdx = -1;
    for (var i = 0; i < room.seats.length; i++) {
      if (room.seats[i] && room.seats[i].userId === ctx.user.name.toLowerCase()) seatIdx = i;
    }
    var res = rooms.tryPlay(room, seatIdx, (data && data.cards) || []);
    if (cb) cb(res);
    // 状态推送已由 tryPlay→doPlay→scheduleTurn 完成，这里不再重复推送（避免打断飞牌动画）
  });

  socket.on('pass', function (data, cb) {
    if (!ctx.user) return;
    var rid = rooms.userRoom.get(ctx.user.name.toLowerCase());
    var room = rid && rooms.rooms.get(rid);
    if (!room) return cb && cb({ ok: false, msg: '不在对局中' });
    var seatIdx = -1;
    for (var i = 0; i < room.seats.length; i++) {
      if (room.seats[i] && room.seats[i].userId === ctx.user.name.toLowerCase()) seatIdx = i;
    }
    var res = rooms.tryPass(room, seatIdx);
    if (cb) cb(res);
  });

  socket.on('auto', function (data) {
    if (!ctx.user) return;
    var rid = rooms.userRoom.get(ctx.user.name.toLowerCase());
    var room = rid && rooms.rooms.get(rid);
    if (!room) return;
    var seatIdx = seatIndexOf(room, ctx.user.name.toLowerCase());
    if (seatIdx < 0) return;
    room.seats[seatIdx].auto = !!(data && data.on);
    rooms.pushState(room);
  });

  function seatIndexOf(room, userId) {
    for (var i = 0; i < room.seats.length; i++) {
      if (room.seats[i] && room.seats[i].userId === userId) return i;
    }
    return -1;
  }

  /* ---- 个人相关 ---- */
  socket.on('syncUser', function (cb) {
    if (!ctx.user) return;
    if (cb) cb({ ok: true, user: userPayload(ctx.user) });
  });

  socket.on('setAvatar', function (data) {
    if (!ctx.user) return;
    var a = String((data && data.avatar) || '');
    if (/^a([1-9]|1[0-2])$/.test(a)) { ctx.user.avatar = a; store.save(); }
    ok('syncUser', { ok: true, user: userPayload(ctx.user) });
  });

  socket.on('randomAvatar', function () {
    if (!ctx.user) return;
    ctx.user.avatar = 'a' + (1 + Math.floor(Math.random() * 12));
    store.save();
    ok('syncUser', { ok: true, user: userPayload(ctx.user) });
  });

  socket.on('leaderboard', function (data, cb) {
    if (!ctx.user) return;
    var kinds = ['war', 'streak', 'energy', 'trophy', 'mission'];
    var kind = kinds.indexOf(data && data.kind) >= 0 ? data.kind : 'war';
    if (cb) cb({ ok: true, kind: kind, data: store.leaderboard(kind, ctx.user) });
  });

  socket.on('claimMission', function (data, cb) {
    if (!ctx.user) return;
    var res = store.claimMission(ctx.user, data && data.id);
    if (cb) cb(res);
    if (res.ok) ok('syncUser', { ok: true, user: userPayload(ctx.user) });
  });

  socket.on('feedback', function (data) {
    if (!ctx.user) return;
    var text = String((data && data.text) || '').trim();
    if (text) store.addFeedback(ctx.user, text);
  });

  /* ---- 断线 ---- */
  socket.on('disconnect', function () {
    if (!ctx.user) return;
    var rid = rooms.userRoom.get(ctx.user.name.toLowerCase());
    var room = rid && rooms.rooms.get(rid);
    if (!room) return;
    var seatIdx = seatIndexOf(room, ctx.user.name.toLowerCase());
    if (seatIdx < 0) return;
    rooms.handleDisconnect(room, seatIdx, socket);
  });
});

server.listen(PORT, function () {
  console.log('========================================================');
  console.log('  干瞪眼 · 星际版  已启动:  http://localhost:' + PORT);
  console.log('  局域网对战: 用手机浏览器访问  http://<本机IP>:' + PORT);
  console.log('========================================================');
});
