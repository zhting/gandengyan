/* UI 基础：牌面渲染、头像、弹窗、Toast */
(function () {
  'use strict';

  var GDY = window.GDY;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ---------- 头像：12 个机器人 ---------- */
  var AVATARS = [
    { e: '🤖', bg: '#4a6bd8' }, { e: '👾', bg: '#3a3f52' }, { e: '🛸', bg: '#5a4fd0' },
    { e: '👽', bg: '#c0392b' }, { e: '🦾', bg: '#8a94a6' }, { e: '🧿', bg: '#27ae60' },
    { e: '🎭', bg: '#576574' }, { e: '🪐', bg: '#7d5fff' }, { e: '🚀', bg: '#4834d4' },
    { e: '⚡', bg: '#2f3640' }, { e: '🔥', bg: '#e67e22' }, { e: '❄️', bg: '#4a69bd' }
  ];
  function avatarHTML(avatarId, extraCls) {
    var idx = 0;
    var m = /^a([1-9]|1[0-2])$/.exec(avatarId || '');
    if (m) idx = parseInt(m[1], 10) - 1;
    var a = AVATARS[idx] || AVATARS[0];
    return '<span class="avatar ' + (extraCls || '') + '" style="background:' + a.bg + '">' + a.e + '</span>';
  }

  /* ---------- 扑克牌 ---------- */
  function cardHTML(id, extraCls) {
    var r = GDY.rankOf(id), suit = GDY.suitOf(id), red = GDY.isRed(id);
    var cls = 'card ' + (red ? 'red' : 'blk') + (extraCls ? ' ' + extraCls : '');
    if (id >= 52) {
      var big = id === 53;
      cls += ' joker' + (big ? ' joker-big' : ' joker-small');
      return '<div class="' + cls + '" data-id="' + id + '">' +
        '<span class="jk-label">' + (big ? 'JOKER' : 'joker') + '</span>' +
        '<span class="jk-crown">👑</span>' +
        '<span class="jk-corner">' + (big ? '王' : '王') + '</span></div>';
    }
    var name = GDY.rankName(id), sc = GDY.suitChar(id);
    return '<div class="' + cls + '" data-id="' + id + '">' +
      '<span class="corner">' + name + '<i>' + sc + '</i></span>' +
      '<span class="pip">' + sc + '</span>' +
      '<span class="corner c2">' + name + '<i>' + sc + '</i></span>' +
      '</div>';
  }
  function cardBackHTML(extraCls) {
    return '<div class="card back ' + (extraCls || '') + '"><span class="back-diamond">◆</span></div>';
  }
  function cardsHTML(ids, extraCls) {
    return ids.map(function (id) { return cardHTML(id, extraCls); }).join('');
  }

  /* ---------- 卡牌背面堆（显示数量） ---------- */
  function stackHTML(n, maxShow) {
    maxShow = maxShow || 5;
    var show = Math.min(n, maxShow);
    var html = '';
    for (var i = 0; i < show; i++) {
      html += '<div class="mini-back" style="left:' + (i * 14) + 'px;bottom:' + (i * 5) + 'px;z-index:' + i + '">' + cardBackHTML() + '</div>';
    }
    if (n > 0) html += '<b class="stack-n">' + n + '</b>';
    return '<div class="stack-wrap">' + html + '</div>';
  }

  /* ---------- Toast ---------- */
  function toast(msg, dur) {
    var wrap = $('#toast-wrap');
    var t = el('div', 'toast', msg);
    wrap.appendChild(t);
    window.Sound && Sound.sfx.toast();
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, dur || 1800);
  }

  /* ---------- 弹窗 ---------- */
  var modalStack = [];
  function modal(opts) {
    // opts: {title, banner, body(html or node), cls, onOk, okText, cancelText, onClose, maskClose}
    // 结构：mask > sci-frame(装饰/标题/横幅，不裁剪) > sci-dialog(内容区，可滚动)
    var root = $('#modal-root');
    var mask = el('div', 'modal-mask');
    var frame = el('div', 'sci-frame ' + (opts.cls || ''));
    frame.innerHTML = '<div class="sd-deco tl"></div><div class="sd-deco tr"></div><div class="sd-deco bl"></div><div class="sd-deco br"></div>';
    if (opts.title) frame.insertAdjacentHTML('beforeend', '<div class="sd-title"><span>' + opts.title + '</span></div>');
    if (opts.banner) frame.insertAdjacentHTML('beforeend', opts.banner);
    var box = el('div', 'sci-dialog');
    var bodyWrap = el('div', 'sd-body');
    if (typeof opts.body === 'string') bodyWrap.innerHTML = opts.body;
    else if (opts.body) bodyWrap.appendChild(opts.body);
    box.appendChild(bodyWrap);

    if (opts.okText || opts.cancelText || opts.onOk) {
      var btns = el('div', 'sd-btns');
      if (opts.cancelText !== null) {
        var cBtn = el('button', 'btn-metal', opts.cancelText || '取消');
        cBtn.onclick = function () { Sound.sfx.click(); close(); if (opts.onCancel) opts.onCancel(); };
        btns.appendChild(cBtn);
      }
      if (opts.okText !== null) {
        var oBtn = el('button', 'btn-metal primary', opts.okText || '确定');
        oBtn.onclick = function () { Sound.sfx.click(); if (opts.onOk) { if (opts.onOk(close) === false) return; } else close(); };
        btns.appendChild(oBtn);
      }
      box.appendChild(btns);
    }
    frame.appendChild(box);
    mask.appendChild(frame);
    mask.addEventListener('pointerdown', function (e) {
      if (e.target === mask && opts.maskClose !== false) close();
    });
    root.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add('show'); });
    function close() {
      mask.classList.remove('show');
      setTimeout(function () { mask.remove(); }, 250);
      var i = modalStack.indexOf(api); if (i >= 0) modalStack.splice(i, 1);
      if (opts.onClose) opts.onClose();
    }
    var api = { close: close, box: box, frame: frame, body: bodyWrap };
    modalStack.push(api);
    return api;
  }
  function closeAllModals() {
    while (modalStack.length) modalStack.pop().close();
  }

  /* ---------- 通用确认框 ---------- */
  function confirmBox(text, onOk) {
    modal({
      body: '<div class="confirm-text">' + text + '</div>',
      okText: '确定', cancelText: '取消',
      onOk: function () { closeAllModals(); if (onOk) onOk(); return false; }
    });
  }

  /* ---------- 时钟 ---------- */
  function tickClocks() {
    var d = new Date();
    var s = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    ['home-clock', 'wait-clock', 'battle-clock'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.textContent = s;
    });
  }
  setInterval(tickClocks, 5000);
  tickClocks();

  /* ---------- 星空背景 ---------- */
  function initStars() {
    var cv = document.getElementById('bg-canvas');
    var bx = cv.getContext('2d');
    var stars = [];
    function resize() {
      cv.width = innerWidth; cv.height = innerHeight;
      stars = [];
      var n = Math.floor(innerWidth * innerHeight / 9000);
      for (var i = 0; i < n; i++) {
        stars.push({
          x: Math.random() * cv.width, y: Math.random() * cv.height,
          r: Math.random() * 1.4 + 0.3, p: Math.random() * Math.PI * 2,
          sp: 0.5 + Math.random() * 1.5, hue: Math.random() < 0.15 ? '#9fd8ff' : '#ffffff'
        });
      }
    }
    addEventListener('resize', resize);
    resize();
    var t = 0;
    (function frame() {
      t += 0.016;
      bx.clearRect(0, 0, cv.width, cv.height);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var a = 0.25 + 0.75 * Math.abs(Math.sin(s.p + t * s.sp));
        bx.globalAlpha = a;
        bx.fillStyle = s.hue;
        bx.beginPath();
        bx.arc(s.x, s.y, s.r, 0, 6.283);
        bx.fill();
      }
      bx.globalAlpha = 1;
      requestAnimationFrame(frame);
    })();
  }

  window.UI = {
    $: $, el: el, AVATARS: AVATARS,
    avatarHTML: avatarHTML, cardHTML: cardHTML, cardBackHTML: cardBackHTML,
    cardsHTML: cardsHTML, stackHTML: stackHTML,
    toast: toast, modal: modal, closeAllModals: closeAllModals,
    confirmBox: confirmBox, initStars: initStars
  };
})();
