/* JSON 文件存档：用户、会话、任务、反馈。带防抖落盘。 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var DATA_DIR = path.join(__dirname, '..', 'data');
var DB_FILE = path.join(DATA_DIR, 'db.json');

var db = null;
var saveTimer = null;

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    db = {};
  }
  db.users = db.users || {};
  db.sessions = db.sessions || {};
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      var tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }, 300);
}

function hashPassword(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}

/* 创建用户：返回 user 对象；重名返回 null */
function createUser(name, pass) {
  var key = name.toLowerCase();
  if (db.users[key]) return null;
  var salt = crypto.randomBytes(8).toString('hex');
  var user = {
    name: name,
    salt: salt,
    passHash: pass ? hashPassword(pass, salt) : '',
    created: Date.now(),
    energy: 1000,
    avatar: 'a' + (1 + Math.floor(Math.random() * 12)),
    stats: {
      practice: { games: 0, wins: 0, losses: 0, wonE: 0, lostE: 0, points: 0 },
      arena:    { games: 0, wins: 0, losses: 0, wonE: 0, lostE: 0, points: 0 },
      master:   { games: 0, wins: 0, losses: 0, wonE: 0, lostE: 0, points: 0 }
    },
    streak: 0,
    maxStreak: 0,
    trophies: 0,
    missionsDone: 0,
    missions: { date: '', progress: {}, claimed: {} },
    feedback: []
  };
  db.users[key] = user;
  save();
  return user;
}

function getUser(name) {
  if (!name) return null;
  return db.users[String(name).toLowerCase()] || null;
}

function verifyPass(user, pass) {
  if (!user.passHash) return true; // 未设密码的账号（游客）
  return user.passHash === hashPassword(pass, user.salt);
}

function setPass(user, pass) {
  user.salt = crypto.randomBytes(8).toString('hex');
  user.passHash = hashPassword(pass, user.salt);
  save();
}

function createSession(user) {
  var token = crypto.randomBytes(16).toString('hex');
  db.sessions[token] = user.name.toLowerCase();
  save();
  return token;
}
function sessionUser(token) {
  var key = db.sessions[token];
  return key ? db.users[key] : null;
}
function dropSession(token) {
  delete db.sessions[token];
  save();
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/* 每日任务定义（与服务端结算、客户端展示共用） */
var MISSIONS = [
  { id: 'm1', mode: 'arena',  text: '竞技场连赢 3 场', goal: 3,  reward: 200, unit: '瓦' },
  { id: 'm2', mode: 'any',    text: '任意场打出 3 个炸弹', goal: 3, reward: 50,  unit: '瓦' },
  { id: 'm3', mode: 'any',    text: '完成任意 3 场对局', goal: 3,  reward: 30,  unit: '瓦' },
  { id: 'm4', mode: 'practice', text: '练习场赢 1 场', goal: 1,   reward: 20,  unit: '瓦' }
];

function ensureMissions(user) {
  var today = todayStr();
  if (user.missions.date !== today) {
    user.missions = { date: today, progress: {}, claimed: {} };
  }
  return user.missions;
}

function addMissionProgress(user, id, delta) {
  var m = ensureMissions(user);
  m.progress[id] = (m.progress[id] || 0) + delta;
  save();
}

function setMissionProgress(user, id, val) {
  var m = ensureMissions(user);
  m.progress[id] = val;
  save();
}

function claimMission(user, id) {
  var def = null;
  MISSIONS.forEach(function (m) { if (m.id === id) def = m; });
  if (!def) return { ok: false, msg: '任务不存在' };
  var m = ensureMissions(user);
  if (m.claimed[id]) return { ok: false, msg: '奖励已领取' };
  if ((m.progress[id] || 0) < def.goal) return { ok: false, msg: '任务尚未完成' };
  m.claimed[id] = 1;
  user.energy += def.reward;
  user.missionsDone++;
  save();
  return { ok: true, reward: def.reward };
}

function addFeedback(user, text) {
  user.feedback.push({ t: Date.now(), text: String(text).slice(0, 500) });
  if (user.feedback.length > 50) user.feedback.shift();
  save();
}

/* 英雄榜：5 个榜单 top10 + 自己名次 */
function leaderboard(kind, me) {
  var all = Object.keys(db.users).map(function (k) { return db.users[k]; });
  var val = function (u) {
    if (kind === 'war')     return u.stats.arena.wins + u.stats.master.wins + u.stats.practice.wins;
    if (kind === 'streak')  return u.maxStreak;
    if (kind === 'energy')  return u.energy;
    if (kind === 'trophy')  return u.trophies;
    return u.missionsDone;
  };
  var sorted = all.slice().sort(function (a, b) { return val(b) - val(a); });
  var top = sorted.slice(0, 10).map(function (u, i) {
    return { rank: i + 1, name: u.name, avatar: u.avatar, value: val(u) };
  });
  var myRank = 0, myVal = 0;
  for (var i = 0; i < sorted.length; i++) {
    if (me && sorted[i].name.toLowerCase() === me.name.toLowerCase()) { myRank = i + 1; myVal = val(me); break; }
  }
  return { top: top, myRank: myRank, myVal: myVal, myName: me ? me.name : '', myAvatar: me ? me.avatar : 'a1' };
}

load();

module.exports = {
  MISSIONS: MISSIONS,
  createUser: createUser, getUser: getUser, verifyPass: verifyPass, setPass: setPass,
  createSession: createSession, sessionUser: sessionUser, dropSession: dropSession,
  ensureMissions: ensureMissions, addMissionProgress: addMissionProgress,
  setMissionProgress: setMissionProgress, claimMission: claimMission,
  addFeedback: addFeedback, leaderboard: leaderboard,
  _db: function () { return db; }, save: save
};
