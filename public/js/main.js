/* 主逻辑：路由、socket、各页面与弹窗 */
(function () {
  'use strict';
  var UI = window.UI, GDY = window.GDY, Sound = window.Sound;
  var $ = UI.$;

  /* ================= 全局状态 ================= */
  var App = {
    socket: null,
    // 优先读每标签页独立的 sessionStorage，避免同浏览器多标签互相覆盖账号
    token: (function () {
      try { return sessionStorage.getItem('gdg_token') || localStorage.getItem('gdg_token') || ''; }
      catch (e) { return localStorage.getItem('gdg_token') || ''; }
    })(),
    user: null,
    seat: -1, state: null,        // 当前对局快照（针对自己裁剪）
    waitInfo: null,               // 等待房信息
    selected: [],                 // 已选手牌
    hintList: [], hintIdx: 0,
    auto: false, counterOn: false,
    seenIds: [],                  // 本局已出现的牌（记牌器）
    resultShownRound: -1,
    tickLast: -1,
    inBattle: false
  };

  function saveToken(t) {
    App.token = t;
    try { localStorage.setItem('gdg_token', t); sessionStorage.setItem('gdg_token', t); } catch (e) {}
  }

  var SCREENS = ['scr-splash', 'scr-login', 'scr-loading', 'scr-home', 'scr-waiting', 'scr-battle'];
  function showScreen(id) {
    SCREENS.forEach(function (s) {
      document.getElementById(s).classList.toggle('active', s === id);
    });
    App.inBattle = id === 'scr-battle';
  }

  /* ================= Socket ================= */
  function connect() {
    App.socket = io();
    var sk = App.socket;

    sk.on('login', function (res) {
      if (!res.ok) { UI.toast(res.msg || '登录失败'); return; }
      saveToken(res.token);
      App.user = res.user;
      gotoLoading();
    });

    sk.on('auth', function (res) {
      if (!res.ok) { try { localStorage.removeItem('gdg_token'); sessionStorage.removeItem('gdg_token'); } catch (e) {} showScreen('scr-login'); return; }
      App.user = res.user;
      gotoLoading();
    });

    sk.on('syncUser', function (res) {
      if (res && res.ok) { App.user = res.user; if (App.inHome()) renderHomeUser(); }
    });

    sk.on('r', function (info) { onRoomInfo(info); });
    sk.on('g', function (p) { onGameState(p); });
    sk.on('evt', function (e) { onGameEvent(e); });
    sk.on('err', function (e) { UI.toast((e && e.msg) || '出错了'); });

    sk.on('disconnect', function () {
      if (App.token) UI.toast('连接断开，正在重连…');
    });
    // socket.io v4 重连成功后触发的是 connect（非 reconnect），需重新认证恢复会话
    var everConnected = false;
    sk.on('connect', function () {
      if (everConnected && App.token) {
        sk.emit('auth', { token: App.token });
      }
      everConnected = true;
    });
  }

  App.inHome = function () {
    return document.getElementById('scr-home').classList.contains('active');
  };

  /* ================= 启动流程 ================= */
  function boot() {
    UI.initStars();
    showScreen('scr-splash');
    connect();
    setTimeout(function () {
      if (App.token) App.socket.emit('auth', { token: App.token });
      else showScreen('scr-login');
    }, 1800);
  }

  function gotoLoading() {
    showScreen('scr-loading');
    var bar = $('#scr-loading .load-bar i');
    if (bar) { bar.style.width = '0'; requestAnimationFrame(function () { bar.style.width = '100%'; }); }
    setTimeout(function () {
      showScreen('scr-home');
      renderHomeUser();
    }, 1400);
  }

  /* ================= 首页 ================= */
  function renderHomeUser() {
    var u = App.user;
    if (!u) return;
    var hu = $('#home-user');
    hu.querySelector('.hu-avatar').outerHTML =
      '<span class="hu-avatar">' + UI.avatarHTML(u.avatar) + '</span>';
    hu.querySelector('.hu-name').textContent = u.name;
    hu.querySelector('.hu-energy b').textContent = u.energy;
  }

  function bindHome() {
    document.querySelectorAll('.mode-card').forEach(function (c) {
      c.addEventListener('click', function () {
        Sound.sfx.click();
        var mode = c.dataset.mode;
        App.socket.emit('enter', { mode: mode }, function (res) {
          if (!res || !res.ok) { UI.toast((res && res.msg) || '进入失败'); return; }
          if (res.phase === 'playing' || res.phase === 'over') {
            showScreen('scr-battle');
          } else {
            showScreen('scr-waiting');
          }
        });
      });
    });
    $('#home-user').addEventListener('click', openProfile);
    document.querySelectorAll('#scr-home [data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act;
        if (act === 'exit') {
          UI.confirmBox('确定退出游戏吗?', doLogout);
        } else if (act === 'tutorial') openTutorial();
        else if (act === 'help') openHelp();
        else if (act === 'missions') openMissions();
        else if (act === 'leaderboard') openLeaderboard();
      });
    });
    $('#btn-change-table').addEventListener('click', function () {
      Sound.sfx.click();
      App.socket.emit('changeTable');
      App.socket.emit('enter', { mode: App.waitInfo && App.waitInfo.mode || 'arena' }, function (res) {
        if (res && res.ok && res.phase === 'waiting') showScreen('scr-waiting');
      });
      UI.toast('正在换桌…');
    });
  }

  function doLogout() {
    try { localStorage.removeItem('gdg_token'); sessionStorage.removeItem('gdg_token'); } catch (e) {}
    App.socket.emit('logout');
    App.token = ''; App.user = null; App.state = null; App.seat = -1;
    UI.closeAllModals();
    showScreen('scr-login');
  }

  /* ================= 登录页 ================= */
  function bindLogin() {
    $('#btn-play').addEventListener('click', function () {
      Sound.sfx.click();
      App.socket.emit('login', {
        name: $('#in-user').value.trim(),
        pass: $('#in-pass').value
      });
    });
    $('#in-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btn-play').click(); });
  }

  /* ================= 等待房 ================= */
  function onRoomInfo(info) {
    App.waitInfo = info;
    if (info.phase !== 'waiting') return; // 开局由 g 事件驱动
    if (!document.getElementById('scr-waiting').classList.contains('active')) return;
    renderWaiting(info);
  }

  function renderWaiting(info) {
    var wrap = $('#wait-seats');
    var seats = info.seats || [];
    var html = '';
    for (var i = 0; i < 4; i++) {
      var s = seats[i];
      html += '<div class="wseat' + (s ? '' : ' empty') + '">' +
        (s
          ? UI.avatarHTML(s.avatar) +
            '<div class="ws-name">' + s.name + (s.isBot ? ' <i class="ws-bot">电脑</i>' : '') + '</div>'
          : '<div class="ws-plus">+</div><div class="ws-name">等待玩家</div>') +
        '</div>';
    }
    wrap.innerHTML = html;
    var cd = $('#wait-count b');
    if (cd && info.countdown != null) cd.textContent = Math.ceil(info.countdown / 1000);
  }

  /* ================= 对局状态 ================= */
  function onGameState(p) {
    App.seat = p.seat;
    App.state = p.state;
    var st = p.state;
    if (st.phase === 'waiting') {
      showScreen('scr-waiting');
      renderWaiting({ seats: st.seats, countdown: st.countdown, mode: st.mode });
      return;
    }
    showScreen('scr-battle');
    renderBattle(st);
    renderResult(st);
  }

  function mySeat() { return App.state && App.state.seats[App.seat]; }
  function isMyTurn() { return App.state && App.state.phase === 'playing' && App.state.turn === App.seat; }

  /* 座位展示顺序：下家 → 对家 → 上家 */
  function oppOrder() {
    var s = App.seat, out = [];
    for (var i = 1; i <= 3; i++) out.push((s + i) % 4);
    return out;
  }

  function renderBattle(st) {
    $('#bb-deck').textContent = st.deckCount;
    $('#bb-mult').textContent = st.mult;
    var meNow = mySeat();
    $('#self-dealer').style.display = meNow && meNow.dealer ? 'flex' : 'none';

    // 对手
    var wrap = $('#opponents');
    wrap.innerHTML = oppOrder().map(function (idx) {
      var s = st.seats[idx];
      if (!s) return '';
      var active = st.phase === 'playing' && st.turn === idx;
      return '<div class="opp' + (active ? ' active' : '') + (s.connected ? '' : ' off') + (s.dealer ? ' dealer-plate' : '') + '" data-seat="' + idx + '">' +
        '<span class="op-dealer">压</span>' +
        '<div class="op-ava">' + UI.avatarHTML(s.avatar) +
          (s.auto ? '<i class="op-auto">托管</i>' : '') +
          (s.connected ? '' : '<i class="op-auto">离线</i>') + '</div>' +
        '<div class="op-name">' + s.name + '</div>' +
        '<div class="op-count">' + s.count + '</div>' +
        '<div class="op-timer' + (active ? ' on' : '') + '"><svg viewBox="0 0 44 44"><circle class="ot-bg" cx="22" cy="22" r="18"/><circle class="ot-fg" cx="22" cy="22" r="18"/></svg></div>' +
        (s.bubble ? '<div class="op-bubble">' + s.bubble + '</div>' : '') +
        '</div>';
    }).join('');

    // 中央牌堆（当前压牌）；飞行动画期间且内容未变时复用已渲染元素，避免重建打断动画
    var pile = $('#pile-area');
    var pendSeat = st.pending ? st.pending.seat : -1;
    var pendSeatData = pendSeat >= 0 ? st.seats[pendSeat] : null;
    var hasPend = !!(st.pending && pendSeatData && pendSeatData.lastPlay);
    var pileKey = hasPend ? st.pending.combo.cards.join(',') + '@' + st.roundNo : '';
    var reusePile = pileKey && pileKey === App.pileKey && pile.firstChild && Date.now() < (App.pileKeyUntil || 0);
    if (!reusePile) {
      if (hasPend) {
        pile.innerHTML = '<div class="pile-label">' + GDY.comboName(st.pending.combo) +
          ' · <i>' + (pendSeat === App.seat ? '你' : pendSeatData.name) + '</i></div>' +
          '<div class="pile-cards n' + st.pending.combo.n + '">' +
          UI.cardsHTML(st.pending.combo.cards) + '</div>';
        if (App.flyFrom) {
          animatePileFrom(App.flyFrom);
          App.flyFrom = null;
          App.pileKey = pileKey;
          App.pileKeyUntil = Date.now() + 420;
        }
      } else if (st.phase === 'playing') {
        pile.innerHTML = '<div class="pile-empty">' + (st.turn === App.seat ? '轮到你出牌' : '等待出牌…') + '</div>';
      } else {
        pile.innerHTML = '';
      }
    }

    // 手牌
    renderHand(st);

    // 操作栏
    var my = isMyTurn();
    var bar = $('#action-bar');
    bar.classList.toggle('my-turn', my);
    $('#btn-pass').disabled = !my || !st.pending;
    $('#btn-hint').disabled = !my;
    $('#btn-clear').disabled = !my || !App.selected.length;
    var selCombo = GDY.parseCombo(App.selected);
    var canPlay = my && selCombo && (!st.pending || GDY.beats(selCombo, st.pending.combo));
    $('#btn-play-cards').disabled = !canPlay;

    // 计时环
    startTimerLoop(st);

    // 记牌器
    if (App.counterOn) renderCounter();
    else $('#counter-panel').innerHTML = '';
  }

  function renderHand(st) {
    var me = mySeat();
    var area = $('#hand-area');
    if (!me || !me.hand) { area.innerHTML = ''; return; }
    var selSet = {};
    App.selected.forEach(function (id) { selSet[id] = 1; });
    var myTurn = isMyTurn();
    area.innerHTML = me.hand.map(function (id) {
      var cls = 'in-hand' + (selSet[id] ? ' sel' : '') + (myTurn ? ' canpick' : '');
      return UI.cardHTML(id, cls);
    }).join('');
    // 开局发牌逐张飞入
    if (Date.now() < (App.dealAnimUntil || 0)) {
      area.querySelectorAll('.card').forEach(function (c, i) {
        c.classList.add('dealing');
        c.style.setProperty('--i', i);
      });
    } else if (App.drawPulse) {
      // 摸牌弹入
      App.drawPulse = false;
      var cards = area.querySelectorAll('.card');
      if (cards.length) cards[cards.length - 1].classList.add('drawn');
    }
    area.querySelectorAll('.card').forEach(function (c) {
      c.addEventListener('click', function () {
        if (!isMyTurn()) return;
        var id = +c.dataset.id;
        Sound.sfx.select();
        var k = App.selected.indexOf(id);
        if (k >= 0) { App.selected.splice(k, 1); c.classList.remove('sel'); }
        else { App.selected.push(id); c.classList.add('sel'); }
        updatePlayBtn();
      });
    });
  }

  function updatePlayBtn() {
    var st = App.state;
    if (!st) return;
    var selCombo = GDY.parseCombo(App.selected);
    var canPlay = isMyTurn() && selCombo && (!st.pending || GDY.beats(selCombo, st.pending.combo));
    $('#btn-play-cards').disabled = !canPlay;
    $('#btn-clear').disabled = !isMyTurn() || !App.selected.length;
  }

  /* ---------- 计时环 ---------- */
  var timerRaf = null;
  function startTimerLoop(st) {
    if (timerRaf) cancelAnimationFrame(timerRaf);
    var arc = $('#tt-arc'), num = $('#tt-num');
    var CIRC = 2 * Math.PI * 30;
    arc.style.strokeDasharray = CIRC;
    function frame() {
      var st2 = App.state;
      if (!st2 || st2.phase !== 'playing') { timerRaf = null; return; }
      var remain = Math.max(0, (st2.deadline - Date.now()) / 1000);
      var my = isMyTurn();
      // 中央大计时器：我的回合显示
      if (my) {
        num.textContent = Math.ceil(remain);
        arc.style.strokeDashoffset = CIRC * (1 - remain / 30);
        var sec = Math.ceil(remain);
        if (sec <= 5 && sec >= 1 && sec !== App.tickLast) {
          App.tickLast = sec; Sound.sfx.tick();
        }
      } else {
        num.textContent = '·';
        arc.style.strokeDashoffset = CIRC;
      }
      // 对手小计时环
      document.querySelectorAll('.opp .op-timer.on').forEach(function (t) {
        var idx = +t.closest('.opp').dataset.seat;
        var fg = t.querySelector('.ot-fg');
        var r = remainFor(st2, idx);
        var c2 = 2 * Math.PI * 18;
        fg.style.strokeDasharray = c2;
        fg.style.strokeDashoffset = c2 * (1 - Math.max(0, r) / 30);
      });
      timerRaf = requestAnimationFrame(frame);
    }
    timerRaf = requestAnimationFrame(frame);
  }
  function remainFor(st, idx) {
    return Math.max(0, (st.deadline - Date.now()) / 1000) * (st.turn === idx ? 1 : 0);
  }

  /* ---------- 事件特效 ---------- */
  function captureSourceRect(seat) {
    var el = null;
    if (seat === App.seat) {
      el = document.querySelector('#hand-area .card.sel') || document.querySelector('#hand-area .card');
    } else {
      el = document.querySelector('.opp[data-seat="' + seat + '"] .op-ava');
    }
    return el ? el.getBoundingClientRect() : null;
  }

  function onGameEvent(e) {
    if (e.type === 'deal') {
      App.seenIds = [];
      App.selected = [];
      App.resultShownRound = -1;
      App.hintList = []; App.hintIdx = 0;
      App.dealAnimUntil = Date.now() + 950;
      Sound.sfx.deal();
      setTimeout(Sound.sfx.deal, 140);
      setTimeout(Sound.sfx.deal, 280);
      setTimeout(Sound.sfx.deal, 420);
      showDealTip(App.state && App.state.modeLabel);
    } else if (e.type === 'play') {
      Sound.sfx.play();
      App.flyFrom = captureSourceRect(e.seat);
      if (e.seat === App.seat) App.selected = [];
    } else if (e.type === 'bomb') {
      (e.combo.type === 'rocket' ? Sound.sfx.rocket : Sound.sfx.bomb)();
      App.flyFrom = captureSourceRect(e.seat);
      bombFx(GDY.comboName(e.combo));
      (e.cards || []).forEach(function (id) { App.seenIds.push(id); });
    } else if (e.type === 'pass') {
      Sound.sfx.pass();
      if (e.drew && e.seat === App.seat) { Sound.sfx.draw(); App.drawPulse = true; }
    } else if (e.type === 'over') {
      // 结算由 g.phase==='over' 驱动
    }
    if (e.cards && e.type !== 'bomb') {
      (e.cards || []).forEach(function (id) { App.seenIds.push(id); });
    }
  }

  /* 出牌飞行动画：牌堆从出牌者位置飞入中央（FLIP） */
  function animatePileFrom(src) {
    var pileEl = document.querySelector('#pile-area .pile-cards');
    if (!pileEl || !src) return;
    var dest = pileEl.getBoundingClientRect();
    if (!dest.width) return;
    var dx = (src.left + src.width / 2) - (dest.left + dest.width / 2);
    var dy = (src.top + src.height / 2) - (dest.top + dest.height / 2);
    var scale = Math.max(0.4, Math.min(1, (src.width || 120) / (dest.width || 300)));
    pileEl.style.transition = 'none';
    pileEl.style.transform = 'translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) scale(' + scale.toFixed(2) + ')';
    pileEl.style.opacity = '0.4';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        pileEl.style.transition = 'transform .3s ease-out, opacity .26s ease-out';
        pileEl.style.transform = '';
        pileEl.style.opacity = '1';
      });
    });
  }

  function showDealTip(modeLabel) {
    var t = $('#deal-tip');
    t.textContent = modeLabel ? modeLabel + ' · 开局' : '';
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  function bombFx(text) {
    var fx = $('#bomb-fx');
    fx.textContent = text + ' !';
    fx.classList.remove('go');
    void fx.offsetWidth;
    fx.classList.add('go');
    var sc = document.getElementById('scr-battle');
    sc.classList.remove('shake');
    void sc.offsetWidth;
    sc.classList.add('shake');
  }

  /* ---------- 记牌器 ---------- */
  function renderCounter() {
    var seen = App.seenIds.slice();
    var me = mySeat();
    if (me && me.hand) seen = seen.concat(me.hand);
    var rows = GDY.counterRanks(seen);
    $('#counter-panel').innerHTML = '<div class="cp-title">记牌器</div><div class="cp-grid">' +
      rows.map(function (r) {
        return '<div class="cp-cell' + (r.left === 0 ? ' out' : '') + '"><b>' + r.name + '</b><i>' + r.left + '</i></div>';
      }).join('') + '</div>';
  }

  /* ---------- 结算窗口 ---------- */
  function renderResult(st) {
    if (st.phase !== 'over' || !st.result) return;
    if (st.resultShownRound === st.roundNo) return;
    st.resultShownRound = st.roundNo;
    var r = st.result, me = mySeat();
    var myR = r.results[App.seat];
    var win = myR.win;
    var loserRemain = 0;
    r.results.forEach(function (x) { if (!x.win) loserRemain += x.remain; });
    var remainStat = win ? loserRemain : myR.remain;

    var body =
      '<div class="rt-stats">' +
        '<div class="rt-stat"><div class="rt-ico ico-remain"></div><div class="rt-v cyan">+' + remainStat + '</div><div class="rt-label">剩余牌数</div></div>' +
        '<div class="rt-stat"><div class="rt-ico ico-bomb"></div><div class="rt-v cyan">x ' + r.bombs.bomb + '</div><div class="rt-label">炸弹</div></div>' +
        '<div class="rt-stat"><div class="rt-ico ico-hbomb"></div><div class="rt-v cyan">x ' + r.bombs.hbomb + '</div><div class="rt-label">氢弹</div></div>' +
        '<div class="rt-stat"><div class="rt-ico ico-rocket"></div><div class="rt-v cyan">x ' + r.bombs.rocket + '</div><div class="rt-label">火箭</div></div>' +
      '</div>' +
      '<div class="rt-total-label">您总共' + (win ? '赢得' : '输掉') + '</div>' +
      '<div class="rt-total"><b>' + Math.abs(myR.delta) + '</b><i>瓦能量</i></div>' +
      '<div class="rt-next">下一局 <b id="rt-cd">8</b> 秒后自动开始</div>';

    var dlg = UI.modal({
      cls: 'result-dialog',
      banner: '<div class="rt-banner ' + (win ? 'rt-win' : 'rt-lose') + '">' + (win ? '赢' : '输') + '</div>',
      body: body,
      okText: '继续玩',
      cancelText: '退出',
      maskClose: false,
      onOk: function (close) { close(); },
      onCancel: function () { leaveBattle(); }
    });
    Sound.sfx[win ? 'win' : 'lose']();
    var cd = dlg.body.querySelector('#rt-cd');
    var n = 8;
    var iv = setInterval(function () {
      n--;
      if (cd) cd.textContent = n;
      if (n <= 0) clearInterval(iv);
    }, 1000);
    setTimeout(function () {
      if (document.body.contains(dlg.box)) dlg.close();
    }, 7800);
  }

  function leaveBattle() {
    App.socket.emit('leaveRoom');
    App.state = null; App.seat = -1; App.selected = [];
    UI.closeAllModals();
    showScreen('scr-home');
    renderHomeUser();
    App.socket.emit('syncUser', function (res) {
      if (res && res.ok) { App.user = res.user; renderHomeUser(); }
    });
  }

  /* ================= 对局操作 ================= */
  function bindBattle() {
    $('#btn-pass').addEventListener('click', function () {
      App.socket.emit('pass', {}, function (res) {
        if (!res.ok) UI.toast(res.msg || '无法出牌');
        else { App.selected = []; }
      });
    });
    $('#btn-play-cards').addEventListener('click', function () {
      var cards = App.selected.slice();
      App.socket.emit('play', { cards: cards }, function (res) {
        if (!res.ok) UI.toast(res.msg || '无法出牌');
        else App.selected = [];
      });
    });
    $('#btn-clear').addEventListener('click', function () {
      App.selected = [];
      renderHand(App.state);
      updatePlayBtn();
    });
    $('#btn-hint').addEventListener('click', function () {
      var st = App.state;
      if (!st || !isMyTurn()) return;
      var me = mySeat();
      App.hintList = GDY.candidates(me.hand, st.pending ? st.pending.combo : null);
      if (!App.hintList.length) { UI.toast('没有能压过的牌，点「不出」摸牌'); return; }
      App.hintIdx = App.hintIdx % App.hintList.length;
      var c = App.hintList[App.hintIdx++];
      App.selected = c.cards.slice();
      renderHand(st);
      updatePlayBtn();
      Sound.sfx.select();
    });

    // 顶部按钮（退出/菜单）— 事件委托到两个对战入口
    $('#scr-battle [data-act="leave-battle"]').addEventListener('click', function () {
      UI.confirmBox('确定退出对局吗？退出将由电脑代打。', leaveBattle);
    });
    $('#scr-battle [data-act="menu"]').addEventListener('click', openMenu);
  }

  /* ================= 弹窗们 ================= */

  /* 菜单下拉 */
  function openMenu() {
    Sound.sfx.click();
    var inBattle = App.inBattle && App.state;
    var body = UI.el('div', 'menu-drop');
    body.innerHTML =
      '<div class="md-col">' +
        '<button class="md-item" data-m="auto"><i>🎛️</i>托管' + (App.auto ? '<b class="on">开</b>' : '<b>关</b>') + '</button>' +
        '<button class="md-item" data-m="counter"><i>🧮</i>记牌器' + (App.counterOn ? '<b class="on">开</b>' : '<b>关</b>') + '</button>' +
      '</div>' +
      '<div class="md-col">' +
        '<button class="md-item" data-m="settings"><i>⚙️</i>设置</button>' +
        '<button class="md-item" data-m="feedback"><i>💬</i>反馈意见</button>' +
        '<button class="md-item" data-m="switch"><i>🔄</i>切换账号</button>' +
      '</div>';
    var dlg = UI.modal({ cls: 'menu-dialog', body: body, okText: null, cancelText: null, maskClose: true });
    body.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.md-item');
      if (!btn) return;
      var m = btn.dataset.m;
      dlg.close();
      if (m === 'settings') openSettings();
      else if (m === 'feedback') openFeedback();
      else if (m === 'switch') UI.confirmBox('确定切换账号吗？', doLogout);
      else if (m === 'auto') {
        if (!inBattle) { UI.toast('对局中才能开启托管'); return; }
        App.auto = !App.auto;
        App.socket.emit('auto', { on: App.auto });
        UI.toast(App.auto ? '托管已开启' : '托管已关闭');
      } else if (m === 'counter') {
        if (!inBattle) { UI.toast('对局中才能使用记牌器'); return; }
        App.counterOn = !App.counterOn;
        if (App.counterOn) renderCounter();
        else $('#counter-panel').innerHTML = '';
      }
    });
  }

  /* 设置 */
  function openSettings() {
    Sound.sfx.click();
    var v = Sound.volumes;
    var body = UI.el('div', 'settings-body');
    body.innerHTML =
      '<div class="set-row"><label>音乐</label><input type="range" id="set-music" min="0" max="100" value="' + Math.round(v.music * 100) + '"></div>' +
      '<div class="set-row"><label>声效</label><input type="range" id="set-sfx" min="0" max="100" value="' + Math.round(v.sfx * 100) + '"></div>';
    UI.modal({ title: '设 置', body: body, okText: '确定' });
    body.querySelector('#set-music').addEventListener('input', function () { Sound.setVolume('music', this.value / 100); });
    body.querySelector('#set-sfx').addEventListener('input', function () { Sound.setVolume('sfx', this.value / 100); });
  }

  /* 帮助 */
  function openHelp() {
    Sound.sfx.click();
    UI.modal({
      title: '帮 助',
      cls: 'help-dialog',
      okText: null, cancelText: null,
      body:
        '<div class="help-sec"><b>玩法</b>每人发 5 张牌，轮流出牌。压不上（或不想压）时摸一张牌并过，先出完手牌者获胜。</div>' +
        '<div class="help-sec"><b>牌型</b>单张 &lt; 对子 &lt; <em>炸弹</em>(三张相同) &lt; <em>氢弹</em>(四张相同) &lt; <em>火箭</em>(大小王)。<br>点数：3&lt;4&lt;…&lt;K&lt;A&lt;2&lt;小王&lt;大王。</div>' +
        '<div class="help-sec"><b>压牌</b>必须出与上家相同张数且点数更大的牌；炸弹/氢弹/火箭可越序压制任意非炸弹牌型。</div>' +
        '<div class="help-sec"><b>计分</b>输家支付（剩余牌数 + 炸弹×2 + 氢弹×4 + 火箭×8）× 赔率；赢家另收全场底注。练习场免费不结算能量。</div>'
    });
  }

  /* 新手指导 */
  function openTutorial() {
    Sound.sfx.click();
    var steps = [
      { t: '1 · 目标', b: '把手里 5 张牌全部出完！每回合可以出牌压过对手，或摸一张牌跳过。' },
      { t: '2 · 牌型', b: '可以出单张、对子；三张相同是炸弹，四张相同是氢弹，双王是火箭，越往后越强。' },
      { t: '3 · 压牌', b: '出牌必须和上家张数相同、点数更大。压不住就点「不出」——摸一张牌，看看手气！' },
      { t: '4 · 得分', b: '对手手里剩的牌越多，你赢得越多；打出炸弹还能翻倍收益。祝你好运！' }
    ];
    var i = 0;
    var body = UI.el('div', 'tutorial-body');
    function render() {
      body.innerHTML = '<div class="tu-step">' + steps[i].t + '</div><div class="tu-text">' + steps[i].b + '</div>' +
        '<div class="tu-dots">' + steps.map(function (_, k) { return '<i class="' + (k === i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
      prevB.textContent = i === 0 ? '跳过' : '上一步';
      nextB.textContent = i === steps.length - 1 ? '开始游戏' : '下一步';
    }
    var dlg = UI.modal({ title: '新手指导', body: body, okText: null, cancelText: null, maskClose: true });
    var btns = UI.el('div', 'sd-btns tu-btns');
    var prevB = UI.el('button', 'btn-metal', '跳过');
    var nextB = UI.el('button', 'btn-metal primary', '下一步');
    prevB.onclick = function () { dlg.close(); };
    nextB.onclick = function () {
      Sound.sfx.click();
      if (i === steps.length - 1) dlg.close(); else { i++; render(); }
    };
    btns.appendChild(prevB); btns.appendChild(nextB);
    dlg.box.appendChild(btns);
    render();
  }

  /* 英雄榜 */
  function openLeaderboard(kind) {
    Sound.sfx.click();
    kind = kind || 'war';
    var TABS = [
      { k: 'war', n: '战神榜', u: '赢' }, { k: 'streak', n: '连胜榜', u: '连胜' },
      { k: 'energy', n: '能量榜', u: '瓦' }, { k: 'trophy', n: '奖杯榜', u: '奖杯' },
      { k: 'mission', n: '任务榜', u: '任务' }
    ];
    var body = UI.el('div', 'lb-body');
    var dlg = UI.modal({ title: '英雄榜', body: body, okText: null, cancelText: null, cls: 'lb-dialog' });
    function load(k) {
      App.socket.emit('leaderboard', { kind: k }, function (res) {
        if (!res || !res.ok) return;
        var d = res.data;
        var tab = TABS.filter(function (t) { return t.k === k; })[0];
        body.innerHTML =
          '<div class="lb-tabs">' + TABS.map(function (t) {
            return '<button class="lb-tab' + (t.k === k ? ' on' : '') + '" data-k="' + t.k + '">' + t.n + '</button>';
          }).join('') + '</div>' +
          '<div class="lb-list">' +
          (d.top.length ? d.top.map(function (row) {
            return '<div class="lb-row"><i class="lb-rank r' + row.rank + '">' + row.rank + '</i>' +
              '<span class="lb-name">' + row.name + '</span>' +
              '<span class="lb-val">' + tab.u + '：<b>' + row.value + '</b></span></div>';
          }).join('') : '<div class="lb-empty">暂无数据，快来抢占榜首！</div>') +
          '</div>' +
          '<div class="lb-me">' +
            UI.avatarHTML(d.myAvatar) +
            '<div class="lb-me-name">' + (d.myName || '游客') + '</div>' +
            '<div class="lb-me-stat"><span>' + tab.u + '</span><b class="cyan">' + d.myVal + '</b></div>' +
            '<div class="lb-me-stat"><span>排名</span><b class="cyan">' + (d.myRank || '—') + '</b></div>' +
          '</div>';
        body.querySelectorAll('.lb-tab').forEach(function (t) {
          t.onclick = function () { Sound.sfx.click(); load(t.dataset.k); };
        });
      });
    }
    load(kind);
  }

  /* 接任务 */
  function openMissions() {
    Sound.sfx.click();
    var MISSIONS = [
      { id: 'm1', text: '竞技场连赢 3 场', goal: 3, reward: 200 },
      { id: 'm2', text: '任意场打出 3 个炸弹', goal: 3, reward: 50 },
      { id: 'm3', text: '完成任意 3 场对局', goal: 3, reward: 30 },
      { id: 'm4', text: '练习场赢 1 场', goal: 1, reward: 20 }
    ];
    var body = UI.el('div', 'ms-body');
    var dlg = UI.modal({ title: '接任务', body: body, okText: null, cancelText: null, cls: 'ms-dialog' });

    function render() {
      var ms = App.user && App.user.missions || { progress: {}, claimed: {} };
      body.innerHTML =
        '<div class="ms-cards">' +
        MISSIONS.map(function (m) {
          var p = Math.min(m.goal, ms.progress && ms.progress[m.id] || 0);
          var claimed = ms.claimed && ms.claimed[m.id];
          var done = p >= m.goal;
          return '<div class="ms-card' + (done && !claimed ? ' ready' : '') + '">' +
            '<div class="ms-title">' + m.text + '</div>' +
            '<div class="ms-goal"><span>' + p + '</span> / ' + m.goal + '</div>' +
            '<div class="ms-progress"><i style="width:' + (p / m.goal * 100) + '%"></i></div>' +
            '<div class="ms-reward">奖励能量 <b>' + m.reward + '</b> 瓦</div>' +
            (claimed ? '<button class="btn-metal ms-btn" disabled>已领取</button>'
              : done ? '<button class="btn-metal primary ms-btn" data-id="' + m.id + '">领取</button>'
              : '<button class="btn-metal ms-btn" disabled>进行中</button>') +
            '</div>';
        }).join('') + '</div>' +
        '<div class="ms-tip">每日任务 0 点刷新 · 战绩可在「英雄榜」查看</div>';
      body.querySelectorAll('.ms-btn[data-id]').forEach(function (b) {
        b.onclick = function () {
          App.socket.emit('claimMission', { id: b.dataset.id }, function (res) {
            if (res && res.ok) { UI.toast('领取成功 +' + res.reward + ' 瓦'); render(); }
            else UI.toast((res && res.msg) || '领取失败');
          });
        };
      });
    }
    App.socket.emit('syncUser', function (res) {
      if (res && res.ok) { App.user = res.user; }
      render();
    });
  }

  /* 个人中心 */
  function openProfile() {
    Sound.sfx.click();
    var body = UI.el('div', 'pf-body');
    var dlg = UI.modal({ title: '个人中心', body: body, okText: null, cancelText: null, cls: 'pf-dialog' });
    var picked = App.user ? App.user.avatar : 'a1';

    function renderInfo() {
      var grid = '';
      for (var i = 1; i <= 12; i++) {
        var id = 'a' + i;
        grid += '<button class="pf-ava' + (picked === id ? ' on' : '') + '" data-id="' + id + '">' +
          UI.avatarHTML(id) + '</button>';
      }
      body.innerHTML =
        '<div class="pf-cur">' + UI.avatarHTML(picked) + '<div><b>' + (App.user.name) + '</b><span>能量 <i class="cyan">' + App.user.energy + '</i> 瓦</span></div></div>' +
        '<div class="pf-grid">' + grid + '</div>' +
        '<div class="sd-btns"><button class="btn-metal" id="pf-rand">随机生成</button>' +
        '<button class="btn-metal primary" id="pf-save">保存头像</button>' +
        '<button class="btn-metal" id="pf-cancel">取消</button></div>';
      body.querySelectorAll('.pf-ava').forEach(function (b) {
        b.onclick = function () {
          picked = b.dataset.id;
          body.querySelectorAll('.pf-ava').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          body.querySelector('.pf-cur').innerHTML = UI.avatarHTML(picked) + '<div><b>' + App.user.name + '</b><span>能量 <i class="cyan">' + App.user.energy + '</i> 瓦</span></div>';
          Sound.sfx.select();
        };
      });
      body.querySelector('#pf-rand').onclick = function () {
        App.socket.emit('randomAvatar');
      };
      body.querySelector('#pf-save').onclick = function () {
        App.socket.emit('setAvatar', { avatar: picked });
        UI.toast('头像已保存');
        dlg.close();
      };
      body.querySelector('#pf-cancel').onclick = function () { dlg.close(); };
    }

    function renderStats() {
      var u = App.user;
      var modes = [['practice', '练习场', 'cyan'], ['arena', '竞技场', 'gold'], ['master', '大师场', 'magenta']];
      function row(label, fn) {
        return '<div class="gs-row"><span class="gs-label">' + label + '</span>' +
          modes.map(function (m) {
            var s = u.stats[m[0]];
            return '<b class="' + m[2] + '">' + fn(s) + '</b>';
          }).join('') + '</div>';
      }
      body.innerHTML =
        '<div class="gs-table">' +
        '<div class="gs-row gs-head"><span></span>' + modes.map(function (m) { return '<b class="' + m[2] + '">' + m[1] + '</b>'; }).join('') + '</div>' +
        row('比赛', function (s) { return s.games + '次'; }) +
        row('赢', function (s) { return s.wins + '次'; }) +
        row('输', function (s) { return s.losses + '次'; }) +
        row('胜率', function (s) { return (s.games ? Math.round(s.wins / s.games * 100) : 0) + '%'; }) +
        row('赢了', function (s) { return s.wonE; }) +
        row('输了', function (s) { return s.lostE; }) +
        row('积分', function (s) { return s.points; }) +
        '</div>';
    }

    var tab = 'info';
    function render() {
      if (tab === 'info') renderInfo(); else renderStats();
      var tabs = '<div class="pf-tabs">' +
        '<button class="btn-metal big' + (tab === 'info' ? ' primary' : '') + '" data-t="info">基本信息</button>' +
        '<button class="btn-metal big' + (tab === 'stats' ? ' primary' : '') + '" data-t="stats">游戏记录</button></div>';
      var old = body.querySelector('.pf-tabs');
      if (old) old.remove();
      body.insertAdjacentHTML('afterbegin', tabs);
      body.querySelectorAll('.pf-tabs .btn-metal').forEach(function (b) {
        b.onclick = function () { Sound.sfx.click(); tab = b.dataset.t; render(); };
      });
    }

    App.socket.emit('syncUser', function (res) {
      if (res && res.ok) App.user = res.user;
      render();
    });
    // 保存头像后刷新
    App.socket.on('syncUser', function pfRefresh(res) {
      if (res && res.ok) { App.user = res.user; if (document.body.contains(dlg.box) && tab === 'info') picked = res.user.avatar; }
    });
  }

  /* 反馈意见 */
  function openFeedback() {
    Sound.sfx.click();
    var body = UI.el('div', 'fb-body');
    body.innerHTML = '<textarea id="fb-text" maxlength="200" placeholder="欢迎告诉我你的建议或遇到的问题…"></textarea>';
    UI.modal({
      title: '反馈意见', body: body, okText: '提交', cancelText: '取消',
      onOk: function (close) {
        var t = body.querySelector('#fb-text').value.trim();
        if (!t) { UI.toast('请填写反馈内容'); return false; }
        App.socket.emit('feedback', { text: t });
        UI.toast('感谢你的反馈！');
        close();
      }
    });
  }

  /* ================= 全局顶部按钮（等待页退出） ================= */
  function bindWaiting() {
    $('#scr-waiting [data-act="leave-room"]').addEventListener('click', leaveBattle);
  }

  /* ================= go ================= */
  window.__GDG = App; // 调试用
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.warn('SW 注册失败（不影响游戏）:', e.message);
      });
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    bindLogin();
    bindHome();
    bindWaiting();
    bindBattle();
    boot();
  });
})();
