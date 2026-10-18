#!/usr/bin/env node
/**
 * `npx cap add android` で生成された android/ に、Android 固有のネイティブ機能を組み込む。
 *   - native/android/*.java を android/app/src/main/java/<appId>/ へコピー
 *       NativePlayerPlugin … 全画面(イミーシブ) / 画面の向き / 小窓再生(PiP) / 画面常時点灯
 *       MainActivity       … PiP 用フック
 *       PlaybackService    … 再生中の通知（前面サービス）
 *       MkvScanner         … MKV 字幕のネイティブ高速走査
 *   - AndroidManifest.xml に PiP 対応を追加
 *   - app/build.gradle に libVLC（動画再生エンジン）を追加
 *   - native/android/res/ のアプリアイコン（mipmap-*）を android/app/src/main/res/ へコピー
 * 何度実行しても同じ結果になる（冪等）。
 *
 * 使い方:  npx cap add android && node scripts/patch-android.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const { appId } = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));

if (!appId) { console.error('capacitor.config.json に appId がありません'); process.exit(1); }
if (!fs.existsSync(androidDir)) {
  console.error('android/ が見つかりません。先に `npx cap add android` を実行してください。');
  process.exit(1);
}

// ── 1) Java ファイルを配置 ──────────────────────────────
const javaDir = path.join(androidDir, 'app', 'src', 'main', 'java', ...appId.split('.'));
fs.mkdirSync(javaDir, { recursive: true });
for (const name of ['MainActivity.java', 'NativePlayerPlugin.java', 'PlaybackService.java', 'MkvScanner.java']) {
  const src = fs.readFileSync(path.join(root, 'native', 'android', name), 'utf8').replace(/__APP_ID__/g, appId);
  fs.writeFileSync(path.join(javaDir, name), src);
  console.log('✔ ' + path.relative(root, path.join(javaDir, name)));
}

// ── 2) AndroidManifest.xml を更新 ───────────────────────
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');

const m = xml.match(/<activity\b[^>]*>/);
if (!m) { console.error('AndroidManifest.xml に <activity> が見つかりません'); process.exit(1); }
let tag = m[0];

const setAttr = (name, value) => {
  const re = new RegExp('(\\s)' + name.replace(':', '\\:') + '="[^"]*"');
  tag = re.test(tag) ? tag.replace(re, `$1${name}="${value}"`) : tag.replace(/<activity\b/, `<activity\n            ${name}="${value}"`);
};
setAttr('android:supportsPictureInPicture', 'true');
setAttr('android:resizeableActivity', 'true');

// PiP / 画面回転でアクティビティが再生成されない（=動画が途切れない）ように configChanges を確認
const need = ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout'];
const cc = tag.match(/android:configChanges="([^"]*)"/);
if (cc) {
  const have = cc[1].split('|').filter(Boolean);
  for (const t of need) if (!have.includes(t)) have.push(t);
  tag = tag.replace(cc[0], `android:configChanges="${have.join('|')}"`);
} else {
  tag = tag.replace(/<activity\b/, `<activity\n            android:configChanges="${need.join('|')}"`);
}

xml = xml.replace(m[0], tag);

// 通知 / ロック画面 / イヤホンボタンからの操作に必要な権限とサービス
if (!xml.includes('kyuuri-media')) {
  const perms = ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'POST_NOTIFICATIONS', 'WAKE_LOCK', 'RECORD_AUDIO']   // RECORD_AUDIO: スペクトラムアナライザー(Visualizer)の仕様上必要。マイクでの録音はしない
    .filter(p => !xml.includes('android.permission.' + p))
    .map(p => `    <uses-permission android:name="android.permission.${p}" />\n`).join('');
  const appIdx = xml.indexOf('<application');
  if (appIdx < 0) { console.error('AndroidManifest.xml に <application> が見つかりません'); process.exit(1); }
  xml = xml.slice(0, appIdx) + '<!-- kyuuri-media -->\n' + perms + '    ' + xml.slice(appIdx);
  const appEnd = xml.indexOf('</application>');
  xml = xml.slice(0, appEnd)
    + '    <service android:name=".PlaybackService" android:exported="false" android:foregroundServiceType="mediaPlayback" />\n    '
    + xml.slice(appEnd);
}

// 「このアプリで開く」: ファイルマネージャー・LINE・ブラウザの保存先などから動画を直接開けるようにする
if (!xml.includes('kyuuri-open-with')) {
  const filters = `
            <!-- kyuuri-open-with -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="video/*" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="application/x-matroska" />
                <data android:mimeType="application/vnd.rn-realmedia" />
                <data android:mimeType="application/mxf" />
                <data android:mimeType="application/ogg" />
                <data android:mimeType="application/octet-stream" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="video/*" />
                <data android:mimeType="audio/*" />
            </intent-filter>
        `;
  const end = xml.indexOf('</activity>');
  if (end < 0) { console.error('AndroidManifest.xml に </activity> が見つかりません'); process.exit(1); }
  xml = xml.slice(0, end) + filters + xml.slice(end);
}
fs.writeFileSync(manifestPath, xml);
console.log('✔ ' + path.relative(root, manifestPath) + '（PiP 対応を追加）');

// ── 2.5) libVLC を Gradle 依存に追加（app/build.gradle） ─────────────────
const LIBVLC = 'org.videolan.android:libvlc-all:3.6.0';
const gradlePath = path.join(androidDir, 'app', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!gradle.includes('libvlc-all')) {
  if (!/dependencies\s*\{/.test(gradle)) { console.error('app/build.gradle に dependencies ブロックが見つかりません'); process.exit(1); }
  gradle = gradle.replace(/dependencies\s*\{/, `dependencies {\n    implementation '${LIBVLC}'`);
}
// APK サイズ削減: 実機の CPU（arm64 / armv7）だけを含める（x86 エミュレータでは動きません）
if (!gradle.includes('abiFilters')) {
  if (!/defaultConfig\s*\{/.test(gradle)) { console.error('app/build.gradle に defaultConfig ブロックが見つかりません'); process.exit(1); }
  gradle = gradle.replace(/defaultConfig\s*\{/, `defaultConfig {\n        ndk { abiFilters 'arm64-v8a', 'armeabi-v7a' }`);
}
// ネイティブコードで `var` を使うため Java 17 でコンパイルする（JDK 17 は Capacitor 6 の必須要件）
if (!gradle.includes('compileOptions')) {
  if (!/android\s*\{/.test(gradle)) { console.error('app/build.gradle に android ブロックが見つかりません'); process.exit(1); }
  gradle = gradle.replace(/android\s*\{/, `android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }`);
}
fs.writeFileSync(gradlePath, gradle);
console.log('✔ ' + path.relative(root, gradlePath) + '（libVLC を追加）');

// ── 3) アプリアイコンを差し替え ─────────────────────────
const resSrc = path.join(root, 'native', 'android', 'res');
const resDst = path.join(androidDir, 'app', 'src', 'main', 'res');
if (fs.existsSync(resSrc)) {
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      e.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
    }
  };
  copyDir(resSrc, resDst);
  // テンプレート標準の古い前景ベクターが残っていても mipmap 側が使われるが、混乱を避けて除去
  for (const f of ['drawable-v24/ic_launcher_foreground.xml']) {
    const fp = path.join(resDst, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  // mipmap-*/ic_launcher*.webp（テンプレート）が残ると png と重複してビルドエラーになるため除去
  for (const dir of fs.readdirSync(resDst).filter(d => d.startsWith('mipmap-'))) {
    for (const f of fs.readdirSync(path.join(resDst, dir))) {
      if (/^ic_launcher.*\.webp$/.test(f)) fs.unlinkSync(path.join(resDst, dir, f));
    }
  }
  console.log('✔ アプリアイコンを差し替え');
}
console.log('完了');
