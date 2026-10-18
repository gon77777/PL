/* equalizer.js — イコライザー（libVLC 標準の 10 バンド）の画面とロジック
 *
 *  - 音は端末側(NativePlayerPlugin.java の vlcEqSet)で処理する。ここは設定の保持・保存・操作画面を担当
 *  - プリセット: 「標準」= libVLC 内蔵プリセット（ネイティブから取得）+ このアプリ独自の数種、
 *                「マイプリセット」= 利用者が名前をつけて保存したもの（最大 30 件）
 *  - スライダーを動かす / プリセットを選ぶと、イコライザーは自動でオンになる
 *  - 設定は electronAPI.saveSettings({ eq: … }) で保存され、次回起動時に自動で反映される
 *
 *  - アナライザー: EQ 画面を開いている間だけ端末側(Visualizer)から FFT を受け取り、フェーダーの背面に表示する
 *  - 帯域ソロ（聴き分け）: 選んだ帯域以外を -20 dB（libVLC の下限）まで下げて、その帯域だけを意識して聴けるようにする。
 *                         端末へ送る値を一時的に差し替えるだけで、利用者のフェーダー設定・プリセット・保存内容は変えない（保存もしない）
 *
 * 外部から使うもの:  window.EQ.init(保存済みの設定)  … applyInitSettings() から呼ばれる
 */
(function () {
  'use strict';

  const RANGE = 12;    // 画面上の操作範囲 ±12 dB（libVLC は ±20 dB まで対応）
  const STEP = 0.5;    // 刻み
  const MAX_CUSTOM = 30;
  const DEF_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

  // libVLC 内蔵プリセット名 → 日本語表示
  const JP = {
    'Classical': 'クラシック', 'Club': 'クラブ', 'Dance': 'ダンス', 'Full bass': '重低音',
    'Full bass and treble': '低音＋高音ブースト', 'Full treble': '高音強調', 'Headphones': 'ヘッドホン',
    'Large Hall': 'ホール', 'Live': 'ライブ', 'Party': 'パーティー', 'Pop': 'ポップ', 'Reggae': 'レゲエ',
    'Rock': 'ロック', 'Ska': 'スカ', 'Soft': 'ソフト', 'Soft rock': 'ソフトロック', 'Techno': 'テクノ',
  };

  // このアプリ独自のプリセット（10 バンド: 60 / 170 / 310 / 600 / 1k / 3k / 6k / 12k / 14k / 16k Hz）
  const OWN = [
    { id: 'x:voice', name: 'ボイス強調（セリフ・会話）', preamp: -2, bands: [-3, -2, 0, 1.5, 3, 4, 3, 0, -1, -2] },
    { id: 'x:lowcut', name: '低音カット（小さいスピーカー）', preamp: 0, bands: [-8, -5, -2, 0, 0, 0, 0, 0, 0, 0] },
  ];

  const $ = id => document.getElementById(id);
  const api = () => window.electronAPI;
  const say = (m, ms) => { try { if (typeof toast === 'function') toast(m, ms); } catch (_) {} };

  let available = false;
  let wired = false;
  let n = 10;                       // バンド数
  let freqs = DEF_FREQS.slice();
  let builtin = [];                 // [{ id, name, preamp, bands }]
  let bandEls = [];                 // [{ db, fill, thumb }]
  let st = { enabled: false, preset: 'flat', preamp: 0, bands: zeros(10), custom: [], analyzer: true };
  const SOLO_FLOOR = -20;           // ソロ以外の帯域に掛ける値（libVLC が受け付ける下限）
  const solo = new Set();           // ソロ中のバンド番号。保存しない（アプリを開き直すと必ず解除）

  function zeros(k) { return new Array(k).fill(0); }
  const q = v => {
    v = Number(v);
    if (!isFinite(v)) v = 0;
    v = Math.round(v / STEP) * STEP;
    return Math.max(-RANGE, Math.min(RANGE, v));
  };
  const fit = arr => {
    const a = (Array.isArray(arr) ? arr : []).map(q);
    while (a.length < n) a.push(0);
    a.length = n;
    return a;
  };
  const fmtDb = v => (v > 0 ? '+' : '') + String(Math.round(v * 10) / 10);
  const fmtHz = f => (f >= 1000 ? String(Math.round(f / 100) / 10).replace(/\.0$/, '') + 'k' : String(Math.round(f)));

  function normalize(e) {
    const s = e || {};
    return {
      enabled: s.enabled === true,
      analyzer: s.analyzer !== false,
      preset: typeof s.preset === 'string' ? s.preset : 'custom',
      preamp: q(s.preamp || 0),
      bands: fit(s.bands),
      custom: (Array.isArray(s.custom) ? s.custom : [])
        .filter(c => c && typeof c.name === 'string' && c.name)
        .slice(0, MAX_CUSTOM)
        .map(c => ({ name: c.name.slice(0, 20), preamp: q(c.preamp || 0), bands: fit(c.bands) })),
    };
  }

  // ───────── スペクトラムアナライザー（フェーダーの背面） ─────────
  // 端末側が 30 Hz〜18 kHz を対数 64 本(0〜255)にして ~25 fps で送ってくる。各フェーダーの担当する周波数帯を SUB 本の細い棒に分けて描く。
  const SPEC_N = 64, SPEC_FMIN = 30, SPEC_FMAX = 18000, SUB = 4;
  const SPEC_LOGR = Math.log(SPEC_FMAX / SPEC_FMIN);
  let specRaw = new Array(SPEC_N).fill(0);   // 最新の生データ（0..1）
  let specDisp = [], specPeak = [];
  let specCanvas = null, specCtx = null, specRaf = 0;
  let specVisible = false, specWanted = false, specColor = '#4caf50';

  const specPos = f => Math.log(Math.max(SPEC_FMIN, Math.min(SPEC_FMAX, f)) / SPEC_FMIN) / SPEC_LOGR * SPEC_N - 0.5;
  function specSample(lo, hi) {
    const a = specPos(lo), b = specPos(hi);
    if (b - a < 1) {                       // 1 本より狭い帯域: 隣の本から補間
      const c = (a + b) / 2, i = Math.floor(c), fr = c - i;
      const g = k => specRaw[Math.max(0, Math.min(SPEC_N - 1, k))];
      return g(i) * (1 - fr) + g(i + 1) * fr;
    }
    let m = 0;
    for (let k = Math.max(0, Math.ceil(a)); k <= Math.min(SPEC_N - 1, Math.floor(b)); k++) if (specRaw[k] > m) m = specRaw[k];
    return m;
  }
  // フェーダー i の担当帯域: 両隣との幾何平均で区切る
  function colRange(i) {
    const f = freqs, last = f.length - 1;
    const lo = i === 0 ? f[0] / Math.sqrt(f[1] / f[0]) : Math.sqrt(f[i - 1] * f[i]);
    const hi = i === last ? f[last] * Math.sqrt(f[last] / f[last - 1]) : Math.sqrt(f[i] * f[i + 1]);
    return [lo, hi];
  }

  function specLayout() {
    const host = $('eq-bands');
    const track = host && host.querySelector('.eq-track');
    if (!host || !track || !specCanvas || !specCtx) return false;
    const w = host.clientWidth, h = track.offsetHeight;
    if (w < 10 || h < 10) return false;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (specCanvas.width !== W || specCanvas.height !== H) { specCanvas.width = W; specCanvas.height = H; }
    specCanvas.style.width = w + 'px';
    specCanvas.style.height = h + 'px';
    specCanvas.style.top = track.offsetTop + 'px';
    specCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function specClear() {
    if (specCtx && specCanvas) { specCtx.setTransform(1, 0, 0, 1, 0, 0); specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height); }
  }

  function specDraw() {
    if (!specLayout()) return true;
    const host = $('eq-bands');
    const w = host.clientWidth, h = specCanvas.height / (window.devicePixelRatio || 1);
    const gap = 2, colW = (w - gap * (n - 1)) / n, barW = colW / SUB;
    const top = 11, base = h - 11, maxH = base - top;
    specCtx.clearRect(0, 0, w, h);
    let any = false;
    for (let i = 0; i < n; i++) {
      const [lo, hi] = colRange(i);
      const ratio = hi / lo;
      for (let s = 0; s < SUB; s++) {
        const k = i * SUB + s;
        const raw = specSample(lo * Math.pow(ratio, s / SUB), lo * Math.pow(ratio, (s + 1) / SUB));
        let d = specDisp[k] || 0, pk = specPeak[k] || 0;
        d = raw > d ? d + (raw - d) * 0.75 : Math.max(raw, d - 0.03);   // 立ち上がりは速く、落ちはゆっくり
        pk = d >= pk ? d : Math.max(d, pk - 0.008);
        specDisp[k] = d; specPeak[k] = pk;
        if (d > 0.004 || pk > 0.004) any = true;
        const x = i * (colW + gap) + s * barW + 0.5;
        const bh = d * maxH;
        if (bh > 0.5) {
          specCtx.globalAlpha = 0.34;
          specCtx.fillStyle = specColor;
          specCtx.fillRect(x, base - bh, barW - 1, bh);
        }
        if (pk > 0.02) {
          specCtx.globalAlpha = 0.7;
          specCtx.fillStyle = specColor;
          specCtx.fillRect(x, base - pk * maxH - 1.5, barW - 1, 1.5);
        }
      }
    }
    specCtx.globalAlpha = 1;
    return any;
  }

  function specFrame() {
    specRaf = 0;
    if (!specVisible || !st.analyzer) return;
    const any = specDraw();
    let fresh = false;
    for (let j = 0; j < SPEC_N; j++) if (specRaw[j] > 0) { fresh = true; break; }
    if (any || fresh) specRaf = requestAnimationFrame(specFrame);   // 無音で落ち切ったら描画ループを止める
  }
  function specKick() { if (!specRaf && specVisible && st.analyzer) specRaf = requestAnimationFrame(specFrame); }

  function specHint(state) {
    const el = $('eq-spec-hint');
    if (!el) return;
    const base = '再生中の音の強さを、フェーダーの背面に表示します';
    const msg = {
      pending: '「音声の録音」権限を許可してください（録音はしません。音の強さを測るために Android が要求します）',
      denied: '権限が許可されていないため表示できません（端末の設定 → アプリ → 権限 から許可）',
      unsupported: 'この端末では表示できません',
      error: 'アナライザーを開始できませんでした',
    }[state];
    el.textContent = msg || base;
    el.classList.toggle('warn', !!msg);
  }

  // EQ 画面が開いている間だけ端末側のアナライザーを動かす
  function specUpdate() {
    const want = !!(available && st.analyzer && specVisible && !document.hidden);
    if (specCanvas) specCanvas.style.display = st.analyzer ? '' : 'none';
    if (want === specWanted) { if (want) specKick(); return; }
    specWanted = want;
    const a = api();
    if (want) {
      try { specColor = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || specColor; } catch (_) {}
      specLayout();
      if (a && typeof a.analyzerSet === 'function') {
        Promise.resolve(a.analyzerSet(true)).then(r => specHint(r && r.state)).catch(() => specHint('error'));
      }
      specKick();
    } else {
      try { a && typeof a.analyzerSet === 'function' && a.analyzerSet(false); } catch (_) {}
      specRaw.fill(0);
      specKick();      // 落ち切るまで描いてから止まる
    }
  }

  function specWire() {
    window.addEventListener('vlc-spectrum', e => {
      const b = e.detail || [];
      for (let j = 0; j < SPEC_N; j++) specRaw[j] = Math.max(0, Math.min(1, (b[j] || 0) / 255));
      specKick();
    });
    window.addEventListener('vlc-analyzer', e => specHint(e.detail === 'on' ? '' : e.detail));
    const drawer = $('drawer');
    if (drawer) {
      const check = () => {
        specVisible = drawer.classList.contains('open') && drawer.classList.contains('eq-open');
        specUpdate();
      };
      try { new MutationObserver(check).observe(drawer, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
      check();
    }
    document.addEventListener('visibilitychange', specUpdate);
    window.addEventListener('resize', () => { specLayout(); specKick(); });
    $('eq-spec-toggle')?.addEventListener('click', () => {
      st.analyzer = !st.analyzer;
      $('eq-spec-toggle').classList.toggle('on', st.analyzer);
      if (!st.analyzer) { specClear(); }
      specUpdate();
      save(true);
    });
  }

  // ── ネイティブへの反映（スライダーをドラッグ中は 60ms ごとにまとめて送る） ──
  let pushTimer = null, pushDirty = false;
  // 端末へ送る値。ソロ中は「ソロ以外を -20 dB」に差し替える（EQ が「効果オフ」でもソロは効く）
  function effective(state, soloSet) {
    if (!soloSet.size) return { enabled: state.enabled, preamp: state.preamp, bands: state.bands.slice() };
    const mine = state.enabled;      // 効果オンなら利用者のフェーダー設定を生かし、オフなら 0 dB を土台にする
    return {
      enabled: true,
      preamp: mine ? state.preamp : 0,
      bands: state.bands.map((v, i) => (soloSet.has(i) ? (mine ? v : 0) : SOLO_FLOOR)),
    };
  }
  function send() {
    try { api() && api().eqSet && api().eqSet(effective(st, solo)); } catch (_) {}
  }
  function push() {
    if (pushTimer) { pushDirty = true; return; }
    send();
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (pushDirty) { pushDirty = false; push(); }
    }, 60);
  }

  // ── 設定の保存 ──
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => {
      try {
        api() && api().saveSettings && api().saveSettings({
          eq: { enabled: st.enabled, analyzer: st.analyzer, preset: st.preset, preamp: st.preamp, bands: st.bands.slice(), custom: st.custom },
        });
      } catch (_) {}
    };
    if (now) run(); else saveTimer = setTimeout(run, 300);
  }

  // ── プリセット一覧 ──
  function buildBuiltin(info) {
    const list = [{ id: 'flat', name: 'フラット（何もしない）', preamp: 0, bands: zeros(n) }];
    if (info && info.ok && Array.isArray(info.presets)) {
      info.presets.forEach((p, i) => {
        if (!p || /^flat$/i.test(p.name)) return;
        list.push({ id: 'n:' + i, name: JP[p.name] || p.name, preamp: Number(p.preamp) || 0, bands: (p.amps || []).map(Number) });
      });
    }
    if (n === 10) OWN.forEach(o => list.push(o));
    return list;
  }
  const findPreset = id => (id && id.startsWith('u:'))
    ? st.custom.find(c => c.name === id.slice(2))
    : builtin.find(b => b.id === id);

  // ── 描画 ──
  function renderBand(i) {
    const e = bandEls[i];
    if (!e) return;
    const v = st.bands[i];
    const pos = (RANGE - v) / (2 * RANGE) * 100;   // 0%=上端(+12dB) / 50%=0dB / 100%=下端(-12dB)
    e.thumb.style.top = pos + '%';
    e.fill.style.top = Math.min(50, pos) + '%';
    e.fill.style.height = Math.abs(pos - 50) + '%';
    e.db.textContent = fmtDb(v);
  }

  function renderPresetSelect() {
    const sel = $('eq-preset-sel');
    if (!sel) return;
    sel.innerHTML = '';
    const add = (parent, val, text) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = text;
      parent.appendChild(o);
    };
    add(sel, 'custom', 'カスタム（手動調整）');
    const g1 = document.createElement('optgroup');
    g1.label = '標準';
    builtin.forEach(p => add(g1, p.id, p.name));
    sel.appendChild(g1);
    if (st.custom.length) {
      const g2 = document.createElement('optgroup');
      g2.label = 'マイプリセット';
      st.custom.forEach(c => add(g2, 'u:' + c.name, c.name));
      sel.appendChild(g2);
    }
    if (!findPreset(st.preset)) st.preset = 'custom';
    sel.value = st.preset;
    const del = $('eq-del');
    if (del) del.disabled = !(st.preset.startsWith('u:') && findPreset(st.preset));
  }

  function renderAll() {
    const live = st.enabled || solo.size > 0;
    $('eq-toggle')?.classList.toggle('on', st.enabled);
    $('eq-panel')?.classList.toggle('off', !live);
    $('eq-btn')?.classList.toggle('on', live);
    $('eq-spec-toggle')?.classList.toggle('on', st.analyzer);
    const pre = $('eq-preamp');
    if (pre) pre.value = st.preamp;
    const pv = $('eq-preamp-val');
    if (pv) pv.textContent = fmtDb(st.preamp) + ' dB';
    for (let i = 0; i < n; i++) renderBand(i);
    renderPresetSelect();
    renderSolo();
  }

  // ── 帯域ソロの表示 ──
  const SOLO_SETS = {                 // 周波数の範囲（Hz）で選ぶので、バンド数が違う端末でも使える
    bass: f => f <= 200,              // 60 / 170
    vocal: f => f >= 300 && f <= 3500, // 310 / 600 / 1k / 3k
    high: f => f >= 6000,             // 6k 以上
  };
  const soloSetOf = key => new Set(freqs.map((f, i) => (SOLO_SETS[key](f) ? i : -1)).filter(i => i >= 0));
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  function soloRangeText() {
    const idx = [...solo].sort((a, b) => a - b);
    return idx.map(i => fmtHz(freqs[i]) + ' Hz').join(' / ');
  }
  function renderSolo() {
    const on = solo.size > 0;
    for (let i = 0; i < n; i++) {
      const col = bandEls[i] && bandEls[i].col;
      if (!col) continue;
      col.classList.toggle('solo', solo.has(i));
      col.classList.toggle('muted', on && !solo.has(i));
      bandEls[i].solo?.classList.toggle('on', solo.has(i));
    }
    document.querySelectorAll('[data-solo]').forEach(b => b.classList.toggle('active', on && sameSet(solo, soloSetOf(b.dataset.solo))));
    const off = $('eq-solo-off');
    if (off) off.disabled = !on;
    const hint = $('eq-solo-hint');
    if (hint) {
      hint.textContent = on
        ? '聴き分け中: ' + soloRangeText() + ' 以外を大きく下げています（完全には消えません）。聴き終わったら「解除」を押してください'
        : '指定した帯域以外を大きく下げて、その帯域だけを意識して聴けます。下の「S」で帯域を個別に選ぶこともできます（複数可）';
      hint.classList.toggle('warn', on);
    }
    $('eq-btn')?.classList.toggle('solo', on);
  }
  function setSolo(next) {
    solo.clear();
    next.forEach(i => solo.add(i));
    renderAll();
    push();                           // 保存はしない（一時的な聴き分け用）
  }
  function toggleSoloBand(i) {
    const next = new Set(solo);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSolo(next);
  }
  function toggleSoloPreset(key) {
    const want = soloSetOf(key);
    setSolo(sameSet(solo, want) ? new Set() : want);
  }

  function buildBands() {
    const host = $('eq-bands');
    if (!host) return;
    host.innerHTML = '';
    bandEls = [];
    specCanvas = document.createElement('canvas');   // フェーダーの背面に敷くアナライザー
    specCanvas.id = 'eq-spectrum';
    host.appendChild(specCanvas);
    specCtx = specCanvas.getContext('2d');
    specDisp = []; specPeak = [];
    for (let i = 0; i < n; i++) {
      const col = document.createElement('div');
      col.className = 'eq-band';
      col.innerHTML =
        '<div class="eq-db">0</div>' +
        '<div class="eq-track"><div class="eq-lane"><div class="eq-rail"></div><div class="eq-fill"></div><div class="eq-thumb"></div></div></div>' +
        '<div class="eq-hz"></div>' +
        '<button type="button" class="eq-solo-btn" aria-label="この帯域だけ聴く">S</button>';
      col.querySelector('.eq-hz').textContent = fmtHz(freqs[i]);
      col.querySelector('.eq-solo-btn').setAttribute('aria-label', fmtHz(freqs[i]) + ' Hz の帯域だけ聴く');
      col.querySelector('.eq-solo-btn').addEventListener('click', () => toggleSoloBand(i));
      host.appendChild(col);
      const track = col.querySelector('.eq-track');
      bindDrag(track, col.querySelector('.eq-lane'), i);
      bandEls.push({ col, solo: col.querySelector('.eq-solo-btn'), db: col.querySelector('.eq-db'), fill: col.querySelector('.eq-fill'), thumb: col.querySelector('.eq-thumb') });
    }
  }

  // ── 操作 ──
  function touched() {      // 手動で触った: カスタム扱い + 自動でオン
    st.preset = 'custom';
    st.enabled = true;
  }

  function setBand(i, v) {
    if (st.bands[i] === v && st.enabled) return;
    st.bands[i] = v;
    touched();
    renderBand(i);
    $('eq-toggle')?.classList.add('on');
    $('eq-panel')?.classList.remove('off');
    $('eq-btn')?.classList.add('on');
    const sel = $('eq-preset-sel');
    if (sel && sel.value !== 'custom') { renderPresetSelect(); }
    push();
    save();
  }

  function bindDrag(track, lane, i) {
    const fromEvent = e => {
      const r = lane.getBoundingClientRect();
      if (r.height <= 0) return;
      const t = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      setBand(i, q(RANGE - t * 2 * RANGE));
    };
    track.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      fromEvent(e);
    });
    track.addEventListener('pointermove', e => {
      let cap = false;
      try { cap = track.hasPointerCapture(e.pointerId); } catch (_) {}
      if (cap) fromEvent(e);
    });
    const end = e => {
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
      save(true);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  function applyPreset(id) {
    const p = findPreset(id);
    if (!p) return;
    st.preamp = q(p.preamp);
    st.bands = fit(p.bands);
    st.preset = id;
    st.enabled = true;
    renderAll();
    push();
    save(true);
  }

  function resetFlat() {
    st.preamp = 0;
    st.bands = zeros(n);
    st.preset = 'flat';
    renderAll();
    push();
    save(true);
  }

  function saveCustom() {
    const input = $('eq-name-input');
    const name = (input ? input.value : '').trim().slice(0, 20);
    if (!name) { say('プリセット名を入力してください'); return; }
    const entry = { name, preamp: st.preamp, bands: st.bands.slice() };
    const idx = st.custom.findIndex(c => c.name === name);
    if (idx >= 0) {
      st.custom[idx] = entry;
      say('「' + name + '」を上書き保存しました');
    } else {
      if (st.custom.length >= MAX_CUSTOM) { say('保存できるのは ' + MAX_CUSTOM + ' 件までです'); return; }
      st.custom.push(entry);
      say('「' + name + '」を保存しました');
    }
    st.preset = 'u:' + name;
    if (input) input.value = '';
    renderPresetSelect();
    save(true);
  }

  function deleteCustom() {
    if (!st.preset.startsWith('u:')) return;
    const name = st.preset.slice(2);
    if (!window.confirm('プリセット「' + name + '」を削除しますか？')) return;
    st.custom = st.custom.filter(c => c.name !== name);
    st.preset = 'custom';
    renderPresetSelect();
    save(true);
    say('削除しました');
  }

  function wire() {
    if (wired) return;
    wired = true;

    $('eq-toggle')?.addEventListener('click', () => {
      st.enabled = !st.enabled;
      renderAll();
      push();
      save(true);
    });

    const pre = $('eq-preamp');
    pre?.addEventListener('input', () => {
      st.preamp = q(pre.value);
      touched();
      const pv = $('eq-preamp-val');
      if (pv) pv.textContent = fmtDb(st.preamp) + ' dB';
      $('eq-toggle')?.classList.add('on');
      $('eq-panel')?.classList.remove('off');
      $('eq-btn')?.classList.add('on');
      const sel = $('eq-preset-sel');
      if (sel && sel.value !== 'custom') renderPresetSelect();
      push();
      save();
    });
    pre?.addEventListener('change', () => save(true));

    $('eq-preset-sel')?.addEventListener('change', e => {
      const id = e.target.value;
      if (id === 'custom') { renderPresetSelect(); return; }   // 「カスタム」を手動で選んでも何も変えない
      applyPreset(id);
    });
    $('eq-save')?.addEventListener('click', saveCustom);
    $('eq-del')?.addEventListener('click', deleteCustom);
    $('eq-reset')?.addEventListener('click', resetFlat);
    document.querySelectorAll('[data-solo]').forEach(b => b.addEventListener('click', () => toggleSoloPreset(b.dataset.solo)));
    $('eq-solo-off')?.addEventListener('click', () => setSolo(new Set()));
    $('eq-name-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveCustom(); } });
    specWire();
  }

  async function init(saved) {
    available = !!(api() && typeof api().eqAvailable === 'function' && api().eqAvailable());
    const btn = $('eq-btn');
    if (!available) {            // ブラウザなどネイティブが無い環境では使えない
      if (btn) btn.style.display = 'none';
      return;
    }
    st = normalize(saved);
    push();                      // 動画を開く前でも効くように、先にネイティブへ渡す
    wire();

    let info = null;
    try { info = await api().eqInfo(); } catch (_) {}
    if (info && info.ok && Array.isArray(info.freqs) && info.freqs.length) {
      n = info.freqs.length;
      freqs = info.freqs.map(Number);
    }
    builtin = buildBuiltin(info);
    st = normalize(st);          // バンド数が 10 でなかった場合に合わせ直す
    buildBands();
    renderAll();
    specUpdate();
    if (n !== 10) push();
  }

  window.EQ = { init };
})();
