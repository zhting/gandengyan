/* WebAudio 合成音效 + 背景音乐（无外部音频文件） */
(function () {
  'use strict';

  var S = {
    music: 0.5,
    sfx: 0.7
  };
  try {
    var saved = JSON.parse(localStorage.getItem('gdg_settings') || '{}');
    if (typeof saved.music === 'number') S.music = saved.music;
    if (typeof saved.sfx === 'number') S.sfx = saved.sfx;
  } catch (e) {}

  var ctx = null, masterMusic = null, masterSfx = null, bgmTimer = null, bgmStep = 0, started = false;

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    masterMusic = ctx.createGain();
    masterMusic.gain.value = S.music * 0.5;
    masterMusic.connect(ctx.destination);
    masterSfx = ctx.createGain();
    masterSfx.gain.value = S.sfx;
    masterSfx.connect(ctx.destination);
    return true;
  }

  function unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (!started) { started = true; startBgm(); }
  }
  document.addEventListener('pointerdown', unlock, { once: false });
  document.addEventListener('keydown', unlock, { once: false });

  /* ---------- 基础音色 ---------- */
  function tone(freq, dur, opts) {
    if (!ensure() || S.sfx <= 0) return;
    opts = opts || {};
    var o = ctx.createOscillator(), g = ctx.createGain();
    var t = ctx.currentTime + (opts.delay || 0);
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, opts.slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.vol || 0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(masterSfx);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, opts) {
    if (!ensure() || S.sfx <= 0) return;
    opts = opts || {};
    var t = ctx.currentTime + (opts.delay || 0);
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = opts.ftype || 'lowpass';
    f.frequency.value = opts.freq || 1000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(opts.vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(masterSfx);
    src.start(t);
  }

  /* ---------- 具体音效 ---------- */
  var sfx = {
    click:  function () { tone(880, 0.06, { type: 'triangle', vol: 0.12 }); },
    select: function () { tone(520 + Math.random() * 60, 0.07, { type: 'triangle', vol: 0.15 }); },
    deal:   function () { noise(0.08, { freq: 3200, ftype: 'highpass', vol: 0.12 }); },
    play:   function () { noise(0.06, { freq: 2600, ftype: 'highpass', vol: 0.2 }); tone(320, 0.08, { type: 'triangle', vol: 0.12, delay: 0.02 }); },
    pass:   function () { tone(300, 0.14, { type: 'sine', slide: 180, vol: 0.14 }); },
    draw:   function () { noise(0.09, { freq: 1800, vol: 0.16 }); },
    bomb:   function () { noise(0.6, { freq: 700, vol: 0.55 }); tone(120, 0.5, { type: 'sawtooth', slide: 40, vol: 0.4 }); tone(60, 0.7, { type: 'sine', vol: 0.5, delay: 0.05 }); },
    rocket: function () { noise(0.9, { freq: 1200, vol: 0.5 }); tone(200, 0.8, { type: 'sawtooth', slide: 900, vol: 0.3 }); },
    win:    function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, 0.28, { type: 'triangle', vol: 0.22, delay: i * 0.13 }); }); },
    lose:   function () { [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.3, { type: 'sine', vol: 0.2, delay: i * 0.16 }); }); },
    tick:   function () { tone(1200, 0.05, { type: 'square', vol: 0.06 }); },
    toast:  function () { tone(660, 0.09, { type: 'triangle', vol: 0.12 }); tone(880, 0.09, { type: 'triangle', vol: 0.12, delay: 0.08 }); }
  };
  Object.keys(sfx).forEach(function (k) {
    var fn = sfx[k];
    sfx[k] = function () { if (S.sfx > 0) fn(); };
  });

  /* ---------- 背景音乐：缓慢琶音氛围 ---------- */
  var CHORDS = [
    [220.0, 261.6, 329.6], // Am
    [174.6, 220.0, 261.6], // F
    [196.0, 246.9, 293.7], // G
    [164.8, 207.7, 261.6]  // E
  ];
  function startBgm() {
    if (bgmTimer) return;
    bgmTimer = setInterval(function () {
      if (!ctx || ctx.state !== 'running' || S.music <= 0 || document.hidden) return;
      var chord = CHORDS[Math.floor(bgmStep / 4) % CHORDS.length];
      var note = chord[bgmStep % 3] * (bgmStep % 8 >= 4 ? 2 : 1);
      var o = ctx.createOscillator(), g = ctx.createGain();
      var t = ctx.currentTime;
      o.type = 'sine';
      o.frequency.value = note;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08 * S.music, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      o.connect(g); g.connect(masterMusic || ctx.destination);
      o.start(t); o.stop(t + 2.4);
      bgmStep++;
    }, 1300);
  }

  /* ---------- 音量设置 ---------- */
  function setVolume(kind, v) {
    v = Math.max(0, Math.min(1, v));
    S[kind] = v;
    if (kind === 'sfx' && masterSfx) masterSfx.gain.value = v;
    if (kind === 'music' && masterMusic) masterMusic.gain.value = v * 0.5;
    try { localStorage.setItem('gdg_settings', JSON.stringify(S)); } catch (e) {}
  }

  window.Sound = { sfx: sfx, setVolume: setVolume, volumes: S };
})();
