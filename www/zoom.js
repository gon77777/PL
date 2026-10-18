/* zoom.js — 動画のピンチ拡大・ドラッグ移動
 *
 *  - 指 2 本でピンチ: 拡大 / 縮小（1〜6 倍）。つまんだ位置を中心に拡大する
 *  - 拡大中は指 1 本のドラッグで移動
 *  - 拡大中に表示される「×1.5」チップをタップで等倍に戻す
 *  - 映像は WebView の背面にネイティブ描画されているので、ネイティブ(libVLC)の映像ビューを変形する。
 *    ネイティブが無い環境(<video>)では CSS transform で拡大する
 */
(function () {
  'use strict';
  const MIN = 1, MAX = 6;
  const box = document.getElementById('videobox');
  // 実際の再生オブジェクト（ネイティブ時は NativeVideo。player.js が window.__vid で公開）
  const getVid = () => window.__vid || document.getElementById('vid');
  const chip = document.getElementById('zoom-chip');
  if (!box) return;

  let s = 1, tx = 0, ty = 0;
  let gestured = 0;            // 直近にピンチ/ドラッグ操作があった時刻（直後のタップ扱いを防ぐ）
  let mode = null;             // 'pinch' | 'pan' | null
  let p0 = null;               // ジェスチャ開始時の状態

  const now = () => performance.now();
  const locked = () => document.body.classList.contains('locked');
  const loaded = () => box.classList.contains('loaded');

  function clampPan() {
    const r = box.getBoundingClientRect();
    const mx = (s - 1) * r.width / 2, my = (s - 1) * r.height / 2;
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }

  function apply() {
    if (s < 1.001) { s = 1; tx = 0; ty = 0; }
    const vid = getVid();
    if (!vid) return;
    if (vid.isNative) {
      vid.setZoom(s, tx, ty);
    } else {
      vid.style.transformOrigin = '50% 50%';
      vid.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    }
    if (chip) {
      chip.classList.toggle('show', s > 1);
      chip.textContent = '×' + (Math.round(s * 10) / 10).toFixed(1) + '  ✕';
    }
  }

  function reset() {
    s = 1; tx = 0; ty = 0; mode = null; p0 = null;
    apply();
  }

  // 2 本の指の中心（#videobox の中心を原点とした座標）と距離
  function pinchInfo(t) {
    const r = box.getBoundingClientRect();
    const a = t[0], b = t[1];
    return {
      cx: (a.clientX + b.clientX) / 2 - (r.left + r.width / 2),
      cy: (a.clientY + b.clientY) / 2 - (r.top + r.height / 2),
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    };
  }

  function startPinch(t) {
    const i = pinchInfo(t);
    p0 = { s, tx, ty, cx: i.cx, cy: i.cy, d: i.d };
    mode = 'pinch';
  }
  function startPan(t) {
    p0 = { s, tx, ty, x: t[0].clientX, y: t[0].clientY, moved: false };
    mode = 'pan';
  }

  box.addEventListener('touchstart', e => {
    if (locked() || !loaded()) return;
    if (e.touches.length >= 2) {
      startPinch(e.touches);
      gestured = now();
      e.preventDefault();
    } else if (e.touches.length === 1 && s > 1) {
      startPan(e.touches);
    }
  }, { passive: false });

  box.addEventListener('touchmove', e => {
    if (locked() || !mode) return;
    if (mode === 'pinch' && e.touches.length >= 2) {
      const i = pinchInfo(e.touches);
      const ns = Math.max(MIN * 0.9, Math.min(MAX, p0.s * i.d / p0.d));
      // つまんだ点の下にある映像上の点を、動かした中心に合わせる
      const ux = (p0.cx - p0.tx) / p0.s, uy = (p0.cy - p0.ty) / p0.s;
      s = ns;
      tx = i.cx - ns * ux;
      ty = i.cy - ns * uy;
      clampPan();
      apply();
      gestured = now();
      e.preventDefault();
    } else if (mode === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - p0.x, dy = e.touches[0].clientY - p0.y;
      if (!p0.moved && Math.hypot(dx, dy) < 8) return;   // 小さな揺れはタップ扱い
      p0.moved = true;
      tx = p0.tx + dx;
      ty = p0.ty + dy;
      clampPan();
      apply();
      gestured = now();
      e.preventDefault();
    }
  }, { passive: false });

  function onEnd(e) {
    if (!mode) return;
    if (e.touches.length >= 2) { startPinch(e.touches); return; }
    if (mode === 'pinch') {
      gestured = now();
      if (s < 1) s = 1;                        // 等倍より小さくしたら等倍へ戻す
      clampPan();
      apply();
      if (e.touches.length === 1 && s > 1) { startPan(e.touches); p0.moved = true; return; }
    } else if (mode === 'pan' && p0 && p0.moved) {
      gestured = now();
    }
    mode = null; p0 = null;
  }
  box.addEventListener('touchend', onEnd);
  box.addEventListener('touchcancel', onEnd);

  if (chip) {
    const hit = e => { e.preventDefault(); e.stopPropagation(); reset(); gestured = now(); };
    chip.addEventListener('click', hit);
    chip.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  }

  // 全画面 / 小窓 / 回転で枠の大きさが変わったら、はみ出しを補正（等倍へ戻す）
  let lastKey = '';
  setInterval(() => {
    const r = box.getBoundingClientRect();
    const key = Math.round(r.width) + 'x' + Math.round(r.height);
    if (key !== lastKey) { lastKey = key; if (s > 1) reset(); }
  }, 300);

  window.VideoZoom = {
    reset,
    get scale() { return s; },
    // 直前にピンチ/ドラッグ操作があったか（その直後の click は無視する）
    justGestured() { return now() - gestured < 350; },
  };
})();
