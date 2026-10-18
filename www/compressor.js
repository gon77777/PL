/* compressor.js — コンプレッサー（音量の均一化）と音量ブースト（最大 200%）の画面とロジック
 *
 *  コンプレッサー
 *   - libVLC の音声フィルター `compressor` を使う（大きい音を抑え、小さい音を持ち上げる）
 *   - 再生中に値を変える API が無いため、設定を変えるとネイティブ側(vlcCompSet)が同じ位置から開き直す
 *     （音が 0.5〜1 秒ほど途切れ、映像も一瞬乱れる）。スライダーは「指を離したとき」に 1 回だけ適用する
 *   - プリセット（弱 / 標準 / 強 / 夜間）を選ぶか、スライダーで手動調整。触ると自動でオンになる
 *
 *  音量ブースト
 *   - この画面に常に 100〜200% のバーを出す（100% = 変化なし）
 *   - 倍率は window.__volGain に入れ、native-video.js の音量(vlcSetVolume)に掛ける。libVLC の上限は 200%
 *
 *  設定は electronAPI.saveSettings({ comp: …, boost: … }) で保存され、次回起動時に反映される。
 *  外部から使うもの:
 *    window.COMP.init(保存済み comp, 保存済み boost)  … applyInitSettings() から呼ばれる
 */
(function () {
  'use strict';

  // 手動調整の項目（key は vlcCompSet の引数名と同じ）
  const PARAMS = [
    { key: 'threshold', id: 'cp-threshold', min: -30, max: 0,   step: 1,   def: -20, fmt: v => v + ' dB' },
    { key: 'ratio',     id: 'cp-ratio',     min: 1,   max: 20,  step: 0.5, def: 4,   fmt: v => v + ' : 1' },
    { key: 'attack',    id: 'cp-attack',    min: 2,   max: 400, step: 1,   def: 20,  fmt: v => v + ' ms' },
    { key: 'release',   id: 'cp-release',   min: 10,  max: 800, step: 10,  def: 250, fmt: v => v + ' ms' },
    { key: 'knee',      id: 'cp-knee',      min: 1,   max: 10,  step: 0.5, def: 4,   fmt: v => v + ' dB' },
    { key: 'makeup',    id: 'cp-makeup',    min: 0,   max: 24,  step: 0.5, def: 6,   fmt: v => '+' + v + ' dB' },
    { key: 'rmsPeak',   id: 'cp-rmspeak',   min: 0,   max: 1,   step: 0.1, def: 0.2, fmt: v => (v <= 0.15 ? 'RMS寄り' : v >= 0.85 ? 'ピーク寄り' : '中間') + ' (' + v + ')' },
  ];

  // プリセット。大きい音のピーク(0 dBFS)が補正後も割れないように makeup を控えめにしてある
  const PRESETS = [
    { id: 'weak',   name: '弱（自然に整える）',          p: { threshold: -16, ratio: 2, attack: 30, release: 300, knee: 4, makeup: 3,  rmsPeak: 0.2 } },
    { id: 'std',    name: '標準（映画・ドラマ向け）',    p: { threshold: -20, ratio: 4, attack: 20, release: 250, knee: 4, makeup: 6,  rmsPeak: 0.2 } },
    { id: 'strong', name: '強（爆発音を強く抑える）',    p: { threshold: -26, ratio: 8, attack: 10, release: 200, knee: 3, makeup: 10, rmsPeak: 0.2 } },
    { id: 'night',  name: '夜間（小さい音量でも聞こえる）', p: { threshold: -30, ratio: 6, attack: 10, release: 300, knee: 4, makeup: 14, rmsPeak: 0.2 } },
  ];

  const $ = id => document.getElementById(id);
  const api = () => window.electronAPI;
  const say = (m, ms) => { try { if (typeof toast === 'function') toast(m, ms); } catch (_) {} };

  let available = false;
  let wired = false;
  let st = { enabled: false, preset: 'std', params: defParams() };
  let boost = { level: 100 };   // 音量ブーストは常に有効（100% = 変化なし）
  let lastSig = null;       // 最後にネイティブへ送った設定（変わったときだけ送る）

  function defParams() { const o = {}; PARAMS.forEach(d => { o[d.key] = d.def; }); return o; }
  function clampP(d, v) {
    v = Number(v);
    if (!isFinite(v)) v = d.def;
    v = Math.round(v / d.step) * d.step;
    v = Math.max(d.min, Math.min(d.max, v));
    return Math.round(v * 100) / 100;
  }
  function normalizeComp(c) {
    const s = c || {};
    const params = defParams();
    PARAMS.forEach(d => { if (s.params && s.params[d.key] !== undefined) params[d.key] = clampP(d, s.params[d.key]); });
    const known = s.preset === 'custom' || PRESETS.some(p => p.id === s.preset);
    return { enabled: s.enabled === true, preset: known ? s.preset : 'std', params };
  }
  function normalizeBoost(b) {
    const s = b || {};
    let lv = Math.round(Number(s.level) / 5) * 5;
    if (!isFinite(lv)) lv = 100;
    return { level: Math.max(100, Math.min(200, lv)) };
  }

  // ── 音量ブースト ──
  function updateGain() {
    window.__volGain = boost.level / 100;
    try { if (typeof window.applyVolume === 'function') window.applyVolume(); } catch (_) {}
  }

  // ── ネイティブへの反映 ──
  function payload() {
    return Object.assign({ enabled: st.enabled }, st.params);
  }
  function sig() { return JSON.stringify(st.enabled ? payload() : { enabled: false }); }
  function send(announce) {
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    try { api() && api().compSet && api().compSet(payload()); } catch (_) {}
    if (announce) say(st.enabled ? 'コンプレッサーを適用しました（音が一瞬途切れます）' : 'コンプレッサーをオフにしました', 2200);
  }

  // ── 設定の保存 ──
  function save() {
    try {
      api() && api().saveSettings && api().saveSettings({
        comp: { enabled: st.enabled, preset: st.preset, params: Object.assign({}, st.params) },
        boost: { enabled: true, level: boost.level },
      });
    } catch (_) {}
  }

  // ───────── 入力→出力グラフ（伝達曲線） ─────────
  // 横軸=入力レベル、縦軸=出力レベル(dB)。斜めの点線が「何もしない」状態で、折れ線がそこからどれだけ離れるかが効き具合。
  // 白い点は再生中の音の大きさ（端末側が測った出力レベルから、曲線上の位置を逆算した目安）。
  const G_MIN = -60;
  const G_COL = { clean: '#3ddc84', knee: '#4aa3ff', comp: '#ff5a5a' };
  let gLevel = -100, gDot = null, gRaf = 0, gVisible = false, gPerm = '';

  // 入力 x(dB) → 出力 y(dB)。ソフトニー（しきい値の前後 knee dB をなめらかにつなぐ）+ メイクアップ
  function curveY(x, p) {
    const T = p.threshold, R = Math.max(1, p.ratio), K = Math.max(0.01, p.knee);
    let y;
    if (x < T - K) y = x;
    else if (x <= T + K) y = x + (1 / R - 1) * Math.pow(x - T + K, 2) / (4 * K);
    else y = T + (x - T) / R;
    return y + p.makeup;
  }
  const zoneOf = (x, p) => (x < p.threshold - p.knee ? 'clean' : x <= p.threshold + p.knee ? 'knee' : 'comp');

  function gDraw() {
    gRaf = 0;
    const cv = $('cp-graph');
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w < 20 || h < 20) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0a0f0c';
    c.fillRect(0, 0, w, h);

    const p = st.params, on = st.enabled;
    const yMax = Math.max(0, Math.ceil(Math.max(0, curveY(0, p)) / 6) * 6);       // 出力側は +メイクアップぶん上に伸ばす
    const L = 30, R = 8, T = 8, B = 32;
    const pw = w - L - R, ph = h - T - B;
    const X = v => L + (v - G_MIN) / (0 - G_MIN) * pw;
    const Y = v => T + (yMax - v) / (yMax - G_MIN) * ph;

    // 方眼と目盛り
    c.lineWidth = 1;
    c.font = '9px sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.textAlign = 'right'; c.textBaseline = 'middle';
    for (let v = G_MIN; v <= yMax; v += 12) {
      const y = Math.round(Y(v)) + 0.5;
      c.strokeStyle = v === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
      c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
      c.fillText(String(v), L - 4, y);
    }
    c.textAlign = 'center'; c.textBaseline = 'top';
    for (let v = G_MIN; v <= 0; v += 12) {
      const x = Math.round(X(v)) + 0.5;
      c.strokeStyle = v === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + ph); c.stroke();
      c.fillText(String(v), x, T + ph + 4);
    }
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.textAlign = 'right'; c.textBaseline = 'bottom';
    c.fillText('入力 dB →', L + pw, h - 2);
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillText('↑ 出力 dB', L + 4, T + 3);

    c.save();
    c.beginPath(); c.rect(L, T, pw, ph); c.clip();

    // 「何もしない」基準線（入力 = 出力）
    c.setLineDash([4, 4]);
    c.strokeStyle = 'rgba(255,255,255,0.3)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(X(G_MIN), Y(G_MIN)); c.lineTo(X(Math.min(0, yMax)), Y(Math.min(0, yMax))); c.stroke();

    // しきい値の縦線
    const tx = X(p.threshold);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.beginPath(); c.moveTo(tx, T); c.lineTo(tx, T + ph); c.stroke();
    c.setLineDash([]);

    // 折れ線（区間ごとに色分け）。オフのときは薄く表示（設定のプレビュー）
    c.lineWidth = 2.6; c.lineCap = on ? 'round' : 'butt'; c.lineJoin = 'round';   // 薄表示のときは継ぎ目が重ならないように
    c.globalAlpha = on ? 1 : 0.35;
    let prevX = G_MIN, prevY = curveY(G_MIN, p);
    for (let x = G_MIN + 0.5; x <= 0.0001; x += 0.5) {
      const y = curveY(x, p), z = zoneOf(x - 0.25, p);
      c.strokeStyle = G_COL[z];
      c.beginPath(); c.moveTo(X(prevX), Y(prevY)); c.lineTo(X(x), Y(y)); c.stroke();
      prevX = x; prevY = y;
    }
    c.globalAlpha = 1;

    // 今の音量（白い点）: 測った出力レベルを、曲線上の入力位置へ逆算して置く
    if (gDot != null) {
      let ix = null;
      if (!on) ix = gDot;                                      // オフ: 入力 = 出力
      else {
        let lo = G_MIN, hi = 0;
        if (gDot <= curveY(lo, p)) ix = lo; else if (gDot >= curveY(hi, p)) ix = hi;
        else { for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (curveY(m, p) < gDot) lo = m; else hi = m; } ix = (lo + hi) / 2; }
      }
      const iy = on ? curveY(ix, p) : ix;
      const px = X(ix), py = Y(iy);
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.beginPath(); c.arc(px, py, 8, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill();
    }
    c.restore();

    // 説明（数字で確認できるように）
    const sum = $('cp-summary');
    if (sum && !gPerm) {
      const o0 = curveY(0, p), o40 = curveY(-40, p);
      const f = v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10);
      sum.classList.remove('warn');
      sum.textContent = '大きい音(0 dB) → ' + f(o0) + ' dB ／ 小さい音(−40 dB) → ' + f(o40) + ' dB'
        + '　差 ' + Math.round((o0 - o40) * 10) / 10 + ' dB（元は 40 dB）' + (on ? '' : '　※オフ中の見本');
    }
  }
  function gKick() { if (!gRaf) gRaf = requestAnimationFrame(gDraw); }

  function gWire() {
    const cv = $('cp-graph');
    if (!cv) return;
    try { new ResizeObserver(gKick).observe(cv); } catch (_) { window.addEventListener('resize', gKick); }
    window.addEventListener('vlc-level', e => {
      const v = Number(e.detail);
      // 測定は 8bit のため -48 dB より下は粗い。無音・極小は点を消す
      const target = (isFinite(v) && v > -48) ? v : null;
      if (target == null) gDot = null;
      else gDot = (gDot == null) ? target : gDot + (target - gDot) * 0.5;
      if (gVisible) gKick();
    });
    window.addEventListener('vlc-analyzer', e => {
      const s = e.detail;
      const sum = $('cp-summary');
      gPerm = (s === 'denied') ? 'denied' : '';
      if (sum && gPerm) { sum.classList.add('warn'); sum.textContent = '「今の音量」の白い点は、音声の録音権限を許可すると表示されます（折れ線は権限なしで使えます）'; }
      else gKick();
    });
    // コンプ画面を開いている間だけ、端末側の音量測定を動かす
    const drawer = $('drawer');
    if (drawer) {
      const check = () => {
        const vis = drawer.classList.contains('open') && drawer.classList.contains('comp-open');
        if (vis === gVisible) return;
        gVisible = vis;
        try { api() && typeof api().analyzerSet === 'function' && api().analyzerSet(vis, 'comp'); } catch (_) {}
        if (!vis) gDot = null;
        gKick();
      };
      try { new MutationObserver(check).observe(drawer, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
      check();
    }
  }

  // ── 描画 ──
  function renderParam(d) {
    const el = $(d.id), val = $(d.id + '-val');
    if (el) el.value = st.params[d.key];
    if (val) val.textContent = d.fmt(st.params[d.key]);
  }
  function renderAll() {
    gKick();
    $('cp-toggle')?.classList.toggle('on', st.enabled);
    $('comp-panel')?.classList.toggle('off', !st.enabled);
    $('comp-btn')?.classList.toggle('on', st.enabled || (boost.level > 100));
    PARAMS.forEach(renderParam);
    const sel = $('cp-preset-sel');
    if (sel) sel.value = st.preset;
    // 音量ブースト（常に表示）
    const lv = $('boost-level');
    if (lv) lv.value = boost.level;
    const lvv = $('boost-level-val');
    if (lvv) lvv.textContent = boost.level + '%';
  }

  function buildPresetSelect() {
    const sel = $('cp-preset-sel');
    if (!sel) return;
    sel.innerHTML = '';
    const add = (val, text) => { const o = document.createElement('option'); o.value = val; o.textContent = text; sel.appendChild(o); };
    add('custom', 'カスタム（手動調整）');
    PRESETS.forEach(p => add(p.id, p.name));
  }

  // ── 操作 ──
  function applyPreset(id) {
    const p = PRESETS.find(x => x.id === id);
    if (!p) return;
    PARAMS.forEach(d => { st.params[d.key] = clampP(d, p.p[d.key]); });
    st.preset = id;
    st.enabled = true;
    renderAll();
    save();
    send(true);
  }

  // コンプレッサーを初期値（標準プリセットの値）に戻す。オン/オフはそのまま
  function resetComp() {
    st.params = defParams();
    st.preset = 'std';
    renderAll();
    save();
    send(true);
  }

  function wire() {
    if (wired) return;
    wired = true;

    $('cp-reset')?.addEventListener('click', resetComp);

    $('cp-toggle')?.addEventListener('click', () => {
      st.enabled = !st.enabled;
      renderAll();
      save();
      send(true);
    });

    $('cp-preset-sel')?.addEventListener('change', e => {
      const id = e.target.value;
      if (id === 'custom') { st.preset = 'custom'; renderAll(); save(); return; }
      applyPreset(id);
    });

    PARAMS.forEach(d => {
      const el = $(d.id);
      if (!el) return;
      // ドラッグ中は表示だけ更新し、指を離したとき(change)に 1 回だけ適用する（適用のたびに開き直すため）
      el.addEventListener('input', () => {
        st.params[d.key] = clampP(d, el.value);
        st.preset = 'custom';
        const sel = $('cp-preset-sel');
        if (sel) sel.value = 'custom';
        const val = $(d.id + '-val');
        if (val) val.textContent = d.fmt(st.params[d.key]);
        gKick();            // ドラッグ中も折れ線をその場で動かす
      });
      el.addEventListener('change', () => {
        st.params[d.key] = clampP(d, el.value);
        st.preset = 'custom';
        st.enabled = true;       // 手動で触ったら自動でオン
        renderAll();
        save();
        send(true);
      });
    });

    $('boost-level')?.addEventListener('input', () => {
      boost.level = normalizeBoost({ level: $('boost-level').value }).level;
      const v = $('boost-level-val');
      if (v) v.textContent = boost.level + '%';
      $('comp-btn')?.classList.toggle('on', st.enabled || (boost.level > 100));
      updateGain();            // 音量は再生中にその場で反映される（途切れない）
    });
    $('boost-level')?.addEventListener('change', save);
    $('boost-reset')?.addEventListener('click', () => {
      boost.level = 100;
      renderAll();
      updateGain();
      save();
    });
  }

  function init(savedComp, savedBoost) {
    available = !!(api() && typeof api().compAvailable === 'function' && api().compAvailable());
    st = normalizeComp(savedComp);
    boost = normalizeBoost(savedBoost);
    const btn = $('comp-btn');
    if (!available) {               // ブラウザなどネイティブが無い環境では使えない
      if (btn) btn.style.display = 'none';
      window.__volGain = 1;
      return;
    }
    buildPresetSelect();
    wire();
    gWire();
    renderAll();
    updateGain();
    send(false);                    // 動画を開く前でも効くように、先にネイティブへ渡す
  }

  window.COMP = { init };
})();
