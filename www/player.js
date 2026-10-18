'use strict';
// renderer/player/player.js
// きゅうり動画 — プレイヤーウィンドウ レンダラー

// ─────────────────────────────────────────────
// DEFAULT SHORTCUTS
// ─────────────────────────────────────────────
const DEFAULT_SHORTCUTS = [
  { id:'playPause',  key:'Space',        label:'再生 / 一時停止',               enabled:true },
  { id:'seekBack5',  key:'←',            label:'5秒戻る',                       enabled:true },
  { id:'seekFwd5',   key:'→',            label:'5秒進む',                       enabled:true },
  { id:'seekBack30', key:'Shift+←',      label:'30秒戻る',                      enabled:true },
  { id:'seekFwd30',  key:'Shift+→',      label:'30秒進む',                      enabled:true },
  { id:'volUp',      key:'↑',            label:'音量アップ',                    enabled:true },
  { id:'volDown',    key:'↓',            label:'音量ダウン',                    enabled:true },
  { id:'mute',       key:'M',            label:'ミュート切替',                  enabled:true },
  { id:'fullscreen', key:'F',            label:'フルスクリーン切替',            enabled:true },
  { id:'speedDown',  key:'[',            label:'再生速度を下げる',              enabled:true },
  { id:'speedUp',    key:']',            label:'再生速度を上げる',              enabled:true },
  { id:'timeline',   key:'T',            label:'タイムライン 表示/非表示',      enabled:true },
  { id:'subtitle',   key:'S',            label:'映像上の字幕 表示/非表示',      enabled:true },
  { id:'simpleMode', key:'Ctrl+Shift+S', label:'シンプルモード 切替',           enabled:true },
  { id:'aotPlayer',  key:'Ctrl+Shift+P', label:'Always on Top（プレイヤー）',   enabled:true },
  { id:'aotTL',      key:'Ctrl+Shift+L', label:'Always on Top（タイムライン）', enabled:true },
  { id:'detachTL',   key:'Ctrl+Shift+T', label:'タイムライン独立ウィンドウ切替',enabled:true },
  { id:'globalSC',   key:'Ctrl+Shift+K', label:'ショートカット全体 ON/OFF',     enabled:true },
  { id:'abRepeat',   key:'A',            label:'A-Bリピート（A → B → 解除）',   enabled:true },
  { id:'plNext',     key:'N',            label:'次の動画',                      enabled:true },
  { id:'plPrev',     key:'P',            label:'前の動画（3秒以降は頭出し）',   enabled:true },
];

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let cfg = null;
let currentFile = null;
let subtitles = [];        // { id, start, end, text }[]
let subtitleTracks = [];   // { index, name }[]
let audioTracks = [];      // { index, name }[]
let subTrackIdx = 0;
// A-B リピート（秒）。A だけ設定済みのときは abB が null
let abA = null, abB = null;
// プレイリスト（ファイルキーの配列）と再生中の位置。連続再生は既定 OFF
let playlist = [];
let plIndex = -1;
let continuousPlay = false;
let repeatMode = 'off';    // くり返し再生: 'off' | 'one'（1 本をくり返す）| 'all'（プレイリスト全体をくり返す）
let lastRepeatAt = 0;      // 1 本リピートで同じ終了を二重に処理しないための時刻
let lastAdvanceSeq = -1;   // 同じ動画の終了で二重に次へ進まないための印
let audioTrackIdx = 0;
let activeSubIdx = -1;
let isSimple = false;
let tlVisible = true;
let tlDetached = false;
let subVisible = true;
let subBg = false;       // テロップ背景 ON/OFF（デフォルト OFF）
let subPos = 'bottom-center';
let subFontSize = 15;
let currentSpeed = 1;
let currentVol = 80;
let isMuted = false;
let scEnabled = true;
let scBindings = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
let rebindTarget = null;
let activeDrawer = null;
let posTimer = null;
let syncTimer = null;
let aotPlayer = true;

// Android 向けの状態
let doubleTapSec = 10;       // ダブルタップでスキップする秒数
let skipFrames = 1;           // 「フレーム」単位のとき 1 回で動かすフレーム数
let skipUnit = 'sec';          // スキップの単位: 'sec'(秒数) | 'frame'(フレーム数)。ダブルタップと ◀|▶ ボタンに適用
let isFs = false;            // 全画面（アプリ内表示 + ネイティブのイミーシブモード）
let orientMode = 'auto';     // 画面の向き: 'auto' | 'landscape' | 'portrait'
let fsAutoRotated = false;   // 全画面にしたとき自動で横向きにしたか
let inPip = false;           // 小窓（PiP）表示中
let tapHideMode = false;    // 全画面: タップ1回目=コントロールを隠す / 隠れた状態でタップ=一時停止（iPhone 式。既定 OFF）
let pauseOnUnplug = true;   // イヤホンを抜く / Bluetooth が切れたら一時停止
let backgroundPlay = true;  // 画面を消す / アプリを離れても音声を再生し続ける
let pipAuto = true;          // ホームに戻ると自動で小窓再生
let pipSupported = false;
let seeking = false;         // シークバー操作中
let controlsVisible = true;
let hideCtrlTimer = null;

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const appEl       = $('app');
// Android 実機では libVLC（ネイティブ）で再生する。ブラウザ等では従来どおり <video> を使う
const useVlc      = !!(window.NativeVideo && window.NativeVideo.available());
const vid         = useVlc ? window.NativeVideo.create() : $('vid');
window.__vid = vid;   // zoom.js が実際の再生オブジェクト(NativeVideo)を操作できるように公開
const simpleVid   = $('simple-vid');
const emptyState  = $('empty-state');
const dropOverlay = $('drop-overlay');
const pauseIcon   = $('pause-icon');
const subOverlay  = $('sub-overlay');
const simpleSub   = $('simple-sub');
const badgeSub    = $('badge-sub');
const badgeAudio  = $('badge-audio');
const badgeSpeed  = $('badge-speed');
const seekFill    = $('seekbar-fill');
const seekThumb   = $('seekbar-thumb');
const seekTip     = $('seek-tooltip');
const timeDisplay = $('time-display');
const playBtnEl   = $('play-btn');
const playIconEl  = $('play-icon');
const volBtn      = $('vol-btn');
const speedBtn    = $('speed-btn');
const speedMenu   = $('speed-menu');
const ccBtn       = $('cc-btn');
const ccMenu      = $('cc-menu');
const audioBtn    = $('audio-btn');
const audioMenu   = $('audio-menu');
const tlPanel     = $('timeline');
const tlList      = $('tl-list');
const tlCount     = $('tl-count');
const tlTrack     = $('tl-track');
const simpleWrap  = $('simple-wrap');
const simpleCtrl  = $('simple-ctrl');
const simplePlayEl= $('simple-play');
const simpleSeek  = $('simple-seek');
const simpleFill  = $('simple-fill');
const simpleTime  = $('simple-time');
const opSlider    = $('op-slider');
const exitSimple  = $('exit-simple');
const drawerEl    = $('drawer');
const settingsPanelEl  = $('settings-panel');
const shortcutsPanelEl = $('shortcuts-panel');
const playlistPanelEl  = $('playlist-panel');
const eqPanelEl        = $('eq-panel');
const compPanelEl      = $('comp-panel');
const scListEl    = $('sc-list');
const rebindNotice= $('rebind-notice');
const cancelRebind= $('cancel-rebind-btn');
const scOffBadge  = $('sc-off-badge');
const titleName   = $('title-name');
const aotBtn      = $('aot-btn');
const settingsBtn = $('settings-btn');
const scBtnEl     = $('sc-btn');
const sc2Toggle   = $('sc-toggle2');
const rotateBtn   = $('rotate-btn');
const pipBtn      = $('pip-btn');
const controlsEl  = $('controls');
const videoboxEl  = $('videobox');
const replayOverlay = $('replay-overlay');
if (useVlc) {
  document.body.classList.add('native');            // 背面のネイティブ映像が透けて見えるように CSS を切り替える
  window.NativeVideo.attachBox(videoboxEl);         // #videobox の位置をネイティブへ常時通知
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${p2(h)}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}
function p2(n) { return String(n).padStart(2, '0'); }

function pathToUrl(fp) {
  if (fp.startsWith('android://')) return window.__androidFiles.url(fp);
  // Windows: C:\foo\bar.mkv → file:///C:/foo/bar.mkv
  const normalized = fp.replace(/\\/g, '/');
  return normalized.startsWith('/') ? 'file://' + normalized : 'file:///' + normalized;
}

function basename(fp) { return fp.startsWith('android://') ? window.__androidFiles.name(fp) : fp.replace(/.*[\\/]/, ''); }

// ─────────────────────────────────────────────
// SUBTITLE PARSERS
// ─────────────────────────────────────────────
function parseSRT(text) {
  const result = [];
  const blocks = text.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const m = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const start = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
    const end   = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
    const ti = lines.indexOf(timeLine);
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (text) result.push({ id: result.length, start, end, text });
  }
  return result;
}

function parseASS(text) {
  const result = [];
  const lines = text.split('\n');
  let inEvents = false;
  let fmtCols = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '[Events]') { inEvents = true; continue; }
    if (t.startsWith('[') && t !== '[Events]') { inEvents = false; continue; }
    if (!inEvents) continue;
    if (t.startsWith('Format:')) {
      fmtCols = t.replace('Format:', '').split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if (!t.startsWith('Dialogue:')) continue;
    const vals = t.replace('Dialogue:', '').split(',');
    const get = col => { const i = fmtCols.indexOf(col); return i >= 0 ? (vals[i] || '').trim() : ''; };
    const pt = s => { const p = s.split(':'); return +p[0]*3600 + +p[1]*60 + parseFloat(p[2]||0); };
    const start = pt(get('start'));
    const end   = pt(get('end'));
    const ti = fmtCols.indexOf('text');
    const raw = ti >= 0 ? vals.slice(ti).join(',') : '';
    const clean = raw.replace(/\{[^}]+\}/g, '').replace(/\\N/gi, '\n').replace(/\\n/gi, '\n').trim();
    if (clean && isFinite(start) && isFinite(end)) result.push({ id: result.length, start, end, text: clean });
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

// ─────────────────────────────────────────────
// VOLUME
// ─────────────────────────────────────────────
function applyVolume() {
  // Android では音量バーを廃止し、端末の音量キーで操作する。
  // アプリ内の音量は常に 100% に固定（二重に小さくならないように）。
  vid.volume = 1;
  vid.muted = isMuted;
  simpleVid.volume = 1;
  updateVolIcon();
  window.electronAPI?.saveSettings({ playback: { volume: 100, muted: isMuted, speed: currentSpeed } });
}

function updateVolIcon() {
  const el = $('vol-icon');
  if (isMuted || currentVol === 0) {
    el.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2"></line><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2"></line>';
  } else if (currentVol < 40) {
    el.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
  } else {
    el.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
  }
}

function toggleMute() {
  isMuted = !isMuted;
  applyVolume();
}

function adjustVolume() {
  // Android: アプリ内音量は固定。端末の音量キーを使う。
}

// ─────────────────────────────────────────────
// SPEED
// ─────────────────────────────────────────────
function applySpeed(spd) {
  if (spd !== undefined) currentSpeed = spd;
  vid.playbackRate = currentSpeed;
  simpleVid.playbackRate = currentSpeed;
  const label = currentSpeed === 1 ? '1x' : currentSpeed + 'x';
  speedBtn.innerHTML = label + ' <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  speedMenu.querySelectorAll('.pop-item').forEach(el => {
    el.classList.toggle('selected', +el.dataset.val === currentSpeed);
  });
  if (currentSpeed !== 1) {
    badgeSpeed.textContent = currentSpeed + '×';
    badgeSpeed.style.display = '';
  } else {
    badgeSpeed.style.display = 'none';
  }
  window.electronAPI?.saveSettings({ playback: { volume: currentVol, muted: isMuted, speed: currentSpeed } });
}

function changeSpeed(dir) {
  const idx = SPEEDS.indexOf(currentSpeed);
  const ni = Math.max(0, Math.min(SPEEDS.length - 1, idx + dir));
  applySpeed(SPEEDS[ni]);
}

// ─────────────────────────────────────────────
// PLAY / PAUSE
// ─────────────────────────────────────────────
function togglePlay() {
  if (!currentFile) return;
  if (vid.ended) { replayFromStart(); return; }
  vid.paused ? vid.play() : vid.pause();
}

// 再生終了後のリプレイ表示（YouTube 風）
function showReplay(on) {
  if (!replayOverlay) return;
  replayOverlay.classList.toggle('show', !!on);
  if (on) {
    const replaySVG = '<path d="M3 12a9 9 0 1 0 3-6.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path><polyline points="3 3 3 9 9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>';
    playIconEl.innerHTML = replaySVG;
    simplePlayEl.querySelector('svg').innerHTML = replaySVG;
  }
}

function replayFromStart() {
  if (!currentFile) return;
  showReplay(false);
  vid.currentTime = 0;   // 終了後のシーク: ネイティブ側が開き直してその位置から再生する
  vid.play();
  showControls();
}

function setPlayIcon(playing) {
  if (playing) showReplay(false);
  const pauseSVG = '<line x1="6" y1="4" x2="6" y2="20" stroke="currentColor" stroke-width="2.5"></line><line x1="18" y1="4" x2="18" y2="20" stroke="currentColor" stroke-width="2.5"></line>';
  const playSVG  = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
  playIconEl.innerHTML = playing ? pauseSVG : playSVG;
  simplePlayEl.querySelector('svg').innerHTML = playing ? pauseSVG : playSVG;
}

// ─────────────────────────────────────────────
// SEEK
// ─────────────────────────────────────────────
function seek(delta) {
  if (!currentFile) return;
  if (vid.ended) { showReplay(false); vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + delta)); vid.play(); return; }
  vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + delta));
}

function clampFrames(v) {
  v = Math.round(+v);
  return isFinite(v) ? Math.max(1, Math.min(300, v)) : 1;
}

// フレーム送り/戻し（dir=1 / -1、設定のフレーム数ぶん）。再生中なら一時停止して動かす
function stepFrame(dir) {
  if (!currentFile) return;
  if (vid.stepFrame) { vid.stepFrame(dir, skipFrames); return; }
  // ネイティブ再生でない環境（<video>）: 30fps とみなして動かす
  vid.pause();
  vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + dir * skipFrames / 30));
}

// 細かいスキップ（◀|▶ ボタン）: 設定が「フレーム」ならコマ送り、「秒数」なら ±5 秒
function fineSkip(dir) {
  if (skipUnit === 'frame') stepFrame(dir);
  else seek(dir * 5);
}

function updateSkipUI() {
  const frame = skipUnit === 'frame';
  $('b5').title = frame ? `${skipFrames}フレーム戻る` : '5秒戻る';
  $('f5').title = frame ? `${skipFrames}フレーム進む` : '5秒進む';
  document.querySelectorAll('.size-btn[data-skipunit]').forEach(b => b.classList.toggle('active', b.dataset.skipunit === skipUnit));
  document.querySelectorAll('.dt-sec-row').forEach(r => r.style.opacity = frame ? '0.45' : '');
  document.querySelectorAll('.skip-frames-row').forEach(r => r.style.opacity = frame ? '' : '0.45');
  const fi = $('skip-frames-input');
  if (fi && document.activeElement !== fi) fi.value = skipFrames;
  document.querySelectorAll('.size-btn[data-skipframes]').forEach(b => b.classList.toggle('active', +b.dataset.skipframes === skipFrames));
}

function seekTo(time) {
  if (!currentFile) return;
  vid.currentTime = Math.max(0, Math.min(vid.duration || 0, time));
}

// ─────────────────────────────────────────────
// SUBTITLE DISPLAY
// ─────────────────────────────────────────────
function positionSubtitle() {
  const el = subOverlay;
  el.style.bottom = ''; el.style.top = ''; el.style.left = ''; el.style.right = ''; el.style.transform = '';
  if (subPos === 'top-center') {
    el.style.top = '14px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%)';
  } else if (subPos === 'bottom-left') {
    el.style.bottom = '14px'; el.style.left = '14px';
  } else if (subPos === 'bottom-right') {
    el.style.bottom = '14px'; el.style.right = '14px';
  } else { // bottom-center (default)
    el.style.bottom = '14px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%)';
  }
  el.style.fontSize = subFontSize + 'px';
  simpleSub.style.fontSize = subFontSize + 'px';
  applySubBackground();
  window.electronAPI?.saveSettings({ subtitle: { visible: subVisible, position: subPos, fontSize: subFontSize, track: subTrackIdx, bg: subBg } });
}

function applySubBackground() {
  if (subBg) {
    subOverlay.style.background = 'rgba(0,0,0,0.55)';
    subOverlay.style.borderRadius = '4px';
    subOverlay.style.padding = '2px 8px';
    simpleSub.style.background = 'rgba(0,0,0,0.55)';
    simpleSub.style.borderRadius = '4px';
    simpleSub.style.padding = '2px 8px';
  } else {
    subOverlay.style.background = '';
    subOverlay.style.borderRadius = '';
    subOverlay.style.padding = '';
    simpleSub.style.background = '';
    simpleSub.style.borderRadius = '';
    simpleSub.style.padding = '';
  }
}

function updateSubtitleDisplay(currentTime) {
  if (!subVisible || subtitles.length === 0) {
    subOverlay.style.display = 'none';
    simpleSub.style.display = 'none';
    return;
  }
  const entry = subtitles.find(s => currentTime >= s.start && currentTime < s.end);
  if (entry) {
    subOverlay.textContent = entry.text;
    subOverlay.style.display = '';
    simpleSub.textContent = entry.text;
    simpleSub.style.display = '';
    if (entry.id !== activeSubIdx) {
      activeSubIdx = entry.id;
      highlightTimelineRow(entry.id);
    }
  } else {
    subOverlay.style.display = 'none';
    simpleSub.style.display = 'none';
    activeSubIdx = -1;
  }
}

function highlightTimelineRow(id) {
  tlList.querySelectorAll('.tl-row').forEach(row => {
    const active = +row.dataset.id === id;
    row.classList.toggle('active', active);
    row.querySelector('.tl-dot')?.style.setProperty('display', active ? '' : 'none');
    if (active) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

// ─────────────────────────────────────────────
// TIMELINE PANEL
// ─────────────────────────────────────────────
function renderTimeline() {
  if (subtitles.length === 0) {
    tlList.innerHTML = '<div id="tl-empty">字幕データがありません</div>';
    tlCount.textContent = '0件';
    tlTrack.textContent = '';
    return;
  }
  tlCount.textContent = subtitles.length + '件';
  tlTrack.textContent = subtitleTracks[subTrackIdx]?.name || 'Track ' + subTrackIdx;

  const frag = document.createDocumentFragment();
  for (const s of subtitles) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.id = s.id;
    row.innerHTML = `
      <div class="tl-times">
        <span class="tl-start">${fmtTime(s.start)}</span>
        <span class="tl-sep">→</span>
        <span class="tl-end">${fmtTime(s.end)}</span>
        <span class="tl-dot" style="display:none"></span>
      </div>
      <div class="tl-text">${escHtml(s.text)}</div>`;
    row.addEventListener('click', () => seekTo(s.start));
    frag.appendChild(row);
  }
  tlList.innerHTML = '';
  tlList.appendChild(frag);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function applyTimelineVisibility() {
  document.body.classList.toggle('tl-off', !tlVisible || tlDetached);
  if (tlDetached) {
    tlPanel.style.display = 'none';
    $('tl-btn').classList.remove('active');
    window.electronAPI?.detachTimeline(true);
    window.electronAPI?.showTimelineWindow(tlVisible);
  } else {
    tlPanel.style.display = tlVisible ? 'flex' : 'none';
    $('tl-btn').classList.toggle('active', tlVisible);
    window.electronAPI?.showTimelineWindow(false);
  }
  window.electronAPI?.saveSettings({
    timeline: { visible: tlVisible, detached: tlDetached, alwaysOnTop: cfg?.timeline?.alwaysOnTop ?? true }
  });
}

// ─────────────────────────────────────────────
// SUBTITLE TRACKS (CC MENU)
// ─────────────────────────────────────────────
function rebuildCCMenu() {
  ccMenu.innerHTML = '<div class="pop-item" data-val="-1">字幕オフ</div>';
  subtitleTracks.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'pop-item' + (i === subTrackIdx ? ' selected' : '');
    el.dataset.val = i;
    el.textContent = t.name || `字幕 ${i + 1}`;
    ccMenu.appendChild(el);
  });
  ccMenu.querySelectorAll('.pop-item').forEach(el => {
    el.addEventListener('click', () => {
      const v = +el.dataset.val;
      selectSubtitleTrack(v);
      closePops();
    });
  });
}

function selectSubtitleTrack(idx) {
  subTrackIdx = idx;
  if (idx < 0) {
    subtitles = [];
    subVisible = false;
    badgeSub.textContent = 'CC OFF';
    badgeSub.style.display = '';
  } else {
    subVisible = true;
    badgeSub.style.display = 'none';
    // If track data is embedded in subtitleTracks
    if (subtitleTracks[idx]?.subs) {
      subtitles = subtitleTracks[idx].subs;
    }
  }
  ccMenu.querySelectorAll('.pop-item').forEach(el => el.classList.toggle('selected', +el.dataset.val === idx));
  renderTimeline();
  window.electronAPI?.notifySubtitleTrack(idx);
  window.electronAPI?.saveSettings({ subtitle: { visible: subVisible, position: subPos, fontSize: subFontSize, track: idx } });
  syncNativeSpu();
}

// ─────────────────────────────────────────────
// libVLC のトラック情報を UI に反映
//  - 音声: libVLC の音声トラックをそのまま切り替え可能（名前は MKV の情報があればそれを使う）
//  - 字幕: テキスト字幕(MKV)は従来どおり HTML で描画。画像字幕(PGS 等)・MP4 内蔵字幕などは libVLC が描画
// ─────────────────────────────────────────────
let mkvAudioTracks = [];
function applyNativeTracks() {
  const nt = vid.isNative ? vid.nativeTracks : null;
  if (!nt) return;
  const aud = (nt.audio || []).filter(t => t.id >= 0);
  const useMkvNames = mkvAudioTracks.length === aud.length;
  audioTracks = aud.map((t, i) => ({ index: i, id: t.id, name: (useMkvNames && mkvAudioTracks[i]?.name) || t.name }));
  const cur = audioTracks.findIndex(t => t.id === nt.audioCurrent);
  audioTrackIdx = cur >= 0 ? cur : 0;
  if (audioTracks[audioTrackIdx]) $('audio-label').textContent = audioTracks[audioTrackIdx].name;

  const spu = (nt.spu || []).filter(t => t.id >= 0);
  if (!subtitleTracks.length || subtitleTracks.every(t => t.native)) {
    subtitleTracks = spu.map((t, i) => ({ index: i, name: t.name, codec: 'native', subs: [], native: true, spuId: t.id }));
    if (subTrackIdx >= subtitleTracks.length) subTrackIdx = subtitleTracks.length ? 0 : -1;
    subtitles = [];
  } else {
    subtitleTracks.forEach((t, i) => { if (spu[i]) t.spuId = spu[i].id; });
  }
  rebuildCCMenu();
  rebuildAudioMenu();
  syncNativeSpu();
}

// 選択中の字幕トラックが「テキスト字幕」なら libVLC の字幕は消し（二重表示防止）、画像字幕等なら libVLC に描画させる
function syncNativeSpu() {
  if (!vid.isNative) return;
  const t = subTrackIdx >= 0 ? subtitleTracks[subTrackIdx] : null;
  const wantNative = !!(t && subVisible && (!t.subs || !t.subs.length) && t.spuId != null);
  vid.setSpuTrack(wantNative ? t.spuId : -1);
}

// ─────────────────────────────────────────────
// AUDIO TRACKS
// ─────────────────────────────────────────────
function rebuildAudioMenu() {
  audioMenu.innerHTML = '';
  if (audioTracks.length === 0) {
    audioMenu.innerHTML = '<div class="pop-item selected" data-val="0">—</div>';
    return;
  }
  audioTracks.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'pop-item' + (i === audioTrackIdx ? ' selected' : '');
    el.dataset.val = i;
    el.textContent = t.name || `音声 ${i + 1}`;
    el.addEventListener('click', () => {
      audioTrackIdx = i;
      if (vid.isNative && t.id != null) vid.setAudioTrack(t.id);   // libVLC の音声トラックを実際に切り替える
      $('audio-label').textContent = t.name || `音声 ${i + 1}`;
      badgeAudio.style.display = '';
      audioMenu.querySelectorAll('.pop-item').forEach(e => e.classList.toggle('selected', +e.dataset.val === i));
      closePops();
    });
    audioMenu.appendChild(el);
  });
}

// ─────────────────────────────────────────────
// SEEKBAR
// ─────────────────────────────────────────────
function updateSeekbar() {
  if (seeking) return; // ドラッグ中は指の位置を優先
  const pct = vid.duration ? (vid.currentTime / vid.duration) * 100 : 0;
  seekFill.style.width = pct + '%';
  seekThumb.style.left = pct + '%';
  const dur = vid.duration || 0;
  timeDisplay.textContent = fmtTime(vid.currentTime) + ' / ' + fmtTime(dur);
  // Simple mode
  simpleFill.style.width = pct + '%';
  simpleTime.textContent = fmtTime(vid.currentTime);
}

function seekbarAt(e, el) {
  const rect = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

// ─────────────────────────────────────────────
// SIMPLE MODE
// ─────────────────────────────────────────────
function toggleSimpleMode() {
  isSimple = !isSimple;
  applySimpleMode();
}

function applySimpleMode() {
  simpleWrap.classList.toggle('show', isSimple);
  if (isSimple && currentFile) {
    simpleVid.src = vid.src;
    simpleVid.currentTime = vid.currentTime;
    simpleVid.playbackRate = currentSpeed;
    simpleVid.volume = vid.volume;
    if (!vid.paused) simpleVid.play().catch(() => {});
  } else if (!isSimple && simpleVid.src) {
    vid.currentTime = simpleVid.currentTime;
    if (!simpleVid.paused) vid.play().catch(() => {});
    simpleVid.pause();
    simpleVid.src = '';
  }
  window.electronAPI?.saveSettings({ player: { simpleMode: isSimple, alwaysOnTop: aotPlayer } });
}

// ─────────────────────────────────────────────
// FULLSCREEN
// ─────────────────────────────────────────────
// HTML5 Fullscreen API は Capacitor の WebView では使えない（onShowCustomView が即閉じられる）ため、
// 「CSS による全画面レイアウト」＋「ネイティブでステータスバー/ナビゲーションバーを隠す」方式にしている。
const FS_ENTER_SVG = '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>';
const FS_EXIT_SVG  = '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line>';

function isLandscapeViewport() { return window.innerWidth > window.innerHeight; }

function toggleFullscreen() { setFullscreen(!isFs); }

function setFullscreen(on) {
  if (on === isFs) return;
  isFs = on;
  document.body.classList.toggle('fs', on);
  $('fs-icon').innerHTML = on ? FS_EXIT_SVG : FS_ENTER_SVG;
  closePops();
  if (on) {
    if (activeDrawer) toggleDrawer(activeDrawer);
    // 横長の動画を縦持ちのまま全画面にするときは、自動で横向きにする（YouTube と同じ挙動）
    if (orientMode === 'auto' && vid.videoWidth > vid.videoHeight && !isLandscapeViewport()) {
      fsAutoRotated = true;
      window.electronAPI?.setOrientation('landscape');
    }
  } else if (fsAutoRotated) {
    fsAutoRotated = false;
    window.electronAPI?.setOrientation(orientMode); // 全画面前の設定に戻す
  }
  window.electronAPI?.setImmersive(on);
  showControls();
}

// ─────────────────────────────────────────────
// ORIENTATION（画面の向き）
// ─────────────────────────────────────────────
function applyOrientation(mode) {
  orientMode = mode;
  fsAutoRotated = false;
  window.electronAPI?.setOrientation(mode);
  updateOrientUI();
}

function toggleOrientation() {
  // 今が横向きなら縦へ、縦向きなら横へ
  applyOrientation(isLandscapeViewport() ? 'portrait' : 'landscape');
}

function updateOrientUI() {
  rotateBtn.classList.toggle('active', orientMode !== 'auto');
  const sel = $('orient-sel');
  if (sel) sel.value = orientMode;
}

// ─────────────────────────────────────────────
// PICTURE IN PICTURE（小窓再生）
// ─────────────────────────────────────────────
async function enterPip() {
  if (!currentFile) return;
  if (!pipSupported) { toast('この端末は小窓再生に対応していません'); return; }
  const r = await window.electronAPI?.enterPip();
  if (!r?.entered) toast('小窓を開けませんでした。端末の設定でこのアプリの「ピクチャ イン ピクチャ」を許可してください');
}

function onPipChanged(e) {
  const active = !!(e && e.active);
  inPip = active;
  document.body.classList.toggle('pip', active);
  if (active) {
    closePops();
  } else if (e && e.dismissed) {
    vid.pause();          // 小窓の × で閉じられたら停止（YouTube と同じ）
  } else {
    showControls();
  }
}

// ─────────────────────────────────────────────
// A-B リピート
//   1回目のタップ: 現在位置を A に / 2回目: B に設定してループ開始 / 3回目: 解除
// ─────────────────────────────────────────────
function abClick() {
  if (!currentFile) return;
  const t = vid.currentTime;
  if (abA == null) {
    abA = t; abB = null;
    toast(`A 地点を設定（${fmtTime(t)}）。もう一度押すと B 地点を設定します`);
  } else if (abB == null) {
    if (t - abA < 0.5) { toast('B 地点は A より 0.5 秒以上あとに設定してください'); return; }
    abB = t;
    toast(`A-B リピート開始（${fmtTime(abA)} – ${fmtTime(abB)}）`);
  } else {
    abA = abB = null;
    toast('A-B リピートを解除しました');
  }
  applyAb();
}

// 「A-B解除」ボタン（A-Bタブ / 全画面のコントロール）: 解除専用（A/B の設定は「A保存」「＋ 今の位置をAに保存」で行う）
function abClear() {
  if (!currentFile) return;
  if (abA == null) { toast('A/B の設定は「A保存」ボタン（A-Bタブの「＋ 今の位置を…」）で行います'); return; }
  abA = abB = null;
  toast('A-B リピートを解除しました');
  applyAb();
}

function applyAb() {
  if (vid.isNative) vid.setAbLoop(abA, abB);   // 区間ループは端末側で処理（画面を消していても動く）
  updateAbUI();
  window.MARKS?.onAbChanged();                 // 動画ごとに「最後に使った A-B」を記憶
}

function updateAbUI() {
  const active = abA != null && abB != null;
  const title = abA != null ? (active ? 'A-Bリピート中（タップで解除）' : 'A 設定中（タップで解除）') : 'A-B 解除（設定は「A保存」ボタンで）';
  // 全画面のコントロールの「A-B解除」と、A-Bタブの「A-B解除」の両方を同じ状態にする
  for (const btn of [$('ab-btn'), $('ab-clear-tab')]) {
    if (!btn) continue;
    btn.classList.toggle('on', active);
    btn.classList.toggle('setA', abA != null && abB == null);
    btn.classList.toggle('idle', abA == null);
    btn.title = title;
  }
  updateAbMarkers();
}

// シークバー上に A / B の目印と区間を表示
function updateAbMarkers() {
  const dur = vid.duration;
  const ok = isFinite(dur) && dur > 0;
  const place = (el, v) => { el.style.display = (v != null && ok) ? 'block' : 'none'; if (v != null && ok) el.style.left = (v / dur * 100) + '%'; };
  place($('ab-mark-a'), abA);
  place($('ab-mark-b'), abB);
  const range = $('ab-range');
  if (abA != null && abB != null && ok) {
    range.style.display = 'block';
    range.style.left = (abA / dur * 100) + '%';
    range.style.width = ((abB - abA) / dur * 100) + '%';
  } else {
    range.style.display = 'none';
  }
}

// ─────────────────────────────────────────────
// プレイリスト / 連続再生
//   ・ファイル選択で複数選ぶと、ファイル名順のプレイリストになる
//   ・連続再生（既定 OFF）が ON のとき、最後まで再生したら次の動画へ自動で進む
// ─────────────────────────────────────────────
const naturalCompare = (a, b) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });

// ピッカーで選んだファイルを開く（1 本ならそのまま再生、複数ならプレイリストにして先頭から）
function openKeys(keys) {
  keys = [...new Set(keys)];
  if (!keys.length) return;
  if (keys.length > 1) {
    keys.sort((a, b) => naturalCompare(basename(a), basename(b)));
    playlist = keys;
  }
  loadFile(keys[0]);
}

async function addToPlaylist() {
  const picked = await window.electronAPI?.openFiles?.();
  if (!picked || !picked.length) return;
  const fresh = [...new Set(picked)].filter(k => !playlist.includes(k));
  if (!fresh.length) { toast('すべて追加済みです'); return; }
  fresh.sort((a, b) => naturalCompare(basename(a), basename(b)));
  const wasEmpty = playlist.length === 0;
  playlist = playlist.concat(fresh);
  updatePlaylistInfo();
  toast(`${fresh.length} 件を追加しました`);
  if (wasEmpty && !currentFile) loadFile(playlist[0]);
}

function clearPlaylist() {
  // 再生中の 1 本だけ残す
  playlist = currentFile ? [currentFile] : [];
  plIndex = currentFile ? 0 : -1;
  updatePlaylistInfo();
}

function removeFromPlaylist(i) {
  if (i === plIndex || i < 0 || i >= playlist.length) return;
  playlist.splice(i, 1);
  if (i < plIndex) plIndex--;
  updatePlaylistInfo();
}

function playlistPlay(i, opts) {
  if (i < 0 || i >= playlist.length) return;
  return loadFile(playlist[i], opts);
}

function playlistNext(auto) {
  if (plIndex >= 0 && plIndex + 1 < playlist.length) {
    toast('次へ: ' + basename(playlist[plIndex + 1]).replace(/\.[^.]+$/, ''), 2200);
    return playlistPlay(plIndex + 1, { fromStart: true });
  }
  if (repeatMode === 'all' && playlist.length > 1) {      // 全体リピート: 最後の次は先頭へ
    toast('先頭へ戻ります: ' + basename(playlist[0]).replace(/\.[^.]+$/, ''), 2200);
    return playlistPlay(0, { fromStart: true });
  }
  if (!auto) toast('最後の動画です');
}

function playlistPrev() {
  // 3 秒以上再生していたら頭出し、そうでなければ前の動画へ（一般的なプレイヤーと同じ）
  if (plIndex <= 0 || vid.currentTime > 3) { vid.currentTime = 0; if (vid.paused) vid.play().catch(() => {}); return; }
  toast('前へ: ' + basename(playlist[plIndex - 1]).replace(/\.[^.]+$/, ''), 2200);
  return playlistPlay(plIndex - 1, { fromStart: true });
}

function setContinuous(on) {
  continuousPlay = on;
  document.querySelectorAll('[data-toggle="continuous"]').forEach(t => t.classList.toggle('on', on));
  window.electronAPI?.saveSettings({ playback: { continuous: on } });
  updatePlaylistInfo();
}

const REPEAT_MODES = ['off', 'one', 'all'];
function setRepeat(mode, opts = {}) {
  repeatMode = REPEAT_MODES.includes(mode) ? mode : 'off';
  document.querySelectorAll('.repeat-sel').forEach(sel => { sel.value = repeatMode; });
  if (!opts.silent) window.electronAPI?.saveSettings({ playback: { repeat: repeatMode } });
  updatePlaylistInfo();
}

// 通知・ロック画面の「次へ/前へ」ボタンの有無、連続再生中の前面サービス維持、画面上の表示を更新
function updatePlaylistInfo() {
  const n = playlist.length;
  const hasNext = plIndex >= 0 && plIndex + 1 < n;
  const wraps = repeatMode === 'all' && n > 1;          // 全体リピート: 最後の動画でも次（先頭）がある
  window.electronAPI?.setMediaInfo?.({
    playlistNav: n > 1,
    hasPrev: plIndex > 0,
    hasNext: hasNext || wraps,
    continuous: (continuousPlay && hasNext) || wraps || repeatMode === 'one' || (repeatMode === 'all' && n <= 1),   // 終了後に自動で続く間は前面サービスを維持
  });
  $('pl-btn')?.classList.toggle('active', n > 1);
  const cnt = $('pl-count');
  if (cnt) cnt.textContent = n ? `（${plIndex >= 0 ? plIndex + 1 : '-'} / ${n}）` : '';
  if (activeDrawer === 'playlist') renderPlaylist();
}

function renderPlaylist() {
  const list = $('pl-list');
  if (!list) return;
  list.innerHTML = '';
  if (!playlist.length) {
    list.innerHTML = '<div class="pl-empty">プレイリストは空です<br/>「＋ 追加」から動画を選んでください</div>';
    return;
  }
  playlist.forEach((key, i) => {
    const row = document.createElement('div');
    row.className = 'pl-row' + (i === plIndex ? ' current' : '');
    const num = document.createElement('span');
    num.className = 'pl-num';
    num.textContent = i === plIndex ? '▶' : String(i + 1);
    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = basename(key);
    row.append(num, name);
    if (i !== plIndex) {
      const del = document.createElement('button');
      del.className = 'pl-del';
      del.title = 'リストから削除';
      del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); removeFromPlaylist(i); });
      row.appendChild(del);
    }
    row.addEventListener('click', () => {
      toggleDrawer('playlist');             // パネルを閉じて動画に戻る
      if (i !== plIndex) playlistPlay(i);   // 手動選択は、前回の続きから再生
    });
    list.appendChild(row);
  });
}

// 再生状態・動画サイズをネイティブへ通知（自動PiPの可否、PiPの再生/一時停止ボタン、画面常時点灯に使う）
function syncNative() {
  window.electronAPI?.setPlaybackState({
    playing: !!currentFile && !vid.paused && !vid.ended,
    autoPip: pipAuto,
    width: vid.videoWidth || 16,
    height: vid.videoHeight || 9,
  });
}

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let toastTimer = null;
function toast(msg, ms = 2800) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ─────────────────────────────────────────────
// CONTROLS AUTO-HIDE（全画面のときだけ）
// ─────────────────────────────────────────────
function showControls() {
  controlsVisible = true;
  document.body.classList.remove('hide-ctrl');
  clearTimeout(hideCtrlTimer);
  if (!isFs || vid.paused || inPip) return;
  hideCtrlTimer = setTimeout(() => {
    // メニュー表示中・シークバー操作中は隠さない
    if (seeking || document.querySelector('.pop-menu.open')) { showControls(); return; }
    controlsVisible = false;
    document.body.classList.add('hide-ctrl');
  }, 3000);
}

// ─────────────────────────────────────────────
// DOUBLE TAP SEEK（YouTube 風: 左半分=戻る / 右半分=進む）
// ─────────────────────────────────────────────
const DOUBLE_TAP_MS = 280;   // この間隔内の 2 回目のタップでスキップ開始
const SKIP_CHAIN_MS = 700;   // スキップ後、この間は 1 タップごとに連続スキップ
let tapTimer = null, lastTapAt = 0, lastTapSide = null;
let skipChainSide = null, skipChainTimer = null, skipAccum = 0;

function clampSec(v) {
  v = Math.round(+v);
  return isFinite(v) ? Math.max(1, Math.min(300, v)) : 10;
}

function doSkip(side) {
  const frame = skipUnit === 'frame';
  if (frame) {
    stepFrame(side === 'fwd' ? 1 : -1);
    skipAccum += skipFrames;
  } else {
    seek(side === 'fwd' ? doubleTapSec : -doubleTapSec);
    skipAccum += doubleTapSec;
  }
  const el = $(side === 'fwd' ? 'skip-fwd' : 'skip-back');
  const other = $(side === 'fwd' ? 'skip-back' : 'skip-fwd');
  other.classList.remove('show');
  $(side === 'fwd' ? 'skip-fwd-txt' : 'skip-back-txt').textContent = skipAccum + (frame ? 'フレーム' : '秒');
  el.classList.add('show');
  clearTimeout(skipChainTimer);
  skipChainTimer = setTimeout(endSkipChain, SKIP_CHAIN_MS);
}

function endSkipChain() {
  skipChainSide = null;
  skipAccum = 0;
  $('skip-back').classList.remove('show');
  $('skip-fwd').classList.remove('show');
}

function hideControlsNow() {
  clearTimeout(hideCtrlTimer);
  controlsVisible = false;
  document.body.classList.add('hide-ctrl');
}

function onSingleTap() {
  // iPhone 式: 再生中にコントロールが出ていればタップで隠す。隠れている/停止中ならタップで再生⇔停止
  if (tapHideMode && isFs) {
    if (!vid.paused && controlsVisible) {
      if (document.querySelector('.pop-menu.open')) { closePops(); return; }
      hideControlsNow();
      return;
    }
    togglePlay();
    flashPauseIcon();
    showControls();
    return;
  }
  // 全画面でコントロールが隠れているときの 1 タップは「コントロールを表示」だけ行う
  if (isFs && !controlsVisible) { showControls(); return; }
  togglePlay();
  flashPauseIcon();
  showControls();
}

function onVideoTap(e) {
  if (e.target === dropOverlay || !currentFile) return;
  if (window.VideoZoom && window.VideoZoom.justGestured()) return;   // ピンチ/ドラッグの直後はタップ扱いにしない
  const rect = videoboxEl.getBoundingClientRect();
  const side = (e.clientX - rect.left) < rect.width / 2 ? 'back' : 'fwd';
  const now = performance.now();

  // 連続スキップ中: 1 タップごとに加算（反対側をタップしたら向きを切り替え）
  if (skipChainSide) {
    if (side !== skipChainSide) { skipChainSide = side; skipAccum = 0; }
    doSkip(side);
    return;
  }
  // 2 回目のタップ → スキップ開始
  if (tapTimer && side === lastTapSide && now - lastTapAt < DOUBLE_TAP_MS) {
    clearTimeout(tapTimer); tapTimer = null;
    skipChainSide = side; skipAccum = 0;
    doSkip(side);
    return;
  }
  // 別の側を素早くタップした場合は、保留中の 1 タップを先に確定させる
  if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; onSingleTap(); }
  lastTapAt = now; lastTapSide = side;
  tapTimer = setTimeout(() => { tapTimer = null; onSingleTap(); }, DOUBLE_TAP_MS);
}

// ─────────────────────────────────────────────
// BACK BUTTON（Android の戻る）
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 画面ロック（誤タップ防止）: ロック中はタッチを全て無効にする。解除は解除ボタンの長押し
// ─────────────────────────────────────────────
let screenLocked = false;
let lockChipTimer = null, lockHoldTimer = null, lockHoldRaf = 0;
const UNLOCK_HOLD_MS = 1000;

function showLockChip() {
  const chip = $('lock-chip');
  chip.classList.add('show');
  clearTimeout(lockChipTimer);
  lockChipTimer = setTimeout(() => chip.classList.remove('show'), 3000);
}
function setScreenLock(on) {
  screenLocked = on;
  document.body.classList.toggle('locked', on);
  $('lock-btn').classList.toggle('active', on);
  $('lock-chip').classList.remove('show');
  clearTimeout(lockChipTimer);
  if (on) {
    closePops();
    if (activeDrawer) toggleDrawer(activeDrawer);
    toast('画面ロック中。タップで解除ボタンを表示（長押しで解除）', 2500);
  } else {
    toast('画面ロックを解除しました', 1500);
  }
  showControls();
}
function initScreenLock() {
  const overlay = $('lock-overlay'), unlock = $('lock-unlock'), ring = $('lock-ring');
  $('lock-btn').addEventListener('click', () => { if (currentFile) setScreenLock(true); });
  // 膜へのタッチは何も起こさず、解除ボタンだけ見せる
  overlay.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); showLockChip(); });
  ['click', 'touchstart', 'touchend', 'contextmenu'].forEach(t => overlay.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); }, { passive: false }));
  // 解除ボタンの長押し
  const cancelHold = () => { clearTimeout(lockHoldTimer); cancelAnimationFrame(lockHoldRaf); ring.style.setProperty('--p', '0%'); };
  unlock.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    showLockChip();
    const t0 = performance.now();
    const step = () => { ring.style.setProperty('--p', Math.min(100, (performance.now() - t0) / UNLOCK_HOLD_MS * 100) + '%'); lockHoldRaf = requestAnimationFrame(step); };
    lockHoldRaf = requestAnimationFrame(step);
    lockHoldTimer = setTimeout(() => { cancelHold(); setScreenLock(false); }, UNLOCK_HOLD_MS);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => unlock.addEventListener(t, cancelHold));
}

function handleBack() {
  if (screenLocked) { showLockChip(); return; }   // ロック中は戻るボタンも無効
  if (inPip) return;
  if (document.querySelector('.pop-menu.open')) { closePops(); return; }
  if (activeDrawer) { toggleDrawer(activeDrawer); return; }
  if (isFs) { setFullscreen(false); return; }
  window.Capacitor?.Plugins?.App?.exitApp?.();
}

// ─────────────────────────────────────────────
// ALWAYS ON TOP
// ─────────────────────────────────────────────
function toggleAOT() {
  aotPlayer = !aotPlayer;
  aotBtn.classList.toggle('active', aotPlayer);
  window.electronAPI?.setAlwaysOnTopPlayer(aotPlayer);
}

// ─────────────────────────────────────────────
// DROPDOWN MENUS
// ─────────────────────────────────────────────
function closePops() {
  document.querySelectorAll('.pop-menu.open').forEach(m => m.classList.remove('open'));
}

function togglePop(menuEl) {
  const wasOpen = menuEl.classList.contains('open');
  closePops();
  if (!wasOpen) menuEl.classList.add('open');
}

// ─────────────────────────────────────────────
// DRAWER (SETTINGS / SHORTCUTS)
// ─────────────────────────────────────────────
function toggleDrawer(which) {
  if (activeDrawer === which) {
    activeDrawer = null;
    drawerEl.classList.remove('open', 'eq-open', 'comp-open');
  } else {
    activeDrawer = which;
    drawerEl.classList.add('open');
    drawerEl.classList.toggle('eq-open', which === 'eq');
    drawerEl.classList.toggle('comp-open', which === 'comp');
    settingsPanelEl.style.display  = which === 'settings'  ? '' : 'none';
    shortcutsPanelEl.style.display = which === 'shortcuts' ? '' : 'none';
    playlistPanelEl.style.display  = which === 'playlist'  ? '' : 'none';
    eqPanelEl.style.display        = which === 'eq'        ? '' : 'none';
    if (compPanelEl) compPanelEl.style.display = which === 'comp' ? '' : 'none';
    if (which === 'playlist') renderPlaylist();
    if (which === 'settings') window.MARKS?.refreshStats();

  }
}

function initSettingsUI() {
  // Sync toggles with state
  const toggles = document.querySelectorAll('[data-toggle]');
  toggles.forEach(t => {
    const key = t.dataset.toggle;
    let on = true;
    if (key === 'aot')    on = aotPlayer;
    if (key === 'aot-tl') on = cfg?.timeline?.alwaysOnTop ?? true;
    if (key === 'sub')    on = subVisible;
    if (key === 'sub-bg') on = subBg;
    if (key === 'tl')     on = tlVisible;
    if (key === 'pip-auto') on = pipAuto;
    if (key === 'tap-hide') on = tapHideMode;
    if (key === 'unplug-pause') on = pauseOnUnplug;
    if (key === 'bg-play') on = backgroundPlay;
    if (key === 'continuous') on = continuousPlay;
    if (key === 'sc')     on = scEnabled;
    t.classList.toggle('on', on);
    t.addEventListener('click', () => handleToggle(key, t));
  });

  // Sub position select
  const posSel = $('sub-pos-sel');
  if (posSel) {
    posSel.value = subPos;
    posSel.addEventListener('change', () => {
      subPos = posSel.value;
      positionSubtitle();
    });
  }

  // Font size number input (任意ピクセル数入力)
  const fontSizeInput = $('sub-fontsize-input');
  if (fontSizeInput) {
    fontSizeInput.value = subFontSize;
    fontSizeInput.addEventListener('change', () => {
      const v = parseInt(fontSizeInput.value, 10);
      if (isFinite(v) && v >= 8 && v <= 120) {
        subFontSize = v;
        document.querySelectorAll('.size-btn[data-size]').forEach(b => b.classList.toggle('active', +b.dataset.size === subFontSize));
        positionSubtitle();
      } else {
        fontSizeInput.value = subFontSize; // 不正値はリセット
      }
    });
  }

  // Font size preset buttons
  document.querySelectorAll('.size-btn[data-size]').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.size === subFontSize);
    btn.addEventListener('click', () => {
      subFontSize = +btn.dataset.size;
      document.querySelectorAll('.size-btn[data-size]').forEach(b => b.classList.toggle('active', +b.dataset.size === subFontSize));
      const inp = $('sub-fontsize-input');
      if (inp) inp.value = subFontSize;
      positionSubtitle();
    });
  });

  // ダブルタップのスキップ秒数
  const dtInput = $('dt-sec-input');
  const syncDtUI = () => {
    if (dtInput) dtInput.value = doubleTapSec;
    document.querySelectorAll('.size-btn[data-dtsec]').forEach(b => b.classList.toggle('active', +b.dataset.dtsec === doubleTapSec));
  };
  const setDt = v => {
    doubleTapSec = clampSec(v);
    syncDtUI();
    window.electronAPI?.saveSettings({ gesture: { doubleTapSeconds: doubleTapSec } });
    window.electronAPI?.setMediaInfo?.({ skipSeconds: doubleTapSec });   // 通知の「戻る/進む」秒数にも反映
  };
  dtInput?.addEventListener('change', () => setDt(dtInput.value));
  document.querySelectorAll('.size-btn[data-dtsec]').forEach(b => b.addEventListener('click', () => setDt(b.dataset.dtsec)));
  syncDtUI();

  // スキップの単位（秒数 / 1フレーム）
  document.querySelectorAll('.size-btn[data-skipunit]').forEach(b => b.addEventListener('click', () => {
    skipUnit = b.dataset.skipunit === 'frame' ? 'frame' : 'sec';
    updateSkipUI();
    window.electronAPI?.saveSettings({ gesture: { skipUnit } });
  }));
  // 「フレーム」単位のときに 1 回で動かすフレーム数
  const sfInput = $('skip-frames-input');
  const setSf = v => {
    skipFrames = clampFrames(v);
    updateSkipUI();
    window.electronAPI?.saveSettings({ gesture: { skipFrames } });
  };
  sfInput?.addEventListener('change', () => setSf(sfInput.value));
  document.querySelectorAll('.size-btn[data-skipframes]').forEach(b => b.addEventListener('click', () => setSf(b.dataset.skipframes)));
  updateSkipUI();

  // 画面の向き
  const orientSel = $('orient-sel');
  if (orientSel) {
    orientSel.value = orientMode;
    orientSel.addEventListener('change', () => applyOrientation(orientSel.value));
  }

  // Speed buttons in settings
  document.querySelectorAll('.size-btn[data-speed]').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.speed === currentSpeed);
    btn.addEventListener('click', () => {
      applySpeed(+btn.dataset.speed);
      document.querySelectorAll('.size-btn[data-speed]').forEach(b => b.classList.toggle('active', +b.dataset.speed === currentSpeed));
    });
  });
}

function handleToggle(key, el) {
  const on = !el.classList.contains('on');
  el.classList.toggle('on', on);
  if (key === 'aot')    { aotPlayer = on; aotBtn.classList.toggle('active', on); window.electronAPI?.setAlwaysOnTopPlayer(on); }
  if (key === 'aot-tl') { window.electronAPI?.setAlwaysOnTopTimeline(on); }
  if (key === 'sub-bg') { subBg = on; applySubBackground(); window.electronAPI?.saveSettings({ subtitle: { visible: subVisible, position: subPos, fontSize: subFontSize, track: subTrackIdx, bg: subBg } }); }
  if (key === 'sub')    { subVisible = on; setTimeout(syncNativeSpu, 0); badgeSub.style.display = on ? 'none' : ''; if (!on) { subOverlay.style.display='none'; simpleSub.style.display='none'; } }
  if (key === 'tl')     { tlVisible = on; applyTimelineVisibility(); }
  if (key === 'tap-hide') { tapHideMode = on; window.electronAPI?.saveSettings({ gesture: { tapHide: on } }); }
  if (key === 'unplug-pause') { pauseOnUnplug = on; window.electronAPI?.setMediaInfo?.({ pauseOnUnplug: on }); window.electronAPI?.saveSettings({ audio: { pauseOnUnplug: on } }); }
  if (key === 'bg-play') { backgroundPlay = on; window.electronAPI?.setMediaInfo?.({ backgroundPlay: on }); window.electronAPI?.saveSettings({ audio: { backgroundPlay: on } }); }
  if (key === 'continuous') setContinuous(on);
  if (key === 'pip-auto') { pipAuto = on; syncNative(); window.electronAPI?.saveSettings({ pip: { auto: on } }); }
  if (key === 'sc')     { scEnabled = on; updateScOffBadge(); window.electronAPI?.saveSettings({ shortcuts: { enabled: on, bindings: scBindings } }); }
}

function updateScOffBadge() {
  scOffBadge.style.display = scEnabled ? 'none' : '';
  sc2Toggle?.classList.toggle('on', scEnabled);
}

// ─────────────────────────────────────────────
// SHORTCUTS LIST & REBINDING
// ─────────────────────────────────────────────
function renderShortcutsList() {
  scListEl.innerHTML = '';
  scBindings.forEach(b => {
    const row = document.createElement('div');
    row.className = 'sc-row';
    row.dataset.id = b.id;
    const badge = document.createElement('button');
    badge.className = 'key-badge';
    badge.textContent = b.key;
    badge.addEventListener('click', () => startRebind(b.id, badge));

    const tog = document.createElement('button');
    tog.className = 'toggle' + (b.enabled ? ' on' : '');
    tog.style.cssText = 'width:28px;height:16px;border-radius:8px;flex-shrink:0';
    tog.innerHTML = '<div class="toggle-knob" style="width:10px;height:10px;top:3px;left:3px"></div>';
    tog.addEventListener('click', () => {
      b.enabled = !b.enabled;
      tog.classList.toggle('on', b.enabled);
      window.electronAPI?.saveSettings({ shortcuts: { enabled: scEnabled, bindings: scBindings } });
    });

    const label = document.createElement('span');
    label.className = 'sc-label';
    label.textContent = b.label;

    row.append(label, badge, tog);
    scListEl.appendChild(row);
  });
}

function startRebind(id, badgeEl) {
  if (rebindTarget) cancelRebindFn();
  rebindTarget = { id, badgeEl };
  badgeEl.classList.add('binding');
  rebindNotice.classList.add('show');
}

function cancelRebindFn() {
  if (rebindTarget) rebindTarget.badgeEl.classList.remove('binding');
  rebindTarget = null;
  rebindNotice.classList.remove('show');
}

function handleRebindKey(e) {
  if (!rebindTarget) return false;
  e.preventDefault();
  const modKeys = ['Control', 'Shift', 'Alt', 'Meta'];
  if (modKeys.includes(e.key)) return true; // wait for main key
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey)   parts.push('Alt');
  const arrowMap = { ArrowLeft:'←', ArrowRight:'→', ArrowUp:'↑', ArrowDown:'↓' };
  const mainKey = arrowMap[e.key] || (e.key === ' ' ? 'Space' : e.key.toUpperCase());
  parts.push(mainKey);
  const newKey = parts.join('+');
  const binding = scBindings.find(b => b.id === rebindTarget.id);
  if (binding) {
    binding.key = newKey;
    rebindTarget.badgeEl.textContent = newKey;
  }
  cancelRebindFn();
  window.electronAPI?.saveSettings({ shortcuts: { enabled: scEnabled, bindings: scBindings } });
  return true;
}

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────
function keyMatches(e, bindingKey) {
  const parts = bindingKey.split('+');
  const mainKey = parts[parts.length - 1];
  const needCtrl  = parts.includes('Ctrl');
  const needShift = parts.includes('Shift');
  const needAlt   = parts.includes('Alt');
  if (e.ctrlKey  !== needCtrl)  return false;
  if (e.shiftKey !== needShift) return false;
  if (e.altKey   !== needAlt)   return false;
  const arrowMap = { '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', 'Space': ' ' };
  const target = arrowMap[mainKey] || mainKey;
  return e.key === target || e.key.toLowerCase() === target.toLowerCase();
}

const SC_ACTIONS = {
  playPause:  () => togglePlay(),
  seekBack5:  () => seek(-5),
  seekFwd5:   () => seek(5),
  seekBack30: () => seek(-30),
  seekFwd30:  () => seek(30),
  volUp:      () => adjustVolume(5),
  volDown:    () => adjustVolume(-5),
  mute:       () => toggleMute(),
  fullscreen: () => toggleFullscreen(),
  speedDown:  () => changeSpeed(-1),
  speedUp:    () => changeSpeed(1),
  timeline:   () => { tlVisible = !tlVisible; applyTimelineVisibility(); },
  subtitle:   () => {
    subVisible = !subVisible;
    badgeSub.style.display = subVisible ? 'none' : '';
    if (!subVisible) { subOverlay.style.display='none'; simpleSub.style.display='none'; }
    window.electronAPI?.saveSettings({ subtitle: { visible: subVisible, position: subPos, fontSize: subFontSize, track: subTrackIdx } });
  },
  simpleMode: () => toggleSimpleMode(),
  aotPlayer:  () => toggleAOT(),
  aotTL:      () => {
    const flag = !(cfg?.timeline?.alwaysOnTop ?? true);
    if (cfg) cfg.timeline = { ...cfg.timeline, alwaysOnTop: flag };
    window.electronAPI?.setAlwaysOnTopTimeline(flag);
  },
  detachTL:   () => { tlDetached = !tlDetached; applyTimelineVisibility(); },
  abRepeat:   () => abClick(),
  plNext:     () => playlistNext(false),
  plPrev:     () => playlistPrev(),
  globalSC:   () => {
    scEnabled = !scEnabled;
    updateScOffBadge();
    window.electronAPI?.saveSettings({ shortcuts: { enabled: scEnabled, bindings: scBindings } });
  },
};

// ─────────────────────────────────────────────
// FILE LOADING
// ─────────────────────────────────────────────
let loadSeq = 0;   // loadFile の世代番号（字幕の読み込みが終わる前に別の動画が開かれたとき、古い結果を捨てる）
async function loadFile(filePath, opts = {}) {
  const myLoad = ++loadSeq;
  currentFile = filePath;
  // プレイリスト上の位置を更新。リストに無いファイル（「このアプリで開く」等）は、その 1 本だけのリストにする
  const pi = playlist.indexOf(filePath);
  if (pi >= 0) plIndex = pi; else { playlist = [filePath]; plIndex = 0; }
  abA = abB = null;                 // A-B は動画ごとにリセット（ネイティブ側は読み込み時に解除される）
  updateAbUI();
  window.MARKS?.onFileLoaded(filePath);   // この動画のマーカー・ループを読み込む（前回の A-B は長さが分かってから復元）
  updatePlaylistInfo();
  const fileName = basename(filePath);
  const fileUrl = pathToUrl(filePath);

  window.VideoZoom?.reset();   // 動画を切り替えたら拡大を戻す

  showReplay(false);
  // Set video source
  vid.src = fileUrl;
  vid.load();
  window.electronAPI?.setMediaInfo?.({ title: fileName.replace(/\.[^.]+$/, ''), skipSeconds: doubleTapSec, pauseOnUnplug, backgroundPlay });   // 通知・ロック画面の表示用

  // Restore saved position
  if (window.electronAPI) {
    const saved = await window.electronAPI.loadPosition(filePath);
    if (!opts.fromStart && saved?.time > 5) {   // 自動/曲送りで進んだときは頭から
      vid.addEventListener('loadedmetadata', () => { vid.currentTime = saved.time; }, { once: true });
    }
  }

  // UI updates
  titleName.textContent = fileName;
  document.title = fileName + ' — きゅうり動画';
  emptyState.style.display = 'none';
  vid.classList.add('show');
  $('videobox').classList.add('loaded');
  ['b5','f5','b30','f30','play-btn','pip-btn','lock-btn','refresh-btn'].forEach(id => $(id).disabled = false);

  // Apply settings
  applyVolume();
  applySpeed();
  vid.play().catch(() => {});
  syncNative();
  showControls();

  // Reset subtitle state
  subtitles = [];
  subtitleTracks = [];
  audioTracks = [];
  mkvAudioTracks = [];
  subTrackIdx = 0;
  activeSubIdx = -1;

  // Attempt subtitle extraction via main process
  if (window.electronAPI?.extractSubtitles) {
    // 読み込み中であることを表示（空のまま放置すると「字幕が無い」ように見えるため）
    tlList.innerHTML = '<div id="tl-empty">字幕を読み込み中…</div>';
    tlCount.textContent = '';
    tlTrack.textContent = '';
    try {
      const result = await window.electronAPI.extractSubtitles(filePath);
      if (myLoad !== loadSeq) return;   // 読み込み中に別の動画が開かれた
      if (result?.tracks?.length) {
        subtitleTracks = result.tracks;
        // 設定で保存されたトラックインデックスを使用（範囲チェック付き）
        const trackIdx = Math.min(subTrackIdx, subtitleTracks.length - 1);
        subTrackIdx = trackIdx >= 0 ? trackIdx : 0;
        // 選ばれたトラックが画像字幕などでテキストが無く、別にテキスト字幕があるなら、そちらをタイムラインに出す
        if (!subtitleTracks[subTrackIdx]?.subs?.length) {
          const k = subtitleTracks.findIndex(t => t.subs && t.subs.length);
          if (k >= 0) subTrackIdx = k;
        }
        subtitles = subtitleTracks[subTrackIdx]?.subs || [];
      }
      if (result?.audioTracks?.length) {
        audioTracks = result.audioTracks;
        mkvAudioTracks = result.audioTracks;
      }
    } catch (e) {
      console.warn('[player] extractSubtitles failed:', e.message);
    }
  }

  rebuildCCMenu();
  rebuildAudioMenu();
  applyNativeTracks();
  renderTimeline();

  // タイムラインウィンドウへ通知（duration は loadedmetadata 後に再送信）
  window.electronAPI?.notifyFileLoaded({
    filePath, fileName, subtitles,
    subtitleTracks, audioTracks,
    duration: vid.duration || 0,
  });

  // Start position auto-save
  clearInterval(posTimer);
  posTimer = setInterval(() => {
    if (currentFile && isFinite(vid.currentTime) && vid.currentTime > 0) {
      window.electronAPI?.savePosition({ filePath: currentFile, time: vid.currentTime });
    }
  }, 5000);
}

// ─────────────────────────────────────────────
// SYNC (player → timeline)
// ─────────────────────────────────────────────
function startSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!currentFile) return;
    window.electronAPI?.syncPlayback({
      time: vid.currentTime,
      duration: vid.duration,
      playing: !vid.paused,
      activeSubIdx,
      speed: currentSpeed,
    });
  }, 250);
}

// ─────────────────────────────────────────────
// SETTINGS INIT FROM MAIN
// ─────────────────────────────────────────────
function applyInitSettings(s) {
  cfg = s;

  subPos      = s.subtitle?.position    || 'bottom-center';
  subFontSize = s.subtitle?.fontSize    || 15;
  subVisible  = s.subtitle?.visible     !== false;
  subBg       = s.subtitle?.bg          || false;
  subTrackIdx = s.subtitle?.track       ?? 0;
  currentVol  = 100;                      // Android: 音量は端末の音量キーで操作（アプリ内は常に 100%）
  doubleTapSec= clampSec(s.gesture?.doubleTapSeconds ?? 10);
  tapHideMode = s.gesture?.tapHide === true;   // 既定 OFF
  skipUnit    = s.gesture?.skipUnit === 'frame' ? 'frame' : 'sec';
  skipFrames  = clampFrames(s.gesture?.skipFrames ?? 1);
  pipAuto     = s.pip?.auto             !== false;
  pauseOnUnplug = s.audio?.pauseOnUnplug !== false;
  backgroundPlay = s.audio?.backgroundPlay !== false;
  window.electronAPI?.setMediaInfo?.({ pauseOnUnplug, backgroundPlay });
  isMuted     = s.playback?.muted       || false;
  continuousPlay = s.playback?.continuous === true;   // 連続再生は既定 OFF
  repeatMode  = REPEAT_MODES.includes(s.playback?.repeat) ? s.playback.repeat : 'off';   // くり返し再生も既定 OFF
  currentSpeed= s.playback?.speed       || 1;
  aotPlayer   = s.player?.alwaysOnTop   !== false;
  tlVisible   = s.timeline?.visible     !== false;
  tlDetached  = s.timeline?.detached    || false;
  scEnabled   = s.shortcuts?.enabled    !== false;

  if (s.shortcuts?.bindings?.length) {
    scBindings = JSON.parse(JSON.stringify(s.shortcuts.bindings));
    // 後から追加したショートカットが、保存済みの設定に無ければ補う
    const have = new Set(scBindings.map(b => b.id));
    DEFAULT_SHORTCUTS.forEach(d => { if (!have.has(d.id)) scBindings.push(JSON.parse(JSON.stringify(d))); });
  }

  aotBtn.classList.toggle('active', aotPlayer);
  positionSubtitle();
  badgeSub.style.display = subVisible ? 'none' : '';

  window.COMP?.init(s.comp, s.boost);   // コンプレッサー / 音量ブースト（保存済みの設定を反映）
  initSettingsUI();
  document.querySelectorAll('.repeat-sel').forEach(sel => {
    sel.value = repeatMode;
    sel.addEventListener('change', () => setRepeat(sel.value));
  });
  updatePlaylistInfo();
  renderShortcutsList();
  applyTimelineVisibility();
  updateScOffBadge();
  window.MARKS?.init(s.marks, s.timeline?.tab);   // マーカー・ループの保存期間（期限切れの記録をここで自動削除）
  window.EQ?.init(s.eq);   // イコライザー（保存済みの設定を端末側へ反映）

  // Restore simple mode
  if (s.player?.simpleMode) { isSimple = false; toggleSimpleMode(); }
}

// ─────────────────────────────────────────────
// EVENT WIRING
// ─────────────────────────────────────────────
function initEvents() {
  window.MARKS?.bind({
    getFile: () => currentFile,
    getTime: () => vid.currentTime,
    getDuration: () => vid.duration,
    seek: (t, play) => { seekTo(t); if (play && vid.paused) vid.play().catch(() => {}); },
    getAb: () => ({ a: abA, b: abB }),
    setAb: (a, b) => { abA = a; abB = b; applyAb(); },
    toast: (m, ms) => toast(m, ms),
    fmtTime,
  });
  // Window controls
  $('dot-close').addEventListener('click', () => window.electronAPI?.closeWindow());
  $('dot-min').addEventListener('click',   () => window.electronAPI?.minimize());
  $('dot-max').addEventListener('click',   () => window.electronAPI?.maximize());

  // Titlebar buttons
  aotBtn.addEventListener('click', toggleAOT);
  settingsBtn.addEventListener('click',  () => toggleDrawer('settings'));
  scBtnEl.addEventListener('click',      () => toggleDrawer('shortcuts'));

  // Open file
  $('open-btn').addEventListener('click', async () => {
    if (window.electronAPI?.openFiles) {
      const keys = await window.electronAPI.openFiles();
      if (keys && keys.length) openKeys(keys);
    } else {
      const fp = await window.electronAPI?.openFile();
      if (fp) loadFile(fp);
    }
  });
  $('ab-btn')?.addEventListener('click', abClear);
  $('ab-clear-tab')?.addEventListener('click', abClear);
  $('pl-btn').addEventListener('click', () => toggleDrawer('playlist'));
  $('eq-btn')?.addEventListener('click', () => { closePops(); toggleDrawer('eq'); });
  $('eq-close')?.addEventListener('click', () => { if (activeDrawer === 'eq') toggleDrawer('eq'); });
  $('comp-btn')?.addEventListener('click', () => { closePops(); toggleDrawer('comp'); });
  $('comp-close')?.addEventListener('click', () => { if (activeDrawer === 'comp') toggleDrawer('comp'); });
  $('pl-add').addEventListener('click', addToPlaylist);
  $('pl-clear').addEventListener('click', clearPlaylist);

  // Drag & Drop
  const videobox = $('videobox');
  videobox.addEventListener('dragover', e => { e.preventDefault(); dropOverlay.style.display = ''; });
  videobox.addEventListener('dragleave', () => { dropOverlay.style.display = 'none'; });
  videobox.addEventListener('drop', e => {
    e.preventDefault();
    dropOverlay.style.display = 'none';
    const file = e.dataTransfer.files[0];
    if (file && (window.isVideoFile ? window.isVideoFile(file) : true)) {
      // In Electron, use webUtils.getPathForFile if available, otherwise fall back
      const fp = file.path || window.__androidFiles?.register(file);
      if (fp) loadFile(fp);
    }
  });

  // 動画エリアのタップ: 1 回=再生/停止、2 回(左右)=スキップ
  videoboxEl.addEventListener('click', onVideoTap);
  controlsEl.addEventListener('pointerdown', () => showControls());

  // Video events
  vid.addEventListener('play',  () => { setPlayIcon(true);  startSync(); syncNative(); showControls(); });
  vid.addEventListener('playing', () => showReplay(false));
  if (replayOverlay) replayOverlay.addEventListener('click', e => { e.stopPropagation(); replayFromStart(); });
  vid.addEventListener('pause', () => { setPlayIcon(false); syncNative(); showControls(); });
  vid.addEventListener('ended', () => {
    setPlayIcon(false); syncNative(); showControls();
    const n = playlist.length;
    const hasNext = plIndex >= 0 && plIndex + 1 < n;
    // くり返し再生: 1 本リピート、または 1 本だけのプレイリストの全体リピートは、同じ動画を頭から再生し直す
    const repeatSame = repeatMode === 'one' || (repeatMode === 'all' && n <= 1);
    // 連続再生 / リピートで続きを再生するときはリプレイ表示を出さない
    const willAdvance = (continuousPlay && hasNext) || repeatSame || (repeatMode === 'all' && n > 1);
    if (!willAdvance) showReplay(true);
    if (currentFile) window.electronAPI?.savePosition({ filePath: currentFile, time: 0 });   // 最後まで見たら次回は頭から
    if (repeatSame) {
      const now = Date.now();
      if (now - lastRepeatAt > 800 && currentFile) { lastRepeatAt = now; replayFromStart(); }   // 同じ終了の二重処理を防ぐ
      return;
    }
    // 全体リピート: 次があれば次へ、最後なら先頭へ戻る（同じ動画の終了で二重に進まないようにする）
    if (repeatMode === 'all' && lastAdvanceSeq !== loadSeq) {
      lastAdvanceSeq = loadSeq;
      playlistNext(true);
      return;
    }
    // 連続再生: プレイリストに次があれば自動で進む（同じ動画の終了で二重に進まないようにする）
    if (continuousPlay && plIndex >= 0 && plIndex + 1 < playlist.length && lastAdvanceSeq !== loadSeq) {
      lastAdvanceSeq = loadSeq;
      playlistNext(true);
    }
  });
  // 再生できない形式（端末が非対応のコーデック等）のとき理由を表示
  vid.addEventListener('error', () => {
    if (!currentFile || !vid.getAttribute('src')) return;
    const c = vid.error && vid.error.code;
    toast(vid.isNative ? 'この動画を再生できませんでした（ファイルが壊れているか、未対応の形式の可能性があります）'
      : c === 4 ? 'この動画形式（コーデック）は端末で再生できません' : c === 3 ? '動画のデコードに失敗しました（非対応のコーデックの可能性）' : '動画を読み込めませんでした', 5000);
  });
  vid.addEventListener('tracks', applyNativeTracks);   // libVLC がトラック情報を通知したとき
  vid.addEventListener('resize', syncNative);          // 動画サイズ確定（小窓の縦横比）
  vid.addEventListener('timeupdate', () => {
    // A-B リピート（libVLC 版は端末側でループ。通常の <video> のときだけここで戻す）
    if (!vid.isNative && abA != null && abB != null) {
      const t = vid.currentTime;
      if (t >= abB && t < abB + 1.5) vid.currentTime = abA;
    }
    updateSeekbar();
    updateSubtitleDisplay(vid.currentTime);
  });
  vid.addEventListener('loadedmetadata', () => {
    applySpeed();
    applyVolume();
    updateSeekbar();
    updateAbMarkers();
    window.MARKS?.onMetadata();
    syncNative(); // 動画サイズ（PiP の縦横比）が確定
    // duration が確定したタイミングで再送信（字幕データも最新状態で送る）
    window.electronAPI?.notifyFileLoaded({
      filePath: currentFile,
      fileName: basename(currentFile),
      subtitles,
      subtitleTracks,
      audioTracks,
      duration: vid.duration,
    });
  });

  // Play button
  playBtnEl.addEventListener('click', togglePlay);

  // Seek buttons
  $('b5').addEventListener('click',  () => fineSkip(-1));
  $('f5').addEventListener('click',  () => fineSkip(1));
  $('b30').addEventListener('click', () => seek(-30));
  $('f30').addEventListener('click', () => seek(30));

  // Seekbar（Pointer Events: 指のドラッグ / マウスの両方に対応）
  const seekWrap = $('seekbar-wrap');
  const seekTrack = $('seekbar-track');
  let seekThrottle = 0;
  const seekPct = e => seekbarAt(e, seekTrack);
  const showSeekUI = pct => {
    const dur = vid.duration || 0;
    seekFill.style.width = pct * 100 + '%';
    seekThumb.style.left = pct * 100 + '%';
    timeDisplay.textContent = fmtTime(pct * dur) + ' / ' + fmtTime(dur);
  };
  const showTip = (e, pct) => {
    const x = e.clientX - seekWrap.getBoundingClientRect().left;
    seekTip.textContent = fmtTime(pct * (vid.duration || 0));
    seekTip.style.left = Math.max(5, Math.min(seekWrap.offsetWidth - 40, x - 18)) + 'px';
    seekTip.style.display = '';
  };
  const applySeek = pct => {
    if (!currentFile || !isFinite(vid.duration)) return;
    if (vid.ended) { showReplay(false); vid.currentTime = pct * vid.duration; vid.play(); return; }   // 終了後のシークは再生再開
    vid.currentTime = pct * vid.duration;
  };
  seekWrap.addEventListener('pointerdown', e => {
    if (!currentFile) return;
    seeking = true;
    try { seekWrap.setPointerCapture(e.pointerId); } catch (_) {}
    const pct = seekPct(e);
    showSeekUI(pct); showTip(e, pct); applySeek(pct);
    showControls();
  });
  seekWrap.addEventListener('pointermove', e => {
    const pct = seekPct(e);
    if (e.pointerType === 'mouse' || seeking) showTip(e, pct);
    if (!seeking) return;
    showSeekUI(pct);
    const now = performance.now();
    if (now - seekThrottle > 120) { seekThrottle = now; applySeek(pct); } // 連続シークは間引く
  });
  seekWrap.addEventListener('pointerup', e => {
    if (!seeking) return;
    seeking = false;
    applySeek(seekPct(e));
    seekTip.style.display = 'none';
    showControls();
  });
  seekWrap.addEventListener('pointercancel', () => { seeking = false; seekTip.style.display = 'none'; });
  seekWrap.addEventListener('pointerleave', () => { if (!seeking) seekTip.style.display = 'none'; });

  // Mute（音量バーは Android では廃止。音量は端末の音量キー）
  volBtn.addEventListener('click', toggleMute);

  // Speed menu
  speedBtn.addEventListener('click', () => togglePop(speedMenu));
  speedMenu.querySelectorAll('.pop-item').forEach(el => {
    el.addEventListener('click', () => {
      applySpeed(+el.dataset.val);
      document.querySelectorAll('.size-btn[data-speed]').forEach(b => b.classList.toggle('active', +b.dataset.speed === currentSpeed));
      closePops();
    });
  });

  // CC menu
  ccBtn.addEventListener('click', () => togglePop(ccMenu));

  // Audio menu
  audioBtn.addEventListener('click', () => togglePop(audioMenu));

  // Close pop when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.pop-wrap')) closePops();
  });

  // Timeline toggle
  $('tl-btn').addEventListener('click', () => {
    tlVisible = !tlVisible;
    applyTimelineVisibility();
  });

  // Detach timeline
  $('detach-tl-btn').addEventListener('click', () => {
    tlDetached = !tlDetached;
    applyTimelineVisibility();
  });

  // Close timeline panel
  $('close-tl').addEventListener('click', () => {
    tlVisible = false;
    applyTimelineVisibility();
  });

  // Simple mode
  $('simple-btn').addEventListener('click', toggleSimpleMode);
  exitSimple.addEventListener('click', () => { isSimple = true; toggleSimpleMode(); });
  $('simple-wrap').addEventListener('mouseenter', () => simpleCtrl.classList.add('show'));
  $('simple-wrap').addEventListener('mouseleave', () => simpleCtrl.classList.remove('show'));
  simplePlayEl.addEventListener('click', () => {
    simpleVid.paused ? simpleVid.play() : simpleVid.pause();
  });
  simpleVid.addEventListener('play',  () => setPlayIcon(true));
  simpleVid.addEventListener('pause', () => setPlayIcon(false));
  simpleVid.addEventListener('timeupdate', () => {
    const pct = simpleVid.duration ? (simpleVid.currentTime / simpleVid.duration) * 100 : 0;
    simpleFill.style.width = pct + '%';
    simpleTime.textContent = fmtTime(simpleVid.currentTime);
    updateSubtitleDisplay(simpleVid.currentTime);
  });

  // Simple seekbar
  let simpleSeekDrag = false;
  simpleSeek.addEventListener('mousedown', e => { simpleSeekDrag = true; doSimpleSeek(e); });
  simpleSeek.addEventListener('mousemove', e => { if (simpleSeekDrag) doSimpleSeek(e); });
  document.addEventListener('mouseup', () => { simpleSeekDrag = false; });
  function doSimpleSeek(e) {
    const rect = simpleSeek.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    simpleVid.currentTime = pct * (simpleVid.duration || 0);
  }

  // Opacity slider
  opSlider.addEventListener('input', () => {
    simpleWrap.style.opacity = opSlider.value / 100;
  });

  // Fullscreen / 画面の向き / 小窓
  initScreenLock();
  $('fs-btn').addEventListener('click', toggleFullscreen);
  rotateBtn.addEventListener('click', toggleOrientation);
  pipBtn.addEventListener('click', enterPip);
  // 映像が黒いまま戻らないときの手動復帰（ネイティブ再生のときだけ）
  const refreshBtn = $('refresh-btn');
  if (!useVlc) refreshBtn.style.display = 'none';
  refreshBtn.addEventListener('click', () => {
    if (!currentFile || !vid.refreshVideo) return;
    toast('映像を再読み込みしています…', 1500);
    vid.refreshVideo();
    showControls();
  });

  // Settings / Shortcuts drawer
  sc2Toggle?.addEventListener('click', () => {
    scEnabled = !scEnabled;
    sc2Toggle.classList.toggle('on', scEnabled);
    updateScOffBadge();
    window.electronAPI?.saveSettings({ shortcuts: { enabled: scEnabled, bindings: scBindings } });
  });
  cancelRebind?.addEventListener('click', cancelRebindFn);

  // Keyboard
  document.addEventListener('keydown', e => {
    // Rebind capture
    if (screenLocked) return;
    if (rebindTarget) { handleRebindKey(e); return; }
    // Ignore if focus is in input
    if (e.target.matches('input, select, textarea')) return;
    if (!scEnabled) return;

    for (const b of scBindings) {
      if (!b.enabled) continue;
      if (keyMatches(e, b.key)) {
        e.preventDefault();
        SC_ACTIONS[b.id]?.();
        break;
      }
    }
  });

  // IPC events from main
  window.electronAPI?.on('init-settings', s => applyInitSettings(s));
  window.electronAPI?.on('file-opened',   fp => loadFile(fp));
  window.electronAPI?.on('seek-to',       t  => seekTo(t));
  window.electronAPI?.on('toggle-simple-mode', () => toggleSimpleMode());
  window.electronAPI?.on('aot-changed', ({ window: w, value }) => {
    if (w === 'player') { aotPlayer = value; aotBtn.classList.toggle('active', value); }
  });
  window.electronAPI?.on('timeline-visibility-changed', v => {
    tlVisible = v;
    $('tl-btn').classList.toggle('active', v);
  });
  window.electronAPI?.on('subtitle-track-changed', idx => selectSubtitleTrack(idx));

  // ── Android ネイティブからのイベント ──
  window.electronAPI?.on('pip-changed', onPipChanged);       // 小窓の開始/終了/閉じられた
  window.electronAPI?.on('pip-toggle', () => togglePlay());  // 小窓の再生/一時停止ボタン
  window.electronAPI?.on('media-next', () => playlistNext(false));   // 通知・ロック画面・イヤホンの「次へ」
  window.electronAPI?.on('media-prev', () => playlistPrev());        // 同「前へ」
  window.electronAPI?.getNativeInfo?.().then(info => {
    pipSupported = !!info?.pip;
    document.body.classList.toggle('no-pip', !pipSupported);
  });
  window.Capacitor?.Plugins?.App?.addListener?.('backButton', handleBack);

  // バックグラウンドへ移るとき/終了前に再生位置を保存
  const savePosNow = () => {
    if (currentFile && isFinite(vid.currentTime) && vid.currentTime > 0) {
      window.electronAPI?.savePosition({ filePath: currentFile, time: vid.currentTime });
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosNow(); });
  window.addEventListener('pagehide', savePosNow);

  // タイムラインが独立ウィンドウからプレイヤー内パネルに格納されたとき
  window.electronAPI?.on('timeline-attach', () => {
    tlDetached = false;
    tlVisible  = true;
    applyTimelineVisibility();
    $('detach-tl-btn')?.classList.remove('active');
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function flashPauseIcon() {
  pauseIcon.style.display = 'flex';
  setTimeout(() => { pauseIcon.style.display = 'none'; }, 350);
}

function seekbarAt(e, el) {
  const rect = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  startSync();

  // If electronAPI not available (dev browser mode), apply defaults
  if (!window.electronAPI) {
    console.warn('[player] electronAPI not available — running in standalone mode');
    applyInitSettings({
      subtitle: { visible: true, position: 'bottom-center', fontSize: 15, track: 0 },
      playback: { volume: 80, muted: false, speed: 1 },
      player: { alwaysOnTop: true }, timeline: { visible: true, detached: false, alwaysOnTop: true },
      shortcuts: { enabled: true, bindings: DEFAULT_SHORTCUTS },
    });
  }
});
