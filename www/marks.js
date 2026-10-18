/* marks.js — タイムスタンプ（位置に名前をつけて保存）と A-B ループの保存
 *
 *  - 画面は字幕タイムラインのタブ（字幕 / タイムスタンプ / A-B）。MARK ボタンや専用パネルは無い
 *  - タイムスタンプ: 「＋ 今の位置を保存」で追加（名前は「タイムスタンプ 1」…。✎ で変更）。行をタップするとその位置へ戻る（ループはしない）
 *  - A-B: 今の A-B 区間を「今の A-B を保存」で名前つき保存。行をタップするとその区間でループ再生
 *  - 最後に使っていた A-B 区間は、動画を開き直したときに自動で復元する
 *  - 全画面中はタイムラインが隠れるため、コントロールに小さな「保存」ボタンを出せる（設定でオン/オフ。既定オン）
 *  - 動画ごとに記憶（キーは動画のファイル名|サイズ|更新日時。再生位置の履歴と同じ）
 *  - 保存期間: 設定で 7 日 / 30 日 / 90 日 / 無制限。「最後にその動画を開いた日」から数え、過ぎた記録は起動時に自動削除
 *  - 手動削除: 個別（×）・この動画の記録をすべて・全動画の記録をすべて（設定）
 *  - 保存は electronAPI.marks*（android-shim.js）。再生位置の履歴とは別に保存するので、そちらは消えない
 *
 * 外部から使うもの（player.js から）:
 *   MARKS.bind(host)                … host = { getFile, getTime, getDuration, seek, getAb, setAb, toast, fmtTime }
 *   MARKS.init(保存済みの設定, 前回のタブ) … applyInitSettings() から
 *   MARKS.onFileLoaded(key)         … loadFile() の頭
 *   MARKS.onMetadata()              … loadedmetadata のとき（前回の A-B 復元・目印の再配置）
 *   MARKS.onAbChanged()             … A-B が変わったとき
 */
(function () {
  'use strict';

  const MAX_MARKERS = 200;
  const MAX_LOOPS = 50;
  const NAME_MAX = 30;
  const RETENTION = [7, 30, 90, 0];       // 日。0 = 無制限
  const DEFAULT_DAYS = 90;
  const MIN_LOOP = 0.5;                   // A-B の最小幅（秒。player.js の abClick と同じ）
  const TABS = ['sub', 'ts', 'ab'];

  const $ = id => document.getElementById(id);
  const api = () => window.electronAPI;
  let host = null;
  let retentionDays = DEFAULT_DAYS;
  let cur = blank();                      // 今開いている動画の記録
  let curKey = null;
  let pendingActive = null;               // 前回の A-B。loadedmetadata で復元する
  let restoring = false;
  let metaSeen = false;                   // 今の動画の長さが確定したか（前の動画の長さで目印を置かないため）
  let wired = false;
  let editing = null;                     // 名前を編集中の { kind, id }
  let quickButton = true;                 // 全画面のコントロールに「保存」ボタンを出すか
  let tab = 'sub';
  let uid = 0;

  function blank() { return { markers: [], loops: [], active: null }; }
  const say = (m, ms) => { try { host && host.toast && host.toast(m, ms); } catch (_) {} };
  const fmt = t => (host && host.fmtTime ? host.fmtTime(t) : String(Math.round(t)));
  const newId = () => Date.now().toString(36) + (++uid).toString(36);
  const num = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
  const cleanName = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

  // 保存データを安全な形に整える（壊れた値・古い形式を捨てる）
  function normalize(e) {
    const o = blank();
    if (!e || typeof e !== 'object') return o;
    (Array.isArray(e.markers) ? e.markers : []).forEach(m => {
      const t = m && num(m.t);
      if (t != null && o.markers.length < MAX_MARKERS) o.markers.push({ id: String(m.id || newId()), t, name: cleanName(m.name) });
    });
    (Array.isArray(e.loops) ? e.loops : []).forEach(l => {
      const a = l && num(l.a), b = l && num(l.b);
      if (a != null && b != null && b - a >= MIN_LOOP && o.loops.length < MAX_LOOPS) o.loops.push({ id: String(l.id || newId()), a, b, name: cleanName(l.name) });
    });
    o.markers.sort((x, y) => x.t - y.t);
    o.loops.sort((x, y) => x.a - y.a || x.b - y.b);
    const a = e.active && num(e.active.a), b = e.active && num(e.active.b);
    if (a != null && b != null && b - a >= MIN_LOOP) o.active = { a, b };
    return o;
  }

  function persist() {
    if (!curKey) return;
    try { api() && api().marksSet && api().marksSet(curKey, cur); } catch (_) {}
  }
  const hasAny = () => cur.markers.length + cur.loops.length > 0;

  // ───────── 表示 ─────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function nextDefaultName(list, base) {
    const used = new Set(list.map(x => x.name));
    for (let i = list.length + 1; i < list.length + 1000; i++) if (!used.has(base + ' ' + i)) return base + ' ' + i;
    return base;
  }

  function row(kind, item) {
    const r = el('div', 'mk-row' + (kind === 'loop' ? ' loop' : ''));
    const jump = el('button', 'mk-time', kind === 'marker' ? fmt(item.t) : fmt(item.a) + ' – ' + fmt(item.b));
    jump.type = 'button';
    jump.setAttribute('aria-label', kind === 'marker' ? 'この位置へ戻る' : 'このループを再生');
    const go = () => (kind === 'marker' ? jumpTo(item) : playLoop(item));
    jump.addEventListener('click', go);
    r.appendChild(jump);

    if (editing && editing.kind === kind && editing.id === item.id) {
      const inp = el('input', 'eq-name-input mk-edit');
      inp.type = 'text'; inp.maxLength = NAME_MAX; inp.value = item.name; inp.autocomplete = 'off';
      let done = false;
      const commit = ok => {
        if (done) return;
        done = true;
        if (ok) item.name = cleanName(inp.value) || item.name;
        editing = null;
        if (ok) persist();
        render();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') commit(false); });
      inp.addEventListener('blur', () => commit(true));
      r.appendChild(inp);
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
    } else {
      const name = el('button', 'mk-name', item.name || (kind === 'marker' ? 'タイムスタンプ' : 'ループ'));
      name.type = 'button';
      name.addEventListener('click', go);
      r.appendChild(name);
      const ed = el('button', 'mk-btn', '✎');
      ed.type = 'button'; ed.title = '名前を変える'; ed.setAttribute('aria-label', '名前を変える');
      ed.addEventListener('click', () => { editing = { kind, id: item.id }; render(); });
      r.appendChild(ed);
    }
    const del = el('button', 'mk-btn', '×');
    del.type = 'button'; del.title = '削除'; del.setAttribute('aria-label', '削除');
    del.addEventListener('click', () => remove(kind, item.id));
    r.appendChild(del);
    return r;
  }

  function render() {
    const mk = $('mk-list'), lp = $('mk-loops');
    if (mk) {
      mk.innerHTML = '';
      if (!cur.markers.length) mk.appendChild(el('div', 'mk-pane-empty', curKey ? 'タイムスタンプはまだありません\n「＋ 今の位置を保存」で追加できます' : '動画を開くと保存できます'));
      cur.markers.forEach(m => mk.appendChild(row('marker', m)));
    }
    if (lp) {
      lp.innerHTML = '';
      if (!cur.loops.length) lp.appendChild(el('div', 'mk-pane-empty', '保存したループはまだありません\n「＋ 今の位置をAに保存」でA・Bを決めてから「今の A-B を保存」を押してください'));
      cur.loops.forEach(l => lp.appendChild(row('loop', l)));
    }
    document.querySelectorAll('.mk-pane-empty').forEach(e => { e.style.whiteSpace = 'pre-line'; });
    const n1 = $('mk-count-ts'), n2 = $('mk-count-ab');
    if (n1) n1.textContent = cur.markers.length ? String(cur.markers.length) : '';
    if (n2) n2.textContent = cur.loops.length ? String(cur.loops.length) : '';
    const add = $('mk-add'), sv = $('mk-save-loop'), q = $('mk-quick'), qa = $('mk-quick-ab'), aa = $('mk-add-ab');
    const abNow = host && host.getAb ? host.getAb() : null;
    const needB = !!(abNow && abNow.a != null && abNow.b == null);
    if (aa) { aa.disabled = !curKey; aa.textContent = needB ? '＋ 今の位置をBに保存' : '＋ 今の位置をAに保存'; }
    if (qa) { qa.disabled = !curKey; qa.textContent = needB ? 'B保存' : 'A保存'; qa.classList.toggle('setA', needB); }
    if (add) add.disabled = !curKey;
    if (sv) sv.disabled = !curKey || !validAb();
    if (q) q.disabled = !curKey;
    document.querySelectorAll('.mk-clear-cur').forEach(b => { b.disabled = !curKey || (!hasAny() && !cur.active); });
    renderAbNow();
    renderTicks();
  }

  function renderAbNow() {
    const e = $('mk-ab-now');
    if (!e) return;
    const ab = host && host.getAb ? host.getAb() : null;
    e.textContent = ab && ab.a != null && ab.b != null ? '今の区間: ' + fmt(ab.a) + ' – ' + fmt(ab.b)
      : ab && ab.a != null ? 'A 地点: ' + fmt(ab.a) + '（B を打ってください）'
      : '「＋ 今の位置をAに保存」で区間を決めてください';
  }

  // シークバー上のマーカー位置
  function renderTicks() {
    const box = $('mk-ticks');
    if (!box) return;
    box.innerHTML = '';
    if (!metaSeen) return;
    const dur = host && host.getDuration ? host.getDuration() : 0;
    if (!isFinite(dur) || dur <= 0) return;
    cur.markers.forEach(m => {
      if (m.t > dur) return;
      const t = el('div', 'mk-tick');
      t.style.left = (m.t / dur * 100) + '%';
      box.appendChild(t);
    });
  }

  // ───────── 操作 ─────────
  function validAb() {
    const ab = host && host.getAb ? host.getAb() : null;
    return !!(ab && ab.a != null && ab.b != null && ab.b - ab.a >= MIN_LOOP);
  }

  function addMarker() {
    if (!curKey || !host) return;
    if (cur.markers.length >= MAX_MARKERS) { say('タイムスタンプは 1 本の動画につき ' + MAX_MARKERS + ' 個までです'); return; }
    const t = host.getTime();
    if (!isFinite(t) || t < 0) return;
    if (cur.markers.some(m => Math.abs(m.t - t) < 0.5)) { say('この位置には保存済みのタイムスタンプがあります'); return; }
    const name = nextDefaultName(cur.markers, 'タイムスタンプ');
    cur.markers.push({ id: newId(), t, name });
    cur.markers.sort((x, y) => x.t - y.t);
    persist(); render();
    say('タイムスタンプを保存しました（' + fmt(t) + '）');
  }

  function saveLoop() {
    if (!curKey || !host) return;
    if (!validAb()) { say('先に「A保存」で区間（A と B）を決めてください'); return; }
    const { a, b } = host.getAb();
    const dup = cur.loops.find(l => Math.abs(l.a - a) < 0.05 && Math.abs(l.b - b) < 0.05);
    if (dup) { say('同じ区間が「' + (dup.name || 'ループ') + '」として保存済みです'); return; }
    if (cur.loops.length >= MAX_LOOPS) { say('ループは 1 本の動画につき ' + MAX_LOOPS + ' 個までです'); return; }
    const name = nextDefaultName(cur.loops, 'ループ');
    cur.loops.push({ id: newId(), a, b, name });
    cur.loops.sort((x, y) => x.a - y.a || x.b - y.b);
    persist(); render();
    say('ループを保存しました（' + fmt(a) + ' – ' + fmt(b) + '）');
  }

  // 今の位置を A → B の順に保存する。B を打つとループとして一覧にも保存。両方済みなら新しい A から始める
  function markAb() {
    if (!curKey || !host) return;
    const t = host.getTime();
    if (!isFinite(t) || t < 0) return;
    const ab = host.getAb() || {};
    if (ab.a == null || ab.b != null) {
      host.setAb(t, null);
      say('A 地点を設定しました（' + fmt(t) + '）。もう一度押すと B 地点を保存します');
    } else {
      if (t - ab.a < MIN_LOOP) { say('B 地点は A より ' + MIN_LOOP + ' 秒以上あとにしてください'); return; }
      host.setAb(ab.a, t);
      saveLoop();
    }
    render();
  }

  function jumpTo(m) { host && host.seek(m.t); }
  function playLoop(l) {
    if (!host) return;
    host.setAb(l.a, l.b);       // applyAb → onAbChanged で「最後に使った区間」も更新される
    host.seek(l.a, true);
    say('ループ再生: ' + (l.name || '') + '（' + fmt(l.a) + ' – ' + fmt(l.b) + '）');
  }

  function remove(kind, id) {
    const list = kind === 'marker' ? cur.markers : cur.loops;
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    persist(); render();
  }

  async function clearCurrent() {
    if (!curKey) return;
    if (!window.confirm('この動画のタイムスタンプと A-B ループの記録をすべて削除しますか？\n（再生位置の記録は消えません）')) return;
    cur = blank();
    editing = null;
    try { await (api() && api().marksClear && api().marksClear(curKey)); } catch (_) {}
    render(); refreshStats();
    say('この動画の記録を削除しました');
  }

  // ───────── 設定画面（保存期間・全削除） ─────────
  async function refreshStats() {
    const el = $('marks-stats');
    if (!el) return;
    let s = null;
    try { s = api() && api().marksStats ? await api().marksStats() : null; } catch (_) {}
    el.textContent = s ? (s.videos ? `${s.videos} 本の動画・タイムスタンプ ${s.markers} 個・ループ ${s.loops} 個を保存中` : '保存中の記録はありません') : '';
    const b = $('marks-clear-all');
    if (b) b.disabled = !s || s.videos === 0;
  }

  async function clearAll() {
    let s = null;
    try { s = await api().marksStats(); } catch (_) {}
    if (!s || !s.videos) { say('削除する記録はありません'); return; }
    if (!window.confirm(`すべての動画のタイムスタンプと A-B ループの記録（${s.videos} 本・タイムスタンプ ${s.markers} 個・ループ ${s.loops} 個）を削除しますか？\n元に戻せません。（再生位置の記録は消えません）`)) return;
    try { await api().marksClear(); } catch (_) {}
    cur = blank(); editing = null; pendingActive = null;
    render(); refreshStats();
    say('記録をすべて削除しました');
  }

  function saveSetting() {
    try { api() && api().saveSettings && api().saveSettings({ marks: { retentionDays, quickButton } }); } catch (_) {}
  }

  // ── タブ（字幕 / タイムスタンプ / A-B） ──
  function showTab(name, persistIt) {
    tab = TABS.includes(name) ? name : 'sub';
    const tl = $('timeline');
    if (tl) tl.dataset.tab = tab;
    document.querySelectorAll('.tl-tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (tab === 'ab') renderAbNow();
    if (persistIt) { try { api() && api().saveSettings && api().saveSettings({ timeline: { tab } }); } catch (_) {} }
  }

  function applyQuick() {
    $('mk-quick')?.classList.toggle('enabled', quickButton);
    $('mk-quick-ab')?.classList.toggle('enabled', quickButton);
    $('ab-btn')?.classList.toggle('enabled', quickButton);
    $('mk-quick-toggle')?.classList.toggle('on', quickButton);
  }

  async function prune() {
    try {
      const n = api() && api().marksPrune ? await api().marksPrune(retentionDays) : 0;
      if (n) say('保存期間（' + retentionLabel(retentionDays) + '）を過ぎた ' + n + ' 本の動画の記録を削除しました', 4000);
    } catch (_) {}
    refreshStats();
  }
  const retentionLabel = d => (d > 0 ? d + ' 日' : '無制限');

  function wire() {
    if (wired) return;
    wired = true;
    $('mk-add')?.addEventListener('click', addMarker);
    $('mk-save-loop')?.addEventListener('click', saveLoop);
    document.querySelectorAll('.mk-clear-cur').forEach(b => b.addEventListener('click', clearCurrent));
    $('marks-clear-all')?.addEventListener('click', clearAll);
    $('mk-quick')?.addEventListener('click', addMarker);
    $('mk-add-ab')?.addEventListener('click', markAb);
    $('mk-quick-ab')?.addEventListener('click', markAb);
    $('mk-quick-toggle')?.addEventListener('click', () => {
      quickButton = !quickButton;
      applyQuick();
      saveSetting();
    });
    document.querySelectorAll('.tl-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab, true)));
    const sel = $('marks-retention');
    sel?.addEventListener('change', () => {
      const d = Number(sel.value);
      retentionDays = RETENTION.includes(d) ? d : DEFAULT_DAYS;
      saveSetting();
      prune();                    // 短くしたらすぐ古い記録を整理する
    });
  }

  // ───────── player.js から呼ばれる ─────────
  function bind(h) { host = h; wire(); render(); }

  function init(saved, savedTab) {
    const d = saved && Number(saved.retentionDays);
    retentionDays = RETENTION.includes(d) ? d : DEFAULT_DAYS;
    quickButton = !(saved && saved.quickButton === false);
    applyQuick();
    showTab(savedTab);
    const sel = $('marks-retention');
    if (sel) sel.value = String(retentionDays);
    wire();
    prune();                      // 起動時に期限切れを自動削除
  }

  async function onFileLoaded(key) {
    curKey = key;
    cur = blank(); editing = null; pendingActive = null; metaSeen = false;
    render();
    let e = null;
    try { e = api() && api().marksGet ? await api().marksGet(key) : null; } catch (_) {}
    if (curKey !== key) return;   // 読み込み中に別の動画が開かれた
    cur = normalize(e);
    pendingActive = cur.active;
    render();
    if (metaSeen) onMetadata();   // 記録の読み込みより先に動画の長さが確定していたら、ここで復元する
  }

  // 動画の長さが分かったら、目印を置き直し、前回の A-B を復元する
  function onMetadata() {
    metaSeen = true;
    renderTicks();
    const p = pendingActive;
    pendingActive = null;
    if (!p || !host) return;
    const dur = host.getDuration();
    if (isFinite(dur) && dur > 0 && (p.a >= dur || p.b > dur + 1)) return;   // 別の長さの動画（同名で差し替えられた等）
    const ab = host.getAb();
    if (ab && ab.a != null) return;                                           // すでに利用者が A-B を触っている
    restoring = true;
    try { host.setAb(p.a, p.b); } finally { restoring = false; }
    say('前回の A-B ループを復元しました（' + fmt(p.a) + ' – ' + fmt(p.b) + '）。A-Bタブの「A-B解除」で解除できます', 3600);
  }

  function onAbChanged() {
    if (!curKey || restoring || !host) return;
    const ab = host.getAb();
    const next = ab && ab.a != null && ab.b != null && ab.b - ab.a >= MIN_LOOP ? { a: ab.a, b: ab.b } : null;
    const same = (!next && !cur.active) || (next && cur.active && Math.abs(next.a - cur.active.a) < 0.001 && Math.abs(next.b - cur.active.b) < 0.001);
    if (!same) { cur.active = next; persist(); }
    const sv = $('mk-save-loop');
    if (sv) sv.disabled = !curKey || !validAb();
    renderAbNow();
    render();
  }

  window.MARKS = { bind, init, onFileLoaded, onMetadata, onAbChanged, refreshStats, render, showTab };
})();
