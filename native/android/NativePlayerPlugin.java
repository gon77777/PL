package __APP_ID__;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.audiofx.Visualizer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.util.Rational;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;

/**
 * きゅうり動画 用ネイティブ機能（WebView だけでは実現できないもの）:
 *  - 全画面（ステータスバー/ナビゲーションバーを隠すイミーシブモード）
 *  - 画面の向きの固定（横 / 縦 / 自動）
 *  - 小窓再生（Picture in Picture）… ホームに戻ったとき自動で小窓にする / ボタンで小窓にする
 *  - 再生中は画面を消灯させない
 *  - libVLC による動画再生（ほぼ全ての形式・コーデックに対応）。映像は WebView の背面に描画し、操作画面(HTML)を重ねる
 *  - ファイル選択（SAF）と、字幕解析用のバイト読み出し
 *
 * このファイルは scripts/patch-android.js によって android/ 配下へコピーされる。
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    private String actionToggle;
    private BroadcastReceiver receiver;
    private BroadcastReceiver mediaReceiver;
    private BroadcastReceiver noisyReceiver;
    private volatile boolean pauseOnUnplug = true;
    private volatile boolean backgroundPlay = true;   // 画面を消す / アプリを離れても音声を再生し続ける
    private boolean activityStopped = false;          // 画面から見えない間は true

    // JS から通知される状態（プラグインのスレッドと UI スレッドの両方から触るため volatile）
    private volatile boolean playing = false;
    private volatile boolean autoPip = true;
    private volatile int videoW = 16;
    private volatile int videoH = 9;

    @Override
    public void load() {
        actionToggle = getContext().getPackageName() + ".PIP_TOGGLE";
        initActions();

        // 小窓上の「再生/一時停止」ボタンが押されたときに届くブロードキャスト
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent != null && actionToggle.equals(intent.getAction())) {
                    notifyListeners("pipToggle", new JSObject());
                }
            }
        };
        // 通知のボタン（10秒戻る / 再生・一時停止 / 10秒進む）
        mediaReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || intent.getAction() == null || vlc == null) return;
                String a = intent.getAction();
                if (a.equals(ACT_TOGGLE)) togglePlayNow();
                else if (a.equals(ACT_REW)) seekRelative(-skipMs);
                else if (a.equals(ACT_FF)) seekRelative(skipMs);
                else if (a.equals(ACT_PREV)) skipTrack(false);
                else if (a.equals(ACT_NEXT)) skipTrack(true);
            }
        };
        // イヤホンを抜いた / Bluetooth が切れたとき（スピーカーから突然音が出るのを防ぐ）
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent != null && android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())
                    && pauseOnUnplug && vlc != null && vlc.isPlaying()) {
                    vlc.pause();
                }
            }
        };
        IntentFilter nf = new IntentFilter(android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(noisyReceiver, nf, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(noisyReceiver, nf);
        }

        IntentFilter mf = new IntentFilter();
        mf.addAction(ACT_TOGGLE);
        mf.addAction(ACT_REW);
        mf.addAction(ACT_FF);
        mf.addAction(ACT_PREV);
        mf.addAction(ACT_NEXT);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(mediaReceiver, mf, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(mediaReceiver, mf);
        }

        IntentFilter filter = new IntentFilter(actionToggle);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    private int savedVideoTrack = -2;

    /** 映像トラックを無効にして、見えない映像のデコード負荷を無くす（音声は続く） */
    private void suspendVideo() {
        try {
            if (vlc == null) return;
            int cur = vlc.getVideoTrack();
            if (cur >= 0) {
                savedVideoTrack = cur;
                lastVideoTrack = cur;
                vlc.setVideoTrack(-1);
            }
        } catch (Throwable ignored) {
        }
    }

    private boolean viewsDetached = false;      // 画面から見えない間、映像用ビューを外している
    private boolean voutSinceRestore = false;   // 復帰後に映像出力(vout)が作られたか

    /** 映像用ビューを外す（画面から見えなくなったとき。VLC 公式アプリと同じ作法） */
    private void detachVideoViews() {
        try {
            if (vlc != null && !viewsDetached) {
                vlc.detachViews();
                viewsDetached = true;
            }
        } catch (Throwable ignored) {
        }
    }

    // ── 映像の復帰（画面消灯 / 小窓 / 手動の「映像を再読み込み」で共通） ──
    // 以前の失敗の原因: トラックを切って 0.4 秒で戻していたため、デコーダの後始末が終わる前に再有効化されて無視されていた。
    // 特に「小窓のまま消灯」は、デコーダが動いたまま描画面だけ失われるので後始末に時間がかかる。
    // 対策: 固定時間ではなく「映像出力(Vout)が閉じたこと」を確認してから戻す。それでも駄目なら段階的に強くする。
    //   レベル 0: トラックを切る → 出力が閉じるのを待つ → ビューを付け直す → トラックを戻す
    //   レベル 1: 上に加えて映像用ビュー(SurfaceView)ごと作り直す
    //   レベル 2: 映像用ビューを作り直し、メディアを開き直して同じ位置から再開する（最終手段）
    private static final boolean KEYFRAME_KICK = true;   // トラックを戻した直後に再シークしてキーフレーム待ちをなくす
    private long resumeStartMs = 0;           // 復帰計測の開始時刻（0=計測なし）
    private int voutCount = 0;                // 現在の映像出力の数（Vout イベントで更新）
    private boolean needsRefresh = false;     // 画面から見えなくなった → 復帰時に必ず作り直す
    private int recoverGen = 0;               // 古い復帰処理を打ち切るための世代番号
    private int lastVideoTrack = -2;          // 最後に確認できた映像トラック（作り直しの途中で止まっても戻せるように）
    private float zoomS = 1f, zoomTx = 0f, zoomTy = 0f;   // 拡大の状態（映像用ビューを作り直しても引き継ぐ）
    private String mediaUriStr = null;        // 開いている動画（開き直し用）
    private boolean reloading = false;        // 開き直しの再生開始待ち
    private boolean pauseAfterReload = false; // 開き直し前が一時停止だったら、再開後に止める
    private int reloadAudio = -2, reloadSpu = -2;
    private float reloadRate = 1f;

    private interface Cond { boolean ok(); }

    /** 条件が満たされるか timeout に達するまで 50ms ごとに確認し、終わったら then を実行（世代が変わったら中止） */
    private void waitFor(final int gen, final Cond c, final long timeout, final Runnable then) {
        final long t0 = SystemClock.elapsedRealtime();
        main.post(new Runnable() {
            @Override public void run() {
                if (gen != recoverGen) return;
                if (c.ok() || SystemClock.elapsedRealtime() - t0 >= timeout) { then.run(); return; }
                main.postDelayed(this, 50);
            }
        });
    }

    /** 現在位置へ再シーク（キーフレームから描画させる。一時停止中でも 1 コマ表示される） */
    private void kickFrame() {
        try {
            if (vlc == null || activityStopped) return;
            long t = vlc.getTime();
            if (t >= 0) vlc.setTime(t);
        } catch (Throwable ignored) {
        }
    }

    private void applyZoomNow() {
        try {
            if (videoLayout == null) return;
            videoLayout.setPivotX(videoLayout.getWidth() / 2f);
            videoLayout.setPivotY(videoLayout.getHeight() / 2f);
            videoLayout.setScaleX(zoomS);
            videoLayout.setScaleY(zoomS);
            videoLayout.setTranslationX(zoomTx);
            videoLayout.setTranslationY(zoomTy);
        } catch (Throwable ignored) {
        }
    }

    /** 映像用ビュー(SurfaceView を含む)を新品に作り直す */
    private void recreateVideoLayout() {
        Activity a = getActivity();
        if (a == null || clipBox == null) return;
        try {
            if (vlc != null) vlc.detachViews();
        } catch (Throwable ignored) {
        }
        viewsDetached = true;
        try {
            clipBox.removeView(videoLayout);
        } catch (Throwable ignored) {
        }
        videoLayout = new VLCVideoLayout(a);
        videoLayout.setBackgroundColor(Color.BLACK);
        clipBox.addView(videoLayout, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayout.post(new Runnable() {
            @Override public void run() { applyZoomNow(); }
        });
    }

    private void attachVideoViewsNow() {
        try {
            if (vlc != null && videoLayout != null) {
                vlc.attachViews(videoLayout, null, true, false);
                viewsDetached = false;
            }
        } catch (Throwable ignored) {
        }
    }

    /** 映像トラック一覧の先頭（ID が 0 以上のもの）。現在値も記録も無いときの最後の頼り */
    private int firstVideoTrackId() {
        try {
            var tracks = vlc.getVideoTracks();
            if (tracks != null) {
                for (var t : tracks) {
                    if (t.id >= 0) return t.id;
                }
            }
        } catch (Throwable ignored) {
        }
        return -1;
    }

    private int lastAudioSel = -2, lastSpuSel = -2;   // 再生中に最後に選ばれていた音声/字幕（終了後の再生で復元）

    /** 再生が終わった後の再生/シーク用: ファイル記述子の位置が末尾のままだと再生できないため、
     *  メディアを開き直して startMs の位置から再生する */
    private void restartFromEnd(long startMs) {
        if (vlc == null) return;
        try {
            if (libVLC == null || mediaUriStr == null) { ended = false; vlc.play(); return; }
            ParcelFileDescriptor npfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(mediaUriStr), "r");
            if (npfd == null) { ended = false; vlc.play(); return; }
            reloadAudio = lastAudioSel;
            reloadSpu = lastSpuSel;
            reloadRate = vlc.getRate();
            pauseAfterReload = false;
            main.removeCallbacks(endHoldTask);
            stopTicker();
            vlc.stop();
            closeMediaPfd();
            mediaPfd = npfd;
            Media m = new Media(libVLC, mediaPfd.getFileDescriptor());
            m.setHWDecoderEnabled(true, false);
            applyCompOptions(m);
            vlc.setMedia(m);
            m.release();
            pendingSeek = Math.max(0, startMs);
            voutCount = 0;
            voutSinceRestore = false;
            ended = false;
            reloading = true;
            vlc.play();
        } catch (Throwable th) {
            reloading = false;
            ended = false;
            try { vlc.play(); } catch (Throwable ignored) { }
        }
    }

    /** メディアを開き直して、同じ位置・同じ再生状態・同じ音声/字幕で再開する（映像パイプラインを丸ごと作り直す） */
    private boolean reloadMedia() {
        try {
            if (vlc == null || libVLC == null || mediaUriStr == null || ended) return false;
            ParcelFileDescriptor npfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(mediaUriStr), "r");
            if (npfd == null) return false;
            long t = vlc.getTime();
            boolean wasPlaying = vlc.isPlaying();
            reloadAudio = vlc.getAudioTrack();
            reloadSpu = vlc.getSpuTrack();
            reloadRate = vlc.getRate();
            pauseAfterReload = !wasPlaying;
            stopTicker();
            vlc.stop();
            closeMediaPfd();
            mediaPfd = npfd;
            Media m = new Media(libVLC, mediaPfd.getFileDescriptor());
            m.setHWDecoderEnabled(true, false);
            applyCompOptions(m);
            vlc.setMedia(m);
            m.release();
            pendingSeek = Math.max(0, t);
            voutCount = 0;
            voutSinceRestore = false;
            reloading = true;
            vlc.play();
            return true;
        } catch (Throwable th) {
            reloading = false;
            return false;
        }
    }

    /** レベル 2: 映像用ビューを作り直し、メディアを開き直す。映像出力ができなければ 1 回だけやり直す */
    private void recoverByReload(final int gen, final int tries) {
        recreateVideoLayout();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (gen != recoverGen) return;
                attachVideoViewsNow();
                main.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (gen != recoverGen) return;
                        if (!reloadMedia()) return;
                        waitFor(gen, new Cond() { @Override public boolean ok() { return voutCount > 0; } }, 4000, new Runnable() {
                            @Override public void run() {
                                if (gen != recoverGen || voutCount > 0) return;
                                if (tries < 1) recoverByReload(gen, tries + 1);
                            }
                        });
                    }
                }, 200);
            }
        }, 150);
    }

    /**
     * 映像を復帰させる。hint=戻す映像トラック(不明なら -2)、level=上記のレベル。
     * UI スレッドから呼ぶこと。
     */
    private void recoverVideo(final int hint, final int level) {
        if (vlc == null || videoLayout == null) return;
        final int gen = ++recoverGen;
        int cur = -1;
        try { cur = vlc.getVideoTrack(); } catch (Throwable ignored) { }
        if (cur >= 0) lastVideoTrack = cur;
        int tr = hint >= 0 ? hint : (cur >= 0 ? cur : lastVideoTrack);
        if (tr < 0) tr = firstVideoTrackId();
        if (tr < 0) {
            // 映像トラックなし（音声のみ）: ビューを付け直すだけ
            if (viewsDetached) attachVideoViewsNow();
            return;
        }
        final int track = tr;
        lastVideoTrack = track;
        voutSinceRestore = false;
        if (level >= 2) {
            recoverByReload(gen, 0);
            return;
        }
        // 1) 映像トラックを切る
        try { if (cur >= 0) vlc.setVideoTrack(-1); } catch (Throwable ignored) { }
        // 2) 映像出力が閉じるのを待つ（最大 1.5 秒）。デコーダの後始末が終わる前に戻すと無視されるため
        waitFor(gen, new Cond() { @Override public boolean ok() { return voutCount <= 0; } }, 1500, new Runnable() {
            @Override public void run() {
                // 3) 映像用ビューを外す（レベル 1 なら作り直す）
                if (level >= 1) recreateVideoLayout(); else detachVideoViews();
                main.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (gen != recoverGen) return;
                        // 4) 付け直す
                        attachVideoViewsNow();
                        main.postDelayed(new Runnable() {
                            @Override public void run() {
                                if (gen != recoverGen) return;
                                // 5) Surface が用意されてから映像トラックを戻す
                                try { vlc.setVideoTrack(track); } catch (Throwable ignored) { }
                                // 6) 現在位置へ再シーク（次のキーフレーム待ちで黒いままになるのを防ぐ）
                                if (KEYFRAME_KICK) {
                                    main.postDelayed(new Runnable() {
                                        @Override public void run() {
                                            if (gen != recoverGen) return;
                                            kickFrame();
                                        }
                                    }, 300);
                                }
                                // 7) 映像出力ができなければ、一段強い方法でやり直す
                                waitFor(gen, new Cond() { @Override public boolean ok() { return voutCount > 0; } }, 2500, new Runnable() {
                                    @Override public void run() {
                                        if (gen != recoverGen || voutCount > 0) return;
                                        recoverVideo(track, level + 1);
                                    }
                                });
                            }
                        }, 300);
                    }
                }, 150);
            }
        });
    }

    @Override
    protected void handleOnStop() {
        activityStopped = true;
        releaseViz();   // 画面が見えない間はアナライザーを止める（電池節約）。戻ったら handleOnResume で再開
        recoverGen++;                 // 途中の復帰処理は打ち切る
        needsRefresh = true;          // 小窓のまま消灯しても Surface は失われるので、復帰時に必ず作り直す
        // 画面から見えなくなったとき（ホーム / 画面消灯 / 他アプリへ切替）。小窓表示中は映像を残す
        try {
            Activity a = getActivity();
            boolean pip = Build.VERSION.SDK_INT >= 24 && a != null && a.isInPictureInPictureMode();
            if (pip || vlc == null) return;
            if (!backgroundPlay) {
                // 設定でオフ: アプリを離れたら一時停止（通知からは再開できる）
                if (vlc.isPlaying()) vlc.pause();
            } else if (vlc.isPlaying()) {
                suspendVideo();     // 音声は再生し続ける（通知・ロック画面から操作可能）
            }
            detachVideoViews();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void handleOnStart() {
        activityStopped = false;
        final int saved = savedVideoTrack;
        savedVideoTrack = -2;
        try {
            if (vlc == null) return;
            if (needsRefresh || viewsDetached || saved >= 0) {
                // 小窓のまま消灯した場合は、映像トラックを切らないまま描画面だけ失われている。
                // この状態はデコーダが不安定になるので、最初からメディアを開き直す（レベル 2）
                final boolean wedged = saved < 0 && !viewsDetached;
                needsRefresh = false;
                resumeStartMs = SystemClock.elapsedRealtime();   // 復帰にかかった時間の計測開始
                recoverVideo(saved, wedged ? 2 : 0);
            }
        } catch (Throwable ignored) {
        }
    }

    /** 手動の「映像を再読み込み」: 映像用ビューを作り直し、メディアを開き直して復帰させる（最も確実な方法） */
    @PluginMethod
    public void vlcRefreshVideo(final PluginCall call) {
        final Activity a = getActivity();
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureVlc();
                    activityStopped = false;     // 画面を操作できている = 前面にいる
                    resumeStartMs = SystemClock.elapsedRealtime();
                    recoverVideo(-2, 2);
                    call.resolve();
                } catch (Throwable t) {
                    call.reject(String.valueOf(t.getMessage()));
                }
            }
        });
    }

    private void restoreVideoTrack(int id) {
        try {
            if (vlc != null && !activityStopped) vlc.setVideoTrack(id);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void handleOnResume() {
        // アナライザー: 権限ダイアログから戻った / 画面に戻ったときに再開する
        try {
            if (vizWanted) {
                if (viz == null) {
                    if (vizPermitted()) startViz();
                    else if (vizPermAsked) emitAnalyzer("denied");
                } else {
                    main.removeCallbacks(vizTask);
                    main.post(vizTask);
                }
            }
        } catch (Throwable ignored) {
        }
        // 画面に戻ったとき、背面で起きた状態変化（通知やイヤホンのボタン操作）を画面に反映する
        try {
            if (vlc != null) {
                emit(vlc.isPlaying() ? "playing" : "paused");
                tick();
                scheduleTracks();
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void handleOnDestroy() {
        releaseVlc();
        try {
            if (mediaReceiver != null) getContext().unregisterReceiver(mediaReceiver);
        } catch (Exception ignored) {
        }
        mediaReceiver = null;
        try {
            if (noisyReceiver != null) getContext().unregisterReceiver(noisyReceiver);
        } catch (Exception ignored) {
        }
        noisyReceiver = null;
        try {
            if (receiver != null) getContext().unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
        receiver = null;
    }

    // ───────────────────────── JS から呼ばれるメソッド ─────────────────────────

    /** 端末の対応状況 */
    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("native", true);
        r.put("vlc", true);
        r.put("pip", pipSupported(getActivity()));
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** 全画面: ステータスバーとナビゲーションバーを隠す / 戻す。バーは画面端のスワイプで一時的に出せる */
    @PluginMethod
    public void setImmersive(final PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        final Activity activity = getActivity();
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Window window = activity.getWindow();
                    WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(window, window.getDecorView());
                    if (enabled) {
                        controller.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        controller.hide(WindowInsetsCompat.Type.systemBars());
                    } else {
                        controller.show(WindowInsetsCompat.Type.systemBars());
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            }
        });
    }

    /** 画面の向き: "landscape" | "portrait" | "auto" */
    @PluginMethod
    public void setOrientation(final PluginCall call) {
        String mode = call.getString("mode", "auto");
        final int orientation;
        if ("landscape".equals(mode)) {
            orientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE; // 左右どちらの横向きも可
        } else if ("portrait".equals(mode)) {
            orientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        } else {
            orientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;      // 端末の自動回転設定に従う
        }
        final Activity activity = getActivity();
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.setRequestedOrientation(orientation);
                call.resolve();
            }
        });
    }

    /** 再生状態・動画サイズを受け取る（自動PiP / PiPのボタン表示 / 画面常時点灯に使う） */
    @PluginMethod
    public void setPlaybackState(PluginCall call) {
        playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        autoPip = !Boolean.FALSE.equals(call.getBoolean("autoPip", true));
        Integer w = call.getInt("width", 16);
        Integer h = call.getInt("height", 9);
        if (w != null && h != null && w > 0 && h > 0) {
            videoW = w;
            videoH = h;
        }
        final Activity activity = getActivity();
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Window window = activity.getWindow();
                if (playing) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
                updatePipParams(activity);
            }
        });
        call.resolve();
    }

    /** ボタンから小窓にする */
    @PluginMethod
    public void enterPip(final PluginCall call) {
        final Activity activity = getActivity();
        if (!pipSupported(activity)) {
            call.reject("PiP is not supported");
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    boolean entered = activity.enterPictureInPictureMode(buildPipParams(activity));
                    JSObject r = new JSObject();
                    r.put("entered", entered);
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            }
        });
    }


    // ───────────────────────── 通知 / ロック画面 / イヤホンボタン（MediaSession） ─────────────────────────

    private static final String CHANNEL_ID = "playback";
    private String ACT_TOGGLE, ACT_REW, ACT_FF, ACT_PREV, ACT_NEXT;
    private MediaSession session;
    private String mediaTitle = "きゅうり動画";
    private long skipMs = 10000;
    private boolean playlistNav = false;     // プレイリストが 2 件以上ある（次へ/前へで曲送りする）
    private boolean hasPrev = false, hasNext = false;
    private boolean continuousNext = false;  // 終了後に自動で次へ進む予定（この間は前面サービスを維持）
    private PowerManager.WakeLock wakeLock;
    private boolean notifPermAsked = false;

    private void initActions() {
        String pkg = getContext().getPackageName();
        ACT_TOGGLE = pkg + ".MEDIA_TOGGLE";
        ACT_REW = pkg + ".MEDIA_REW";
        ACT_FF = pkg + ".MEDIA_FF";
        ACT_PREV = pkg + ".MEDIA_PREV";
        ACT_NEXT = pkg + ".MEDIA_NEXT";
    }

    /** UI スレッドから呼ぶこと */
    private void ensureSession() {
        if (session != null) return;
        if (ACT_TOGGLE == null) initActions();
        session = new MediaSession(getContext(), "KyuuriDouga");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { playNow(); }
            @Override public void onPause() { pauseNow(); }
            @Override public void onStop() { pauseNow(); }
            @Override public void onSeekTo(long pos) { seekMs(pos); }
            @Override public void onSkipToNext() { skipTrack(true); }
            @Override public void onSkipToPrevious() { skipTrack(false); }
            @Override public void onFastForward() { seekRelative(skipMs); }
            @Override public void onRewind() { seekRelative(-skipMs); }
        }, main);
        session.setActive(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "再生", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ((NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        // Android 13 以降は通知の許可が必要（初回の再生時に一度だけ尋ねる）
        if (Build.VERSION.SDK_INT >= 33 && !notifPermAsked
            && getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            notifPermAsked = true;
            try {
                getActivity().requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 9101);
            } catch (Exception ignored) {
            }
        }
    }

    private void playNow() {
        if (vlc == null) return;
        if (ended) { restartFromEnd(0); return; }   // 再生終了後は開き直して先頭から
        vlc.play();
    }

    private void pauseNow() {
        resumeOnFocusGain = false;   // ユーザー操作の一時停止なので、フォーカスが戻っても自動再開しない
        if (vlc != null && vlc.isPlaying()) vlc.pause();
    }

    private void togglePlayNow() {
        if (vlc == null) return;
        if (vlc.isPlaying()) pauseNow(); else playNow();
    }

    /** 次へ/前へ。プレイリストがあれば JS に曲送りを依頼し、無ければ従来どおり秒数スキップ */
    private void skipTrack(boolean next) {
        if (playlistNav) {
            notifyListeners(next ? "mediaNext" : "mediaPrev", new JSObject());
        } else {
            seekRelative(next ? skipMs : -skipMs);
        }
    }

    private void seekRelative(long deltaMs) {
        if (vlc == null) return;
        long len = vlc.getLength();
        long t = ended ? Math.max(0, len) : vlc.getTime();
        long target = Math.max(0, t + deltaMs);
        if (len > 0) target = Math.min(target, Math.max(0, len - 500));
        seekMs(target);
    }

    private void seekMs(long ms) {
        if (vlc == null) return;
        long t = Math.max(0L, ms);
        if (ended) {            // 再生終了後のシーク: メディアを開き直し、その位置から再生する
            restartFromEnd(t);
        } else if (pendingSeek >= 0 || reloading) {
            pendingSeek = t;    // 開き直しの再生開始待ち: 開始時に最後に指定された位置へ移動させる
        } else {
            vlc.setTime(t);
            main.postDelayed(new Runnable() {
                @Override public void run() { tick(); updateMedia(); }
            }, 150);
        }
    }

    /** 再生中だけ CPU を起こしておく（画面消灯中も音声が途切れないように） */
    private void setWakeLock(boolean on) {
        try {
            if (on) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kyuuri:playback");
                    wakeLock.setReferenceCounted(false);
                }
                if (!wakeLock.isHeld()) wakeLock.acquire();
            } else if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
    }

    /** MediaSession の状態・メタデータと通知を現在の再生状態に合わせる */
    private void updateMedia() {
        if (vlc == null) return;
        try {
            ensureSession();
            boolean playing = vlc.isPlaying();
            long len = vlc.getLength();
            long pos = Math.max(0, vlc.getTime());
            float rate = vlc.getRate();

            int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
            if (playlistNav) {
                // プレイリスト: 次へ/前へ で曲送り（端末が表示するボタンもこれになる）
                actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SKIP_TO_NEXT;
            } else {
                actions |= PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_REWIND
                    | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
            }
            session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, pos, playing ? rate : 0f, SystemClock.elapsedRealtime())
                .build());
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, mediaTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "きゅうり動画");
            if (len > 0) md.putLong(MediaMetadata.METADATA_KEY_DURATION, len);
            session.setMetadata(md.build());

            setWakeLock(playing);
            PlaybackService.show(getContext(), buildNotification(playing), playing || (ended && continuousNext));
        } catch (Throwable ignored) {
        }
    }

    private PendingIntent actionIntent(String action, int req) {
        Intent i = new Intent(action).setPackage(getContext().getPackageName());
        return PendingIntent.getBroadcast(getContext(), req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification(boolean playing) {
        Context c = getContext();
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(c, CHANNEL_ID) : new Notification.Builder(c);
        Intent open = new Intent(c, getActivity().getClass()).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(mediaTitle)
            .setContentText(playing ? "再生中" : "一時停止中")
            .setContentIntent(content)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .addAction(playlistNav ? android.R.drawable.ic_media_previous : android.R.drawable.ic_media_rew,
                playlistNav ? "前へ" : "戻る", actionIntent(playlistNav ? ACT_PREV : ACT_REW, 11))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "一時停止" : "再生", actionIntent(ACT_TOGGLE, 12))
            .addAction(playlistNav ? android.R.drawable.ic_media_next : android.R.drawable.ic_media_ff,
                playlistNav ? "次へ" : "進む", actionIntent(playlistNav ? ACT_NEXT : ACT_FF, 13))
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private void hideMedia() {
        resumeOnFocusGain = false;
        abandonAudioFocus();
        setWakeLock(false);
        PlaybackService.hide(getContext());
    }

    /** JS から: 通知に出すタイトルと、スキップ秒数 */
    @PluginMethod
    public void setMediaInfo(final PluginCall call) {
        final String title = call.getString("title");
        final Integer skip = call.hasOption("skipSeconds") ? call.getInt("skipSeconds", 10) : null;
        if (call.hasOption("pauseOnUnplug")) pauseOnUnplug = !Boolean.FALSE.equals(call.getBoolean("pauseOnUnplug", true));
        if (call.hasOption("backgroundPlay")) backgroundPlay = !Boolean.FALSE.equals(call.getBoolean("backgroundPlay", true));
        if (call.hasOption("playlistNav")) playlistNav = Boolean.TRUE.equals(call.getBoolean("playlistNav", false));
        if (call.hasOption("hasPrev")) hasPrev = Boolean.TRUE.equals(call.getBoolean("hasPrev", false));
        if (call.hasOption("hasNext")) hasNext = Boolean.TRUE.equals(call.getBoolean("hasNext", false));
        if (call.hasOption("continuous")) continuousNext = Boolean.TRUE.equals(call.getBoolean("continuous", false));
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (title != null && !title.isEmpty()) mediaTitle = title;
                if (skip != null && skip > 0) skipMs = skip * 1000L;
                updateMedia();
                call.resolve();
            }
        });
    }

    // ───────────────────────── オーディオフォーカス（通話・他アプリの音声との協調） ─────────────────────────

    private AudioFocusRequest focusRequest;        // Android 8.0 以降
    private boolean hasFocus = false;
    private boolean resumeOnFocusGain = false;     // 一時的な喪失（通話の着信など）で止めたときだけ、戻ったら自動再開
    private boolean ducked = false;                // 通知音などの間だけ音量を下げている
    private int userVolume = 100;                  // JS から指定された音量（ダッキング後に戻す基準）

    private final AudioManager.OnAudioFocusChangeListener focusListener = new AudioManager.OnAudioFocusChangeListener() {
        @Override
        public void onAudioFocusChange(int change) {
            if (vlc == null) return;
            switch (change) {
                case AudioManager.AUDIOFOCUS_LOSS:                    // 他の音楽アプリが再生を始めた等（恒久的）
                    hasFocus = false;
                    resumeOnFocusGain = false;
                    ducked = false;
                    applyVolume();
                    if (vlc.isPlaying()) vlc.pause();
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:          // 通話・アラームなど（一時的）
                    hasFocus = false;
                    if (vlc.isPlaying()) {
                        resumeOnFocusGain = true;
                        vlc.pause();
                    }
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: // 通知音など: 止めずに小さくする
                    ducked = true;
                    applyVolume();
                    break;
                case AudioManager.AUDIOFOCUS_GAIN:
                    hasFocus = true;
                    if (ducked) { ducked = false; applyVolume(); }
                    if (resumeOnFocusGain) {
                        resumeOnFocusGain = false;
                        playNow();
                    }
                    break;
                default:
                    break;
            }
        }
    };

    private AudioManager audioMgr() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /** フォーカスを持っていなければ要求する。取れなかった（通話中など）ら false */
    @SuppressWarnings("deprecation")
    private boolean ensureAudioFocus() {
        if (hasFocus) return true;
        AudioManager am = audioMgr();
        if (am == null) return true;           // 取得できない環境では従来どおり再生を妨げない
        int r;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build())
                    .setOnAudioFocusChangeListener(focusListener, main)
                    .build();
            }
            r = am.requestAudioFocus(focusRequest);
        } else {
            r = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        return hasFocus;
    }

    /** フォーカスを手放す（一時停止・終了・停止時）。一時喪失からの自動再開待ちの間は手放さない */
    @SuppressWarnings("deprecation")
    private void abandonAudioFocus() {
        if (resumeOnFocusGain) return;
        AudioManager am = audioMgr();
        if (am != null) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
                } else {
                    am.abandonAudioFocus(focusListener);
                }
            } catch (Throwable ignored) {
            }
        }
        hasFocus = false;
        ducked = false;
    }

    /** ユーザー指定の音量に、ダッキング中なら 20% を掛けて反映 */
    private void applyVolume() {
        if (vlc == null) return;
        try {
            int v = (ducked && userVolume > 0) ? Math.max(1, userVolume / 5) : userVolume;   // ミュート(0)は維持
            vlc.setVolume(Math.max(0, Math.min(200, v)));
        } catch (Throwable ignored) {
        }
    }

    // ───────────────────────── libVLC 再生エンジン ─────────────────────────

    private LibVLC libVLC;
    private MediaPlayer vlc;
    private VLCVideoLayout videoLayout;
    private android.widget.FrameLayout clipBox;   // 映像ビューを包み、拡大時にはみ出さないよう切り取る
    private ParcelFileDescriptor mediaPfd;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean ended = false;
    private long pendingSeek = -1;
    private boolean ticking = false;
    private int lastBg = 0;

    // 字幕解析用の読み出しキャッシュ
    private String readUri;
    private ParcelFileDescriptor readPfd;
    private FileInputStream readStream;

    // ───── A-B リピート（区間ループ）。画面を消している間も JS を介さず端末側で動く ─────
    private volatile long abA = -1, abB = -1;     // ミリ秒。無効なときは -1
    private long lastTickEmit = 0;

    /** 自動で次へ進むはずが 15 秒たっても再生が始まらない場合は、前面サービスを手放す */
    private final Runnable endHoldTask = new Runnable() {
        @Override
        public void run() {
            if (ended) {
                continuousNext = false;
                updateMedia();
            }
        }
    };

    private boolean abActive() {
        return abA >= 0 && abB > abA;
    }

    /** B に達したら A へ戻す。ユーザーが B より先へシークした場合（1.5 秒以上先）は戻さない */
    private void abCheck() {
        try {
            if (!abActive() || vlc == null || !vlc.isPlaying()) return;
            long t = vlc.getTime();
            if (t >= abB && t < abB + 1500) vlc.setTime(abA);
        } catch (Throwable ignored) {
        }
    }

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (!ticking) return;
            abCheck();
            long now = SystemClock.elapsedRealtime();
            if (now - lastTickEmit >= 250) {
                lastTickEmit = now;
                tick();
            }
            main.postDelayed(this, abActive() ? 50 : 250);
        }
    };

    /** A-B リピートの区間を設定（a / b はミリ秒。どちらかが負なら解除） */
    @PluginMethod
    public void vlcSetAbLoop(final PluginCall call) {
        final long a = call.hasOption("a") ? Math.round(call.getDouble("a", -1.0)) : -1L;
        final long b = call.hasOption("b") ? Math.round(call.getDouble("b", -1.0)) : -1L;
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (a >= 0 && b > a) { abA = a; abB = b; } else { abA = -1; abB = -1; }
                call.resolve();
            }
        });
    }

    private final Runnable tracksTask = new Runnable() {
        @Override
        public void run() {
            sendTracks();
        }
    };

    /** UI スレッドから呼ぶこと */
    private void ensureVlc() {
        if (vlc != null) return;
        Activity a = getActivity();
        ArrayList<String> opts = new ArrayList<>();
        opts.add("--audio-time-stretch"); // 倍速再生でも音程を保つ
        // スペクトラムアナライザー用: libVLC の AudioTrack を固定の音声セッションに入れ、Visualizer をそこへ繋ぐ
        try {
            AudioManager am0 = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
            int sid = (Build.VERSION.SDK_INT >= 21 && am0 != null) ? am0.generateAudioSessionId() : 0;
            audioSessionId = sid > 0 ? sid : 0;
            if (audioSessionId > 0) opts.add("--audiotrack-session-id=" + audioSessionId);
        } catch (Throwable ignored) {
            audioSessionId = 0;
        }
        libVLC = new LibVLC(a, opts);
        vlc = new MediaPlayer(libVLC);
        applyEqualizer();   // JS から先に届いていたイコライザー設定を反映

        // 映像用ビューを WebView の背面（同じ親の先頭）に追加し、WebView を透明にして重ねる
        videoLayout = new VLCVideoLayout(a);
        videoLayout.setBackgroundColor(Color.BLACK);
        clipBox = new android.widget.FrameLayout(a);
        clipBox.setClipChildren(true);
        clipBox.setClipToPadding(true);
        clipBox.addView(videoLayout, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View web = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        parent.addView(clipBox, 0, new ViewGroup.MarginLayoutParams(1, 1));
        clipBox.setVisibility(View.GONE);
        web.setBackgroundColor(Color.TRANSPARENT);

        vlc.attachViews(videoLayout, null, true, false);
        vlc.setEventListener(new MediaPlayer.EventListener() {
            @Override
            public void onEvent(MediaPlayer.Event e) {
                switch (e.type) {
                    case MediaPlayer.Event.Playing:
                        ended = false;
                        if (pendingSeek >= 0) {
                            vlc.setTime(pendingSeek);
                            pendingSeek = -1;
                        }
                        if (reloading) {
                            // 映像復帰のためにメディアを開き直した直後: 再生速度・音声・字幕を元に戻す
                            reloading = false;
                            final int ra = reloadAudio, rs = reloadSpu;
                            try { if (reloadRate > 0 && reloadRate != 1f) vlc.setRate(reloadRate); } catch (Throwable ignored) { }
                            main.postDelayed(new Runnable() {
                                @Override public void run() {
                                    try {
                                        if (vlc == null) return;
                                        if (ra >= -1) vlc.setAudioTrack(ra);
                                        if (rs >= -1) vlc.setSpuTrack(rs);
                                    } catch (Throwable ignored) {
                                    }
                                }
                            }, 600);
                            if (pauseAfterReload) {
                                pauseAfterReload = false;
                                vlc.pause();
                                break;
                            }
                        }
                        if (!ensureAudioFocus()) {   // 通話中など、他が音声を占有している間は再生しない
                            vlc.pause();
                            break;
                        }
                        main.removeCallbacks(endHoldTask);
                        if (activityStopped) suspendVideo();   // 画面外での再開でも映像デコードは行わない
                        if (vizWanted && viz == null) startViz();
                        emit("playing");
                        startTicker();
                        scheduleTracks();
                        updateMedia();
                        break;
                    case MediaPlayer.Event.Paused:
                        stopTicker();
                        tick();
                        abandonAudioFocus();
                        emit("paused");
                        updateMedia();
                        break;
                    case MediaPlayer.Event.Stopped:
                        stopTicker();
                        break;
                    case MediaPlayer.Event.EndReached:
                        if (abActive()) {
                            // A-B リピート中に、B に届く前にファイルが終わった（B が末尾ぎりぎり）: A へ戻って続ける
                            ended = true;
                            seekMs(abA);
                            break;
                        }
                        ended = true;
                        resumeOnFocusGain = false;
                        abandonAudioFocus();
                        stopTicker();
                        tick();
                        emit("ended");
                        updateMedia();
                        main.removeCallbacks(endHoldTask);
                        if (continuousNext) main.postDelayed(endHoldTask, 15000);
                        break;
                    case MediaPlayer.Event.EncounteredError:
                        stopTicker();
                        emit("error");
                        break;
                    case MediaPlayer.Event.Vout:
                        voutCount = e.getVoutCount();
                        if (voutCount > 0) voutSinceRestore = true;   // 出力が閉じた通知(0)を成功と数えない
                        if (voutCount > 0 && resumeStartMs > 0 && !activityStopped) {
                            long ms = SystemClock.elapsedRealtime() - resumeStartMs;
                            resumeStartMs = 0;
                            android.util.Log.d("KyuuriResume", "video restored in " + ms + " ms");
                            JSObject rt = new JSObject();
                            rt.put("type", "resumeTiming");
                            rt.put("ms", ms);
                            notifyListeners("vlc", rt);
                        }
                        scheduleTracks();
                        break;
                    case MediaPlayer.Event.ESAdded:
                        scheduleTracks();
                        break;
                    case MediaPlayer.Event.LengthChanged:
                        tick();
                        updateMedia();
                        break;
                    default:
                        break;
                }
            }
        });
    }

    private void releaseVlc() {
        releaseViz();
        hideMedia();
        try {
            if (session != null) { session.setActive(false); session.release(); }
        } catch (Exception ignored) {
        }
        session = null;
        try {
            ticking = false;
            main.removeCallbacksAndMessages(null);
            if (vlc != null) {
                vlc.setEventListener(null);
                vlc.stop();
                vlc.detachViews();
                vlc.release();
            }
            if (libVLC != null) libVLC.release();
        } catch (Exception ignored) {
        }
        vlc = null;
        libVLC = null;
        eq = null;   // この libVLC の Equalizer には release() が無い（GC に任せる）
        closeMediaPfd();
        closeReader();
    }

    private void closeMediaPfd() {
        if (mediaPfd != null) {
            try { mediaPfd.close(); } catch (Exception ignored) { }
            mediaPfd = null;
        }
    }

    private void closeReader() {
        try { if (readStream != null) readStream.close(); } catch (Exception ignored) { }
        try { if (readPfd != null) readPfd.close(); } catch (Exception ignored) { }
        readStream = null;
        readPfd = null;
        readUri = null;
    }

    // ───────────────────────── スペクトラムアナライザー ─────────────────────────
    // libVLC の音声出力(AudioTrack)を固定セッションに入れ、android.media.audiofx.Visualizer でその出力（EQ 適用後）の
    // FFT を取り、対数間隔の VIZ_BINS 本に畳んで JS へ送る。端末のマイクは使わない（RECORD_AUDIO は Visualizer の仕様上必要）。

    private static final int VIZ_BINS = 64;
    private int audioSessionId = 0;
    private Visualizer viz;
    private boolean vizWanted = false;
    private boolean vizPermAsked = false;
    private boolean vizZeroSent = true;
    private byte[] vizFft;
    private byte[] vizWave;
    private float vizLevelDb = -100f;   // 出力の RMS レベル(dBFS)。コンプレッサー画面の「今の音量」表示用
    private float[] vizMag;

    private boolean vizPermitted() {
        return ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void emitAnalyzer(String state) {
        JSObject o = new JSObject();
        o.put("type", "analyzer");
        o.put("state", state);
        notifyListeners("vlc", o);
    }

    private void releaseViz() {
        main.removeCallbacks(vizTask);
        Visualizer v = viz;
        viz = null;
        if (v != null) {
            try { v.setEnabled(false); } catch (Throwable ignored) { }
            try { v.release(); } catch (Throwable ignored) { }
        }
    }

    /** UI スレッドから呼ぶこと */
    private void startViz() {
        if (!vizWanted || viz != null) return;
        if (audioSessionId <= 0 || !vizPermitted()) return;
        try {
            Visualizer v = new Visualizer(audioSessionId);
            int[] range = Visualizer.getCaptureSizeRange();
            v.setCaptureSize(range[1]);              // 最大（通常 1024）
            v.setEnabled(true);
            viz = v;
            vizFft = new byte[v.getCaptureSize()];
            vizWave = new byte[v.getCaptureSize()];
            vizMag = new float[vizFft.length / 2 + 1];
            vizZeroSent = false;
            emitAnalyzer("on");
            main.removeCallbacks(vizTask);
            main.post(vizTask);
        } catch (Throwable t) {
            releaseViz();
            emitAnalyzer("error");
        }
    }

    private final Runnable vizTask = new Runnable() {
        @Override
        public void run() {
            if (viz == null || !vizWanted) return;
            boolean playing = false;
            try { playing = vlc != null && vlc.isPlaying() && !activityStopped; } catch (Throwable ignored) { }
            if (playing) {
                try {
                    if (viz.getFft(vizFft) == Visualizer.SUCCESS) {
                        updateLevel();
                        sendSpectrum(false);
                    }
                } catch (Throwable ignored) { }
                main.postDelayed(this, 40);
            } else {
                if (!vizZeroSent) { sendSpectrum(true); vizZeroSent = true; }
                main.postDelayed(this, 200);
            }
        }
    };

    /** 波形(8bit)から RMS レベル(dBFS)を求める */
    private void updateLevel() {
        try {
            if (viz.getWaveForm(vizWave) != Visualizer.SUCCESS) return;
            double sum = 0;
            for (int i = 0; i < vizWave.length; i++) {
                double x = ((vizWave[i] & 0xFF) - 128) / 128.0;
                sum += x * x;
            }
            double rms = Math.sqrt(sum / vizWave.length);
            vizLevelDb = rms > 1e-5 ? (float) (20 * Math.log10(rms)) : -100f;
        } catch (Throwable ignored) {
        }
    }

    /** FFT(実部/虚部の並び)を 30 Hz〜約 18 kHz の対数 64 本(0〜255)に畳んで送る */
    private void sendSpectrum(boolean silent) {
        JSArray arr = new JSArray();
        if (silent || viz == null) {
            for (int j = 0; j < VIZ_BINS; j++) arr.put(0);
        } else {
            int cs = vizFft.length, half = cs / 2;
            vizMag[0] = Math.abs(vizFft[0]);
            vizMag[half] = Math.abs(vizFft[1]);
            for (int k = 1; k < half; k++) {
                float re = vizFft[2 * k], im = vizFft[2 * k + 1];
                vizMag[k] = (float) Math.sqrt(re * re + im * im);
            }
            double sr = viz.getSamplingRate() / 1000.0;   // mHz → Hz
            if (sr < 8000) sr = 44100;
            double binHz = sr / cs;
            double fmin = 30, fmax = Math.min(18000, sr / 2 * 0.98);
            double ratio = fmax / fmin;
            for (int j = 0; j < VIZ_BINS; j++) {
                double f0 = fmin * Math.pow(ratio, (double) j / VIZ_BINS);
                double f1 = fmin * Math.pow(ratio, (double) (j + 1) / VIZ_BINS);
                double k0 = f0 / binHz, k1 = f1 / binHz;
                double m;
                if (k1 - k0 < 1.0) {                        // 低域: 1 ビンより狭いので隣のビンから補間
                    double kc = (k0 + k1) / 2;
                    int ia = (int) Math.floor(kc);
                    int ib = Math.min(half, ia + 1);
                    ia = Math.max(0, Math.min(half, ia));
                    double fr = kc - Math.floor(kc);
                    m = vizMag[ia] * (1 - fr) + vizMag[ib] * fr;
                } else {                                    // 高域: 範囲内の最大値
                    int ia = Math.max(0, (int) Math.ceil(k0));
                    int ib = Math.min(half, (int) Math.floor(k1));
                    m = 0;
                    for (int k = ia; k <= ib; k++) if (vizMag[k] > m) m = vizMag[k];
                }
                double db = 20 * Math.log10(m + 0.5);              // 0.5 = 無音の下駄（ちらつき防止）
                db += 2.5 * Math.log(Math.sqrt(f0 * f1) / 1000.0) / Math.log(2);   // 高域が低く見えないよう +2.5 dB/oct の傾き補正
                double v = (db - 2) / 40.0;
                if (v < 0) v = 0; else if (v > 1) v = 1;
                arr.put((int) Math.round(v * 255));
            }
        }
        JSObject o = new JSObject();
        o.put("type", "spectrum");
        o.put("bins", arr);
        o.put("level", silent ? -100.0 : (double) vizLevelDb);
        notifyListeners("vlc", o);
    }

    /** イコライザー画面を開いている間だけ有効にする。初回は録音権限（RECORD_AUDIO）を要求する */
    @PluginMethod
    public void vlcAnalyzerSet(final PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                JSObject r = new JSObject();
                try {
                    vizWanted = on;
                    if (!on) {
                        releaseViz();
                        r.put("state", "off");
                    } else {
                        try { ensureVlc(); } catch (Throwable ignored) { }
                        if (audioSessionId <= 0) {
                            r.put("state", "unsupported");
                        } else if (!vizPermitted()) {
                            if (!vizPermAsked) {
                                vizPermAsked = true;
                                ActivityCompat.requestPermissions(getActivity(),
                                    new String[]{android.Manifest.permission.RECORD_AUDIO}, 9102);
                                r.put("state", "pending");   // 結果は handleOnResume で拾う
                            } else {
                                r.put("state", "denied");
                            }
                        } else {
                            startViz();
                            r.put("state", viz != null ? "on" : "error");
                        }
                    }
                } catch (Throwable t) {
                    r.put("state", "error");
                }
                call.resolve(r);
            }
        });
    }

    private void emit(String type) {
        JSObject o = new JSObject();
        o.put("type", type);
        notifyListeners("vlc", o);
    }

    private void startTicker() {
        if (ticking) return;
        ticking = true;
        main.post(ticker);
    }

    private void stopTicker() {
        ticking = false;
        main.removeCallbacks(ticker);
    }

    private void tick() {
        if (vlc == null) return;
        try {
            if (vlc.isPlaying()) { lastAudioSel = vlc.getAudioTrack(); lastSpuSel = vlc.getSpuTrack(); }
        } catch (Throwable ignored) { }
        JSObject o = new JSObject();
        o.put("type", "time");
        o.put("time", vlc.getTime());
        o.put("length", vlc.getLength());
        notifyListeners("vlc", o);
    }

    private void scheduleTracks() {
        main.removeCallbacks(tracksTask);
        main.postDelayed(tracksTask, 400);
    }

    private void sendTracks() {
        if (vlc == null) return;
        try {
            JSObject o = new JSObject();
            o.put("type", "tracks");
            o.put("audio", trackArray(true));
            o.put("audioCurrent", vlc.getAudioTrack());
            o.put("spu", trackArray(false));
            o.put("spuCurrent", vlc.getSpuTrack());
            int w = 0, h = 0;
            try {
                var vt = vlc.getCurrentVideoTrack();
                if (vt != null) { w = vt.width; h = vt.height; }
            } catch (Throwable ignored) {
            }
            o.put("width", w);
            o.put("height", h);
            notifyListeners("vlc", o);
        } catch (Exception ignored) {
        }
    }

    private JSArray trackArray(boolean audio) {
        JSArray arr = new JSArray();
        try {
            var tracks = audio ? vlc.getAudioTracks() : vlc.getSpuTracks();
            if (tracks != null) {
                for (var t : tracks) {
                    JSObject x = new JSObject();
                    x.put("id", t.id);
                    x.put("name", t.name == null ? "" : t.name);
                    arr.put(x);
                }
            }
        } catch (Throwable ignored) {
        }
        return arr;
    }

    /** ファイル選択（Storage Access Framework）。拡張子・MIME で絞らず、あらゆるファイルを選べる */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);   // 長押しで複数選択 → プレイリスト
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result == null ? null : result.getData();
        // 単一選択は getData()、複数選択は getClipData() に入る
        List<Uri> uris = new ArrayList<>();
        if (result != null && result.getResultCode() == Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                android.content.ClipData cd = data.getClipData();
                for (int i = 0; i < cd.getItemCount(); i++) {
                    Uri u = cd.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        if (uris.isEmpty()) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        JSArray files = new JSArray();
        for (Uri u : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            files.put(describe(u));
        }
        JSObject r = describe(uris.get(0));   // 従来どおり先頭の 1 件も返す（互換）
        r.put("files", files);
        call.resolve(r);
    }

    /** URI からファイル名・サイズ・更新日時を調べて JS 用オブジェクトにする */
    private JSObject describe(Uri uri) {
        String name = null;
        long size = 0, modified = 0;
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) name = c.getString(i);
                i = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) size = c.getLong(i);
                i = c.getColumnIndex("last_modified");
                if (i >= 0 && !c.isNull(i)) modified = c.getLong(i);
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() == null ? "video" : uri.getLastPathSegment();
        if (size <= 0) {
            try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "r")) {
                if (pfd != null) size = pfd.getStatSize();
            } catch (Exception ignored) {
            }
        }
        JSObject r = new JSObject();
        r.put("uri", uri.toString());
        r.put("name", name);
        r.put("size", size);
        r.put("modified", modified);
        return r;
    }

    // ───────────── 「このアプリで開く」（他アプリ・ファイルマネージャーからの起動） ─────────────

    /** MainActivity が受け取った Intent から取り出した動画の URI（JS が受け取るまで保持） */
    private static volatile Uri pendingLaunchUri = null;

    /** Intent（VIEW / SEND）から動画の URI を取り出す */
    public static Uri uriFromIntent(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        try {
            if (Intent.ACTION_VIEW.equals(action)) {
                return intent.getData();
            } else if (Intent.ACTION_SEND.equals(action)) {
                Object o = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (o instanceof Uri) return (Uri) o;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 起動時に渡されたファイル（無ければ空）。受け取ると消える */
    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Uri u = pendingLaunchUri;
        pendingLaunchUri = null;
        if (u == null) { call.resolve(new JSObject()); return; }
        call.resolve(describe(u));
    }

    /** アプリが起動済みの状態で別のファイルを「開く」で渡されたとき（MainActivity.onNewIntent） */
    public void onOpenUri(Uri uri) {
        if (uri == null) return;
        pendingLaunchUri = null;
        notifyListeners("openUri", describe(uri));
    }

    public static void setPendingLaunchUri(Uri uri) {
        pendingLaunchUri = uri;
    }

    /**
     * MKV のテキスト字幕・トラック情報をネイティブで高速に取り出す（MkvScanner）。
     * 数 GB の動画でも映像ブロックは読まずに飛ばすため速い。専用スレッドで動かし、再生操作をブロックしない。
     * 失敗したとき（MKV でない・読めない等）は reject し、JS 側が従来の JS 走査に切り替える。
     */
    private final java.util.concurrent.atomic.AtomicInteger scanSeq = new java.util.concurrent.atomic.AtomicInteger();

    @PluginMethod
    public void scanMkvSubs(final PluginCall call) {
        final String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("no uri"); return; }
        final int seq = scanSeq.incrementAndGet();   // 新しい走査が始まったら古いものは中断する
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
                } catch (Throwable ignored) {
                }
                ParcelFileDescriptor pfd = null;
                FileInputStream in = null;
                try {
                    pfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(uriStr), "r");
                    if (pfd == null) { call.reject("cannot open"); return; }
                    in = new FileInputStream(pfd.getFileDescriptor());
                    FileChannel ch = in.getChannel();
                    long size = pfd.getStatSize();
                    if (size <= 0) size = ch.size();
                    MkvScanner.Result res = new MkvScanner(ch, size, new MkvScanner.Cancel() {
                        @Override public boolean isCancelled() { return seq != scanSeq.get(); }
                    }).scan();

                    JSObject o = new JSObject();
                    o.put("ok", true);
                    o.put("timecodeScale", res.timecodeScale);
                    JSArray tr = new JSArray();
                    for (MkvScanner.Track t : res.tracks) {
                        JSObject x = new JSObject();
                        x.put("number", t.number);
                        x.put("type", t.type);
                        x.put("codecId", t.codecId);
                        x.put("lang", t.lang);
                        x.put("name", t.name);
                        x.put("defDur", t.defDur);
                        x.put("compAlgo", t.compAlgo);
                        if (t.compSettings != null) x.put("compSettings", Base64.encodeToString(t.compSettings, Base64.NO_WRAP));
                        tr.put(x);
                    }
                    o.put("tracks", tr);
                    JSArray cs = new JSArray();
                    for (MkvScanner.Cue c : res.cues) {
                        JSObject x = new JSObject();
                        x.put("track", c.track);
                        x.put("ticks", c.ticks);
                        x.put("dur", c.dur);
                        x.put("data", Base64.encodeToString(c.data, Base64.NO_WRAP));
                        cs.put(x);
                    }
                    o.put("cues", cs);
                    call.resolve(o);
                } catch (Throwable t) {
                    call.reject(String.valueOf(t.getMessage()));
                } finally {
                    try { if (in != null) in.close(); } catch (Exception ignored) { }
                    try { if (pfd != null) pfd.close(); } catch (Exception ignored) { }
                }
            }
        }, "mkv-scan");
        th.setDaemon(true);
        th.start();
    }

    /** 字幕解析用: ファイルの一部を Base64 で返す（長さ 0 で EOF） */
    @PluginMethod
    public void readChunk(PluginCall call) {
        String uri = call.getString("uri");
        Double off = call.getDouble("offset", 0.0);
        Integer len = call.getInt("length", 524288);
        if (uri == null || off == null || len == null) { call.reject("bad args"); return; }
        try {
            if (readStream == null || !uri.equals(readUri)) {
                closeReader();
                readPfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(uri), "r");
                if (readPfd == null) { call.reject("cannot open"); return; }
                readStream = new FileInputStream(readPfd.getFileDescriptor());
                readUri = uri;
            }
            FileChannel ch = readStream.getChannel();
            ByteBuffer buf = ByteBuffer.allocate(Math.max(1, Math.min(len, 4 * 1024 * 1024)));
            ch.position(off.longValue());
            int n = ch.read(buf);
            JSObject r = new JSObject();
            if (n <= 0) {
                r.put("length", 0);
                r.put("data", "");
            } else {
                r.put("length", n);
                r.put("data", Base64.encodeToString(buf.array(), 0, n, Base64.NO_WRAP));
            }
            call.resolve(r);
        } catch (Exception e) {
            closeReader();
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** 映像の表示位置（WebView 上の #videobox の矩形, CSS px）を受け取り、背面の映像ビューを合わせる */
    @PluginMethod
    public void vlcSetRect(final PluginCall call) {
        final double x = call.getDouble("x", 0.0), y = call.getDouble("y", 0.0);
        final double w = call.getDouble("w", 0.0), h = call.getDouble("h", 0.0);
        final boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", false));
        final String bg = call.getString("bg");
        final Activity a = getActivity();
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureVlc();
                    float d = a.getResources().getDisplayMetrics().density;
                    View web = getBridge().getWebView();
                    ViewGroup.LayoutParams base = clipBox.getLayoutParams();
                    if (base instanceof ViewGroup.MarginLayoutParams) {
                        ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) base;
                        lp.width = Math.max(1, Math.round((float) (w * d)));
                        lp.height = Math.max(1, Math.round((float) (h * d)));
                        lp.leftMargin = web.getLeft() + Math.round((float) (x * d));
                        lp.topMargin = web.getTop() + Math.round((float) (y * d));
                        clipBox.setLayoutParams(lp);
                    }
                    clipBox.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (bg != null) {
                        try {
                            int c = Color.parseColor(bg);
                            if (c != lastBg) {
                                lastBg = c;
                                ((View) web.getParent()).setBackgroundColor(c);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                    call.resolve();
                } catch (Throwable t) {
                    call.reject(String.valueOf(t.getMessage()));
                }
            }
        });
    }

    /** 映像の拡大（ピンチ）。scale=倍率(1=等倍), tx/ty=移動量(CSS px)。映像ビューの枠の中心を基準に拡大する */
    @PluginMethod
    public void vlcSetZoom(final PluginCall call) {
        final double sc = call.getDouble("scale", 1.0);
        final double tx = call.getDouble("tx", 0.0), ty = call.getDouble("ty", 0.0);
        final Activity a = getActivity();
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    float d = a.getResources().getDisplayMetrics().density;
                    zoomS = (float) Math.max(1.0, Math.min(8.0, sc));
                    zoomTx = (float) (tx * d);
                    zoomTy = (float) (ty * d);
                    applyZoomNow();
                    call.resolve();
                } catch (Throwable t) {
                    call.reject(String.valueOf(t.getMessage()));
                }
            }
        });
    }

    // ── 1 フレーム送り / 戻し ──
    // 進む: libVLC の nextFrame()（リフレクションで呼ぶ。無い版では時間指定のシークで代用）
    // 戻る: VLC に逆送りは無いので、フレーム間隔ぶん手前へ精密シークする。
    //   精密シークは「指定時刻以降で最初のフレーム」を表示するため、時刻の基準がずれても飛ばさない/止まらないよう、
    //   最初の 1 回は 1.5 フレーム手前、続けて押すときは前回の目標時刻から 1 フレームずつ動かす。
    private long stepT = Long.MIN_VALUE;     // 直前のステップで指定した目標時刻（ms）

    /** 1 フレームの長さ(ms)。取得できなければ 30fps とみなす */
    private double frameMs() {
        try {
            Object vt = vlc.getCurrentVideoTrack();
            if (vt != null) {
                int num = vt.getClass().getField("frameRateNum").getInt(vt);
                int den = vt.getClass().getField("frameRateDen").getInt(vt);
                if (num > 0 && den > 0) {
                    double f = 1000.0 * den / num;
                    if (f >= 4 && f <= 200) return f;
                }
            }
        } catch (Throwable ignored) {
        }
        return 1000.0 / 30.0;
    }

    private void stepBySeek(int dir, int count) {
        long t = vlc.getTime();
        if (t < 0) return;
        double f = frameMs();
        boolean tracking = stepT != Long.MIN_VALUE && Math.abs(t - stepT) <= 3;
        // 精密シークは「指定時刻以降で最初のフレーム」を表示する。
        // 初回は N フレーム先/前の少し手前(0.5 フレーム分)を狙い、連続時は前回の目標から N フレームずつ動かす
        long target;
        if (dir > 0) target = Math.round(tracking ? stepT + count * f : t + (count - 0.5) * f);
        else target = Math.round(tracking ? stepT - count * f : t - (count + 0.5) * f);
        long len = vlc.getLength();
        if (len > 0) target = Math.min(target, len - 1);
        target = Math.max(0, target);
        stepT = target;
        vlc.setTime(target);
    }

    private void stepFrame(final int dir, final int count) {
        if (vlc == null) return;
        if (ended && dir > 0) return;
        ended = false;
        if (vlc.isPlaying()) vlc.pause();
        // 1 フレーム進むだけは libVLC の nextFrame()（正確）。それ以外はシークで動かす
        if (dir > 0 && count == 1) {
            final long before = vlc.getTime();
            boolean called = false;
            try {
                vlc.getClass().getMethod("nextFrame").invoke(vlc);
                called = true;
            } catch (Throwable ignored) {
            }
            if (called) {
                stepT = Long.MIN_VALUE;
                // 時刻が進まなければ nextFrame が効いていない（端末のデコーダによる）ので、シークで代用する
                main.postDelayed(new Runnable() {
                    @Override public void run() {
                        try {
                            if (vlc == null || vlc.isPlaying()) return;
                            long now = vlc.getTime();
                            long len = vlc.getLength();
                            if (now == before && !(len > 0 && now >= len - 50)) {
                                stepBySeek(1, 1);
                                main.postDelayed(new Runnable() {
                                    @Override public void run() { tick(); }
                                }, 120);
                            } else {
                                tick();
                            }
                        } catch (Throwable ignored) {
                        }
                    }
                }, 150);
                return;
            }
        }
        stepBySeek(dir, count);
        main.postDelayed(new Runnable() {
            @Override public void run() { tick(); }
        }, 120);
    }

    @PluginMethod
    public void vlcStepFrame(final PluginCall call) {
        final int dir = call.getInt("dir", 1) >= 0 ? 1 : -1;
        final int count = Math.max(1, Math.min(600, call.getInt("count", 1)));
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    stepFrame(dir, count);
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcLoad(final PluginCall call) {
        final String uriStr = call.getString("uri");
        final Activity a = getActivity();
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (uriStr == null) { call.reject("no uri"); return; }
                    ensureVlc();
                    stopTicker();
                    vlc.stop();
                    closeMediaPfd();
                    ended = false;
                    pendingSeek = -1;
                    savedVideoTrack = -2;
                    lastVideoTrack = -2;
                    lastAudioSel = -2; lastSpuSel = -2;
                    mediaUriStr = uriStr;
                    reloading = false;
                    abA = -1; abB = -1;
                    mediaPfd = getContext().getContentResolver().openFileDescriptor(Uri.parse(uriStr), "r");
                    if (mediaPfd == null) { call.reject("cannot open"); emit("error"); return; }
                    Media m = new Media(libVLC, mediaPfd.getFileDescriptor());
                    m.setHWDecoderEnabled(true, false);
                    applyCompOptions(m);
                    vlc.setMedia(m);
                    m.release();
                    call.resolve();
                } catch (Throwable t) {
                    emit("error");
                    call.reject(String.valueOf(t.getMessage()));
                }
            }
        });
    }

    @PluginMethod
    public void vlcPlay(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureVlc();
                    if (ended) restartFromEnd(0); else vlc.play();
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcPause(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    resumeOnFocusGain = false;
                    if (vlc != null && vlc.isPlaying()) vlc.pause();
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcSeek(final PluginCall call) {
        final Double ms = call.getDouble("time", 0.0);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (ms != null) seekMs(ms.longValue());
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcSetRate(final PluginCall call) {
        final Float rate = call.getFloat("rate", 1f);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureVlc();
                    if (rate != null && rate > 0) { vlc.setRate(rate); updateMedia(); }
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcSetVolume(final PluginCall call) {
        final Integer v = call.getInt("volume", 100);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureVlc();
                    if (v != null) { userVolume = Math.max(0, Math.min(200, v)); applyVolume(); }
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcSetAudioTrack(final PluginCall call) {
        final Integer id = call.getInt("id", -1);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (vlc != null && id != null) vlc.setAudioTrack(id);
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcSetSpuTrack(final PluginCall call) {
        final Integer id = call.getInt("id", -1);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (vlc != null && id != null) vlc.setSpuTrack(id);
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    // ───────────────────────── イコライザー（libVLC 標準の 10 バンド） ─────────────────────────
    // 設定は JS から届くたびにフィールドへ保存し、再生エンジンがあれば即反映する。
    // MediaPlayer.setEqualizer は「再生中の音声にすぐ反映 / 以降に再生するメディアにも自動適用」されるので、
    // 動画を切り替えたり映像復帰でメディアを開き直しても設定は保たれる。
    private MediaPlayer.Equalizer eq;
    private boolean eqEnabled = false;
    private float eqPreamp = 0f;                 // dB（-20〜+20）
    private float[] eqBands = new float[10];     // dB（-20〜+20）。バンド数は libVLC に合わせて使う

    /** UI スレッドから呼ぶこと */
    private void applyEqualizer() {
        if (vlc == null) return;
        try {
            if (!eqEnabled) {
                vlc.setEqualizer(null);
                return;
            }
            if (eq == null) eq = MediaPlayer.Equalizer.create();
            eq.setPreAmp(eqPreamp);
            int n = Math.min(eqBands.length, MediaPlayer.Equalizer.getBandCount());
            for (int i = 0; i < n; i++) eq.setAmp(i, eqBands[i]);
            vlc.setEqualizer(eq);
        } catch (Throwable ignored) {
        }
    }

    private static float clampDb(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return 0f;
        return (float) Math.max(-20.0, Math.min(20.0, v));
    }

    /** バンド数・各バンドの周波数・libVLC 内蔵プリセット（名前と各バンドの値）を返す */
    @PluginMethod
    public void vlcEqInfo(final PluginCall call) {
        JSObject out = new JSObject();
        try {
            int bc = MediaPlayer.Equalizer.getBandCount();
            JSArray freqs = new JSArray();
            for (int i = 0; i < bc; i++) freqs.put(Double.valueOf(MediaPlayer.Equalizer.getBandFrequency(i)));
            JSArray presets = new JSArray();
            int pc = MediaPlayer.Equalizer.getPresetCount();
            for (int i = 0; i < pc; i++) {
                MediaPlayer.Equalizer p = MediaPlayer.Equalizer.createFromPreset(i);
                try {
                    JSObject o = new JSObject();
                    o.put("name", MediaPlayer.Equalizer.getPresetName(i));
                    o.put("preamp", (double) p.getPreAmp());
                    JSArray amps = new JSArray();
                    for (int b = 0; b < bc; b++) amps.put(Double.valueOf(p.getAmp(b)));
                    o.put("amps", amps);
                    presets.put(o);
                } catch (Throwable ignored) {
                    // 1 件の取得に失敗しても他のプリセットは続ける（Equalizer に release() は無い）
                }
            }
            out.put("ok", true);
            out.put("bands", bc);
            out.put("freqs", freqs);
            out.put("presets", presets);
        } catch (Throwable t) {
            out.put("ok", false);
            out.put("error", String.valueOf(t.getMessage()));
        }
        call.resolve(out);
    }

    /** イコライザーの ON/OFF・プリアンプ・各バンドの dB 値を設定する */
    @PluginMethod
    public void vlcEqSet(final PluginCall call) {
        try {
            if (call.hasOption("enabled")) eqEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            if (call.hasOption("preamp")) eqPreamp = clampDb(call.getDouble("preamp", 0.0));
            JSArray arr = call.getArray("bands");
            if (arr != null) {
                float[] nb = new float[Math.max(arr.length(), 10)];
                for (int i = 0; i < arr.length(); i++) nb[i] = clampDb(arr.optDouble(i, 0.0));
                eqBands = nb;
            }
        } catch (Throwable ignored) {
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                applyEqualizer();
                call.resolve();
            }
        });
    }


    // ───────────────────────── コンプレッサー（libVLC の音声フィルター compressor） ─────────────────────────
    // 再生中に値を変える API が無いため、メディアのオプション(:audio-filter=compressor など)として渡し、
    // 設定が変わったら reloadMedia() で同じ位置・同じ再生状態のまま開き直す（音が 0.5〜1 秒途切れる）。
    private boolean compEnabled = false;
    private double cThreshold = -20, cRatio = 4, cAttack = 20, cRelease = 250, cKnee = 4, cMakeup = 6, cRmsPeak = 0.2;
    private int compRetry = 0;

    private static double clampD(double v, double lo, double hi, double def) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return def;
        return Math.max(lo, Math.min(hi, v));
    }

    /** 新しく開く Media にコンプレッサーの設定を付ける（オフなら何も付けない） */
    private void applyCompOptions(Media m) {
        if (!compEnabled || m == null) return;
        try {
            m.addOption(":audio-filter=compressor");
            m.addOption(":compressor-rms-peak=" + String.format(java.util.Locale.US, "%.2f", cRmsPeak));
            m.addOption(":compressor-attack=" + String.format(java.util.Locale.US, "%.1f", cAttack));
            m.addOption(":compressor-release=" + String.format(java.util.Locale.US, "%.1f", cRelease));
            m.addOption(":compressor-threshold=" + String.format(java.util.Locale.US, "%.1f", cThreshold));
            m.addOption(":compressor-ratio=" + String.format(java.util.Locale.US, "%.1f", cRatio));
            m.addOption(":compressor-knee=" + String.format(java.util.Locale.US, "%.1f", cKnee));
            m.addOption(":compressor-makeup-gain=" + String.format(java.util.Locale.US, "%.1f", cMakeup));
        } catch (Throwable ignored) {
        }
    }

    /** 設定を反映するために開き直す。映像復帰などの開き直しの最中なら、終わるまで待って再試行する */
    private void reopenForComp() {
        if (vlc == null || libVLC == null || mediaUriStr == null || ended) return;   // 動画が開かれていなければ次回の再生から効く
        if (reloading && compRetry < 8) {
            compRetry++;
            main.postDelayed(new Runnable() {
                @Override public void run() { reopenForComp(); }
            }, 700);
            return;
        }
        compRetry = 0;
        reloadMedia();
    }

    @PluginMethod
    public void vlcCompSet(final PluginCall call) {
        boolean oldEn = compEnabled;
        double o1 = cThreshold, o2 = cRatio, o3 = cAttack, o4 = cRelease, o5 = cKnee, o6 = cMakeup, o7 = cRmsPeak;
        try {
            if (call.hasOption("enabled")) compEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            if (call.hasOption("threshold")) cThreshold = clampD(call.getDouble("threshold", -20.0), -30, 0, -20);
            if (call.hasOption("ratio"))     cRatio     = clampD(call.getDouble("ratio", 4.0), 1, 20, 4);
            if (call.hasOption("attack"))    cAttack    = clampD(call.getDouble("attack", 20.0), 2, 400, 20);
            if (call.hasOption("release"))   cRelease   = clampD(call.getDouble("release", 250.0), 10, 800, 250);
            if (call.hasOption("knee"))      cKnee      = clampD(call.getDouble("knee", 4.0), 1, 10, 4);
            if (call.hasOption("makeup"))    cMakeup    = clampD(call.getDouble("makeup", 6.0), 0, 24, 6);
            if (call.hasOption("rmsPeak"))   cRmsPeak   = clampD(call.getDouble("rmsPeak", 0.2), 0, 1, 0.2);
        } catch (Throwable ignored) {
        }
        // オフのままパラメータだけ変わった場合は、開き直す必要は無い
        final boolean changed = compEnabled != oldEn
                || (compEnabled && (o1 != cThreshold || o2 != cRatio || o3 != cAttack || o4 != cRelease
                                    || o5 != cKnee || o6 != cMakeup || o7 != cRmsPeak));
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (changed) reopenForComp();
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void vlcStop(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    stopTicker();
                    if (vlc != null) vlc.stop();
                    if (clipBox != null) clipBox.setVisibility(View.GONE);
                    hideMedia();
                } catch (Throwable ignored) {
                }
                call.resolve();
            }
        });
    }

    // ───────────────────────── MainActivity から呼ばれる ─────────────────────────

    /** ホーム/履歴ボタンなどでアプリを離れるとき（Android 11 以前は手動で小窓へ。12 以降は自動開始設定で行う） */
    public void onUserLeaveHint() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && autoPip && playing) {
            Activity activity = getActivity();
            if (pipSupported(activity)) {
                try {
                    activity.enterPictureInPictureMode(buildPipParams(activity));
                } catch (Exception ignored) {
                }
            }
        }
    }

    /** 小窓の開始/終了。dismissed=true は小窓の × で閉じられたとき */
    public void onPipModeChanged(boolean active, boolean dismissed) {
        JSObject d = new JSObject();
        d.put("active", active);
        d.put("dismissed", dismissed);
        notifyListeners("pipChanged", d);
    }

    // ───────────────────────── 内部処理 ─────────────────────────

    private boolean pipSupported(Activity activity) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && activity != null
            && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private void updatePipParams(Activity activity) {
        if (!pipSupported(activity)) return;
        try {
            activity.setPictureInPictureParams(buildPipParams(activity));
        } catch (Exception ignored) {
        }
    }

    private PictureInPictureParams buildPipParams(Activity activity) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
        builder.setAspectRatio(pipRatio());
        builder.setActions(buildPipActions(activity));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12 以降: 再生中なら、ホームに戻る操作で自動的に小窓へ移行
            builder.setAutoEnterEnabled(autoPip && playing);
        }
        return builder.build();
    }

    /** PiP が受け付ける縦横比は 1:2.39 〜 2.39:1 の範囲 */
    private Rational pipRatio() {
        int w = videoW, h = videoH;
        double r = (double) w / (double) h;
        if (r > 2.39) return new Rational(239, 100);
        if (r < 1.0 / 2.39) return new Rational(100, 239);
        return new Rational(w, h);
    }

    /** 小窓に表示する「再生/一時停止」ボタン */
    private List<RemoteAction> buildPipActions(Activity activity) {
        List<RemoteAction> actions = new ArrayList<>();
        Intent intent = new Intent(actionToggle).setPackage(activity.getPackageName());
        PendingIntent pending = PendingIntent.getBroadcast(
            activity, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        int iconRes = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String title = playing ? "一時停止" : "再生";
        actions.add(new RemoteAction(Icon.createWithResource(activity, iconRes), title, title, pending));
        return actions;
    }
}
