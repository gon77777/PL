/* native-video.js — libVLC(ネイティブ) を HTMLVideoElement 風に操作するラッパー
 *
 * player.js は `vid.currentTime` / `vid.play()` / `vid.addEventListener('timeupdate', …)` などを使うので、
 * 同じ形の API を持つオブジェクトを用意し、中身を NativePlayer プラグイン(libVLC)に繋ぐ。
 * 映像そのものは WebView の背面にネイティブ描画されるため、#videobox の位置を常にネイティブへ伝える。
 */
(function () {
  'use strict';

  const SHOW_RESUME_TIMING = true;   // 検証用: 復帰にかかった時間を画面に表示

  const NP = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePlayer;

  function available() {
    try {
      const C = window.Capacitor;
      return !!(C && C.isNativePlatform && C.isNativePlatform() && C.isPluginAvailable && C.isPluginAvailable('NativePlayer'));
    } catch (_) { return false; }
  }

  class NativeVideo extends EventTarget {
    constructor() {
      super();
      this.isNative = true;
      this.nativeTracks = null;
      this.error = null;
      this._src = '';
      this._t = 0; this._stamp = 0;
      this._dur = NaN;
      this._paused = true; this._ended = false;
      this._rate = 1; this._vol = 1; this._muted = false;
      this._w = 0; this._h = 0;
      this._meta = false;
      this._q = Promise.resolve();
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      const np = NP();
      if (np && np.addListener) np.addListener('vlc', e => this._onNative(e || {}));
    }

    // 呼び出しを直列化（ブリッジ越しでも順序を保つ）
    _call(method, args) {
      this._q = this._q
        .then(() => NP()[method](args || {}))
        .catch(e => { console.warn('[vlc]', method, e && e.message || e); });
      return this._q;
    }
    _emit(type) { this.dispatchEvent(new Event(type)); }

    addEventListener(type, cb, opts) {
      super.addEventListener(type, cb, opts);
      // 既にメタデータ取得済みなら、後から登録されたリスナーにも通知する（再生位置の復元用）
      if (type === 'loadedmetadata' && this._meta) {
        setTimeout(() => {
          try { cb.call(this, new Event('loadedmetadata')); } catch (e) { console.error(e); }
          if (opts && opts.once) super.removeEventListener(type, cb, opts);
        }, 0);
      }
    }

    // ── ネイティブからのイベント ──
    _onNative(e) {
      switch (e.type) {
        case 'playing':
          this._ended = false;
          this._stamp = performance.now();
          if (this._paused) { this._paused = false; this._emit('play'); }
          this._emit('playing');
          break;
        case 'paused':
          if (!this._paused) { this._paused = true; this._emit('pause'); }
          break;
        case 'ended':
          this._ended = true; this._paused = true;
          if (isFinite(this._dur)) this._t = this._dur;
          this._emit('ended');
          break;
        case 'error':
          this.error = { code: 4 };
          this._emit('error');
          break;
        case 'time': {
          if (e.time >= 0) { this._t = e.time / 1000; this._stamp = performance.now(); }
          if (e.length > 0 && this._dur !== e.length / 1000) {
            this._dur = e.length / 1000;
            this._emit('durationchange');
          }
          if (!this._meta && e.length > 0) { this._meta = true; this._emit('loadedmetadata'); }
          this._emit('timeupdate');
          break;
        }
        case 'spectrum':   // スペクトラムアナライザー: 対数 64 本（0〜255）
          window.dispatchEvent(new CustomEvent('vlc-spectrum', { detail: e.bins || [] }));
          window.dispatchEvent(new CustomEvent('vlc-level', { detail: typeof e.level === 'number' ? e.level : -100 }));
          break;
        case 'analyzer':   // アナライザーの状態: on / denied / error
          window.dispatchEvent(new CustomEvent('vlc-analyzer', { detail: e.state }));
          break;
        case 'resumeTiming':
          // 画面消灯からの映像復帰にかかった時間（検証用トースト。不要になったら SHOW_RESUME_TIMING を false に）
          console.log('[vlc] video restored in ' + e.ms + ' ms');
          if (SHOW_RESUME_TIMING && typeof toast === 'function') toast('映像復帰 ' + e.ms + ' ms');
          break;
        case 'tracks':
          this.nativeTracks = e;
          if (e.width > 0 && e.height > 0 && (e.width !== this._w || e.height !== this._h)) {
            this._w = e.width; this._h = e.height;
            this._emit('resize');
          }
          this._emit('tracks');
          break;
      }
    }

    // ── HTMLVideoElement 風 API ──
    get src() { return this._src; }
    set src(v) { this._src = v || ''; }
    getAttribute(n) { return n === 'src' ? (this._src || null) : null; }
    load() {
      this._t = 0; this._dur = NaN; this._paused = true; this._ended = false;
      this._meta = false; this._w = 0; this._h = 0; this.error = null; this.nativeTracks = null;
      if (this._src) this._call('vlcLoad', { uri: this._src });
    }
    play() {
      if (this._ended) this._t = 0;   // 終了後の再生は先頭から
      this._ended = false;
      this._stamp = performance.now();
      if (this._paused) { this._paused = false; this._emit('play'); }
      this._call('vlcPlay');
      return Promise.resolve();
    }
    pause() {
      if (!this._paused) { this._paused = true; this._t = this.currentTime; this._emit('pause'); }
      this._call('vlcPause');
    }
    get paused() { return this._paused; }
    get ended() { return this._ended; }
    get duration() { return this._dur; }
    get currentTime() {
      if (this._paused || this._ended) return this._t;
      const t = this._t + (performance.now() - this._stamp) / 1000 * this._rate;
      return isFinite(this._dur) ? Math.min(t, this._dur) : t;
    }
    set currentTime(v) {
      if (!isFinite(v)) return;
      v = Math.max(0, isFinite(this._dur) ? Math.min(v, this._dur) : v);
      this._t = v; this._stamp = performance.now();
      this._call('vlcSeek', { time: Math.round(v * 1000) });
    }
    get playbackRate() { return this._rate; }
    set playbackRate(v) { this._rate = +v || 1; this._call('vlcSetRate', { rate: this._rate }); }
    get volume() { return this._vol; }
    set volume(v) { this._vol = Math.max(0, Math.min(1, +v)); this._applyVol(); }
    get muted() { return this._muted; }
    set muted(v) { this._muted = !!v; this._applyVol(); }
    _applyVol() {
      // 音量ブースト（compressor.js が window.__volGain に 1.0〜2.0 を入れる）。libVLC の上限は 200%
      const g = Math.max(1, Math.min(2, +window.__volGain || 1));
      this._call('vlcSetVolume', { volume: this._muted ? 0 : Math.min(200, Math.round(this._vol * 100 * g)) });
    }
    get videoWidth() { return this._w; }
    get videoHeight() { return this._h; }

    // ── 追加: 音声 / 字幕トラックの切り替え（libVLC の ID を指定） ──
    setAudioTrack(id) { this._call('vlcSetAudioTrack', { id }); }
    setSpuTrack(id) { this._call('vlcSetSpuTrack', { id }); }

    // ── 追加: N フレーム送り(dir=1) / 戻し(dir=-1)。再生中なら一時停止して 1 コマ動かす ──
    stepFrame(dir, count) {
      if (!this._paused) { this._t = this.currentTime; this._paused = true; this._emit('pause'); }
      return this._call('vlcStepFrame', { dir: dir >= 0 ? 1 : -1, count: Math.max(1, Math.round(count) || 1) });
    }

    // ── 追加: 映像の再読み込み（映像用ビューを作り直して復帰させる） ──
    refreshVideo() { return this._call('vlcRefreshVideo'); }

    // ── 追加: 映像の拡大（scale=倍率, tx/ty=移動量 CSS px。ネイティブの映像ビューを変形する） ──
    setZoom(scale, tx, ty) {
      const np = NP();
      if (np && np.vlcSetZoom) np.vlcSetZoom({ scale, tx, ty }).catch(() => {});
    }

    // ── 追加: A-B リピート（端末側で区間ループ。秒で指定、null で解除） ──
    setAbLoop(a, b) {
      const ok = a != null && b != null && isFinite(a) && isFinite(b) && b > a;
      this._call('vlcSetAbLoop', ok ? { a: Math.round(a * 1000), b: Math.round(b * 1000) } : { a: -1, b: -1 });
    }
  }

  // ── #videobox の矩形をネイティブへ伝える（背面の映像ビューをここに合わせる） ──
  function attachBox(box) {
    let last = '';
    const colorOf = () => {
      if (document.body.classList.contains('fs') || document.body.classList.contains('pip')) return '#000000';
      const c = getComputedStyle(document.documentElement).getPropertyValue('--c-app').trim();
      return /^#[0-9a-f]{6}$/i.test(c) ? c : '#0a0a0a';
    };
    const send = () => {
      const r = box.getBoundingClientRect();
      const visible = box.classList.contains('loaded') && r.width > 1 && r.height > 1;
      const bg = colorOf();
      const key = [r.left, r.top, r.width, r.height].map(v => Math.round(v * 10) / 10).join(',') + '|' + visible + '|' + bg;
      if (key === last) return;
      last = key;
      const np = NP();
      if (np) np.vlcSetRect({ x: r.left, y: r.top, w: r.width, h: r.height, visible, bg }).catch(() => {});
    };
    try { new ResizeObserver(send).observe(box); } catch (_) {}
    try { new MutationObserver(send).observe(box, { attributes: true, attributeFilter: ['class', 'style'] }); } catch (_) {}
    try { new MutationObserver(send).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
    window.addEventListener('resize', send);
    window.addEventListener('orientationchange', send);
    setInterval(send, 300);
    send();
  }

  window.NativeVideo = { available, create: () => new NativeVideo(), attachBox };
})();
