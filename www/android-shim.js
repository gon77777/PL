/* android-shim.js — Electron の window.electronAPI を Android(WebView) 向けに再実装 */
(function () {
  'use strict';
  const LS = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  // ── File オブジェクト管理（android://<名前>|<サイズ>|<更新日時> を擬似パスとして使う） ──
  // 対応を試みる動画拡張子（実際に再生できるかは端末のコーデック次第）
  window.VIDEO_EXTS = 'mkv mp4 m4v mov webm avi wmv asf flv f4v ts m2ts mts mpg mpeg mpe vob ogv ogm 3gp 3g2 divx rm rmvb mxf qt m2v'.split(' ');
  window.isVideoFile = f => /^(video|audio)\//.test(f.type || '') || window.VIDEO_EXTS.includes((f.name.split('.').pop() || '').toLowerCase());
  const files = new Map(), urls = new Map();
  const useNative = () => !!(window.NativeVideo && window.NativeVideo.available());

  // ネイティブ側のファイルを Blob のように読むための簡易クラス（mkv-subs.js が使う size / slice().stream() / arrayBuffer() だけ実装）
  const CHUNK = 512 * 1024;
  class NativeFile {
    constructor(uri, size) { this.uri = uri; this.size = size; }
    async _read(off, len) {
      const r = await NP().readChunk({ uri: this.uri, offset: off, length: len });
      if (!r || !r.length) return new Uint8Array(0);
      const res = await fetch('data:application/octet-stream;base64,' + r.data);
      return new Uint8Array(await res.arrayBuffer());
    }
    slice(start = 0, end = this.size) {
      const self = this;
      end = Math.min(end, this.size);
      return {
        async arrayBuffer() {
          const parts = []; let off = start, total = 0;
          while (off < end) {
            const u = await self._read(off, Math.min(CHUNK, end - off));
            if (!u.length) break;
            parts.push(u); off += u.length; total += u.length;
          }
          const out = new Uint8Array(total); let p = 0;
          for (const u of parts) { out.set(u, p); p += u.length; }
          return out.buffer;
        },
        stream() {
          let off = start, cancelled = false;
          return { getReader() { return {
            async read() {
              if (cancelled || off >= end) return { done: true, value: undefined };
              const u = await self._read(off, Math.min(CHUNK, end - off));
              if (!u.length) { off = end; return { done: true, value: undefined }; }
              off += u.length;
              return { done: false, value: u };
            },
            cancel() { cancelled = true; },
          }; } };
        },
      };
    }
  }
  window.__androidFiles = {
    register(file) {
      const key = `android://${file.name}|${file.size}|${file.lastModified}`;
      files.set(key, file); return key;
    },
    // libVLC(ネイティブ)用: 選択したファイルは content:// URI のまま扱う
    registerNative(info) {
      const key = `android://${info.name}|${info.size}|${info.modified || 0}`;
      files.set(key, new NativeFile(info.uri, info.size));
      return key;
    },
    url(key) {
      const f = files.get(key);
      if (f && f.uri) return f.uri;
      if (!urls.has(key)) urls.set(key, URL.createObjectURL(f));
      return urls.get(key);
    },
    name(key) { return key.slice(10).split('|')[0]; },
    get(key) { return files.get(key); },
  };

  const DEFAULTS = {
    player: { alwaysOnTop: false, simpleMode: false },
    timeline: { alwaysOnTop: false, detached: false, visible: true, tab: 'sub' },
    subtitle: { visible: true, position: 'bottom-center', fontSize: 15, track: 0 },
    audio: { track: 0, pauseOnUnplug: true, backgroundPlay: true },
    playback: { speed: 1, volume: 80, muted: false, continuous: false, repeat: 'off' },
    gesture: { doubleTapSeconds: 10 },
    pip: { auto: true },
    eq: { enabled: false, preset: 'flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], custom: [] },
    comp: { enabled: false, preset: 'std' },
    boost: { enabled: false, level: 100 },
    marks: { retentionDays: 90, quickButton: true },   // 保存期間（日。0 = 無制限）/ 全画面の「保存」ボタン
  };
  const merge = (t, s) => { for (const k in s) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = merge(t[k] && typeof t[k] === 'object' ? t[k] : {}, s[k]); } else t[k] = s[k]; } return t; };
  let settings = merge(JSON.parse(JSON.stringify(DEFAULTS)), LS('mkv.settings') || {});
  settings.timeline.detached = false; // Android は単一ウィンドウ

  const listeners = {};
  const noop = async () => true;
  const emit = (channel, data) => (listeners[channel] || []).slice().forEach(cb => { try { cb(data); } catch (e) { console.error(e); } });

  // ── ネイティブ（NativePlayerPlugin.java）呼び出し ──
  // 全画面(イミーシブ) / 画面の向き / 小窓再生(PiP) / 画面常時点灯 は WebView 単体では実現できないため、
  // scripts/patch-android.js が android/ に組み込む自作 Capacitor プラグインを使う。
  const NP = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePlayer;
  const callNP = async (method, args) => {
    try { const p = NP(); if (p && typeof p[method] === 'function') return await p[method](args || {}); }
    catch (e) { console.warn('[native]', method, e && e.message || e); }
    return null;
  };
  // ネイティブ → JS のイベントを electronAPI.on(...) に流す
  try {
    const np = NP();
    if (np && np.addListener) {
      np.addListener('pipChanged', e => emit('pip-changed', e));
      np.addListener('pipToggle',  () => emit('pip-toggle'));
      // 通知・ロック画面・イヤホンの「次へ / 前へ」（プレイリスト再生中）
      np.addListener('mediaNext',  () => emit('media-next'));
      np.addListener('mediaPrev',  () => emit('media-prev'));
      // 「このアプリで開く」で別の動画が渡された
      np.addListener('openUri', info => { if (info && info.uri) emit('file-opened', window.__androidFiles.registerNative(info)); });
    }
  } catch (e) { console.warn('[native] addListener failed', e); }

  // ── 再生位置の履歴の掃除 ──
  // 動画が消されたかはアプリから分からないため、「90 日以上開いていない記録」と「新しい 200 件より古い記録」を消す
  const HISTORY_MAX_AGE = 90 * 24 * 3600 * 1000;
  const HISTORY_MAX = 200;
  function pruneHistory(h) {
    const now = Date.now();
    let changed = false;
    const keys = Object.keys(h);
    for (const k of keys) {
      const e = h[k];
      if (!e || typeof e !== 'object') { delete h[k]; changed = true; continue; }
      if (!e.updatedAt) { e.updatedAt = now; changed = true; continue; }     // 更新日時が無い古い記録は、今日から数える
      if (now - e.updatedAt > HISTORY_MAX_AGE) { delete h[k]; changed = true; }
    }
    const rest = Object.keys(h);
    if (rest.length > HISTORY_MAX) {
      rest.sort((a, b) => h[b].updatedAt - h[a].updatedAt);                  // 新しい順
      for (const k of rest.slice(HISTORY_MAX)) delete h[k];
      changed = true;
    }
    return changed;
  }
  // 起動時に一度掃除
  try { const h0 = LS('mkv.history'); if (h0 && pruneHistory(h0)) LS('mkv.history', h0); } catch (_) {}

  // ── マーカー / A-B ループの保存（動画ごと） ──
  // 形式: mkv.marks = { [動画のキー]: { markers:[{id,t,name}], loops:[{id,a,b,name}], active:{a,b}|null, usedAt } }
  // usedAt = 最後にその動画を開いた / 記録を変更した日時。保存期間（設定）を過ぎた記録は起動時と設定変更時に自動削除する。
  const MARKS_KEY = 'mkv.marks';
  const DAY = 24 * 3600 * 1000;
  const marksAll = () => { const m = LS(MARKS_KEY); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; };
  const marksEmpty = e => !e || (!(e.markers && e.markers.length) && !(e.loops && e.loops.length) && !e.active);
  // days <= 0 / 不正値 = 無制限。消した本数を返す
  function pruneMarks(all, days, now) {
    days = Number(days);
    let removed = 0;
    for (const k of Object.keys(all)) {
      const e = all[k];
      if (!e || typeof e !== 'object' || marksEmpty(e)) { delete all[k]; removed++; continue; }
      if (!e.usedAt) { e.usedAt = now; continue; }                       // 日時が無い記録は、今日から数える
      if (days > 0 && now - e.usedAt > days * DAY) { delete all[k]; removed++; }
    }
    return removed;
  }
  window.__marksPrune = pruneMarks;      // 動作確認用
  const marksApi = {
    marksGet: async (filePath) => {
      const all = marksAll(), e = all[filePath];
      if (!e) return null;
      e.usedAt = Date.now();               // 開いた = 使った。保存期間はここから数え直す
      LS(MARKS_KEY, all);
      return JSON.parse(JSON.stringify(e));
    },
    marksSet: async (filePath, entry) => {
      const all = marksAll();
      if (marksEmpty(entry)) delete all[filePath];
      else all[filePath] = Object.assign({}, entry, { usedAt: Date.now() });
      LS(MARKS_KEY, all);
      return true;
    },
    marksPrune: async (days) => {
      const all = marksAll();
      const removed = pruneMarks(all, days, Date.now());
      if (removed) LS(MARKS_KEY, all);
      return removed;
    },
    marksClear: async (filePath) => {      // filePath を省略するとすべて
      if (filePath) { const all = marksAll(); delete all[filePath]; LS(MARKS_KEY, all); }
      else LS(MARKS_KEY, {});
      return true;
    },
    marksStats: async () => {
      const all = marksAll();
      let videos = 0, markers = 0, loops = 0;
      for (const k of Object.keys(all)) {
        const e = all[k];
        if (marksEmpty(e)) continue;
        videos++; markers += (e.markers || []).length; loops += (e.loops || []).length;
      }
      return { videos, markers, loops };
    },
  };

  let launchChecked = false;
  window.electronAPI = {
    ...marksApi,
    // ファイル選択
    openFile: () => useNative() ? (async () => {
      // libVLC 版: OS のファイル選択（全形式を選べる）
      try {
        const r = await NP().pickFile();
        return (!r || r.cancelled || !r.uri) ? null : window.__androidFiles.registerNative(r);
      } catch (e) { console.warn('[native] pickFile', e && e.message || e); return null; }
    })() : new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'video/*,audio/*,application/x-matroska,application/vnd.rn-realmedia,application/mxf,'
        + window.VIDEO_EXTS.map(e => '.' + e).join(',');
      inp.onchange = () => resolve(inp.files[0] ? window.__androidFiles.register(inp.files[0]) : null);
      inp.oncancel = () => resolve(null);
      inp.click();
    }),

    // 複数ファイル選択（プレイリスト用）。選んだファイルのキー配列を返す（キャンセル時は空配列）
    openFiles: () => useNative() ? (async () => {
      try {
        const r = await NP().pickFile();
        if (!r || r.cancelled) return [];
        const list = (r.files && r.files.length) ? r.files : (r.uri ? [r] : []);
        return list.filter(f => f && f.uri).map(f => window.__androidFiles.registerNative(f));
      } catch (e) { console.warn('[native] pickFile', e && e.message || e); return []; }
    })() : new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = 'video/*,audio/*,application/x-matroska,application/vnd.rn-realmedia,application/mxf,'
        + window.VIDEO_EXTS.map(e => '.' + e).join(',');
      inp.onchange = () => resolve(Array.from(inp.files || []).map(f => window.__androidFiles.register(f)));
      inp.oncancel = () => resolve([]);
      inp.click();
    }),

    // 字幕・音声トラック抽出（純 JS）
    extractSubtitles: async (key) => {
      const f = window.__androidFiles.get(key);
      if (!f) return { tracks: [], audioTracks: [], subtitles: [] };
      // 字幕・音声トラックの解析は Matroska/WebM(EBML)のみ。他形式は空で返す
      try {
        const h = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (!(h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3)) return { tracks: [], audioTracks: [], subtitles: [] };
        // ネイティブで走査（数 GB でも速い）。使えない・失敗したときは従来の JS 走査に切り替える
        if (f.uri && useNative()) {
          try {
            const raw = await NP().scanMkvSubs({ uri: f.uri });
            if (raw && raw.ok) return await window.MkvSubs.fromNative(raw);
          } catch (e) { console.warn('[subs] native scan failed, fallback to JS', e && e.message || e); }
        }
        return await window.MkvSubs.extract(f);
      } catch (e) { return { tracks: [], audioTracks: [], subtitles: [] }; }
    },

    // 通知 / ロック画面に出すタイトルとスキップ秒数
    setMediaInfo: async (info) => { if (useNative()) { try { await NP().setMediaInfo(info || {}); } catch (_) {} } return true; },

    // 再生位置・設定の永続化
    savePosition: async ({ filePath, time }) => {
      const h = LS('mkv.history') || {};
      if (time === 0) delete h[filePath];          // 最後まで見た動画は記録を消す（次回は頭から）
      else h[filePath] = { time, updatedAt: Date.now() };
      pruneHistory(h);
      LS('mkv.history', h);
      return true;
    },
    loadPosition: async (filePath) => (LS('mkv.history') || {})[filePath] ?? null,
    saveSettings: async (partial) => { merge(settings, partial); settings.timeline.detached = false; LS('mkv.settings', settings); return true; },

    // 全画面: ステータスバー/ナビゲーションバーを隠す（ネイティブ）。
    // ※ HTML5 Fullscreen API は Capacitor の WebView では動かないため、ネイティブ側で行う。
    setImmersive: async (enabled) => {
      if (NP()) return callNP('setImmersive', { enabled: !!enabled });
      // ブラウザでの開発確認用フォールバック
      if (enabled) await document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    },
    // 画面の向き: 'auto' | 'landscape' | 'portrait'
    setOrientation: async (mode) => {
      if (NP()) return callNP('setOrientation', { mode });
      try { // ブラウザでの開発確認用フォールバック
        if (mode === 'auto') screen.orientation.unlock();
        else await screen.orientation.lock(mode);
      } catch (_) {}
    },
    // 小窓（Picture in Picture）
    enterPip: async () => callNP('enterPip'),
    // 再生状態の通知（自動PiP・PiPの再生/停止ボタン・画面常時点灯）
    setPlaybackState: (state) => callNP('setPlaybackState', state),
    getNativeInfo: async () => (await callNP('getInfo')) || { native: false, pip: false },

    // イコライザー（libVLC 標準の 10 バンド）。ネイティブ(Android アプリ)でのみ使える
    eqAvailable: () => useNative(),
    eqInfo: async () => (await callNP('vlcEqInfo')) || { ok: false },
    eqSet: (state) => callNP('vlcEqSet', state),
    // スペクトラムアナライザー（EQ 画面を開いている間だけ有効。戻り値の state: on / pending / denied / unsupported / error / off）
    analyzerSet: async (enabled, owner) => {
      const o = owner || 'eq', set = (window.__analyzerOwners = window.__analyzerOwners || new Set());
      if (enabled) set.add(o); else set.delete(o);
      return (await callNP('vlcAnalyzerSet', { enabled: set.size > 0 })) || { state: 'unsupported' };
    },

    // コンプレッサー（libVLC の音声フィルター compressor）。設定が変わると端末側が同じ位置から開き直す
    compAvailable: () => useNative(),
    compSet: (state) => callNP('vlcCompSet', state),

    // デスクトップ専用機能は no-op
    minimize: noop, maximize: noop,
    closeWindow: async () => { try { window.Capacitor?.Plugins?.App?.exitApp(); } catch (_) {} },
    setAlwaysOnTopPlayer: noop, setAlwaysOnTopTimeline: noop,
    detachTimeline: noop, showTimelineWindow: noop, timelineAlwaysOnTop: noop,
    syncPlayback: () => {}, seekTo: () => {}, notifySubtitleTrack: () => {}, notifyFileLoaded: () => {},

    on: (channel, cb) => {
      (listeners[channel] = listeners[channel] || []).push(cb);
      if (channel === 'init-settings') setTimeout(() => cb(JSON.parse(JSON.stringify(settings))), 0);
      // 「このアプリで開く」から起動された場合、その動画をすぐ再生する
      if (channel === 'file-opened' && !launchChecked) {
        launchChecked = true;
        setTimeout(async () => {
          try {
            if (!useNative()) return;
            const r = await NP().getLaunchFile();
            if (r && r.uri) emit('file-opened', window.__androidFiles.registerNative(r));
          } catch (e) { console.warn('[native] getLaunchFile', e && e.message || e); }
        }, 50);
      }
      return () => { listeners[channel] = listeners[channel].filter(f => f !== cb); };
    },
  };
})();
