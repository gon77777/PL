package __APP_ID__;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 再生中の通知（メディア通知）を前面サービスとして保持する。
 * アプリが画面から見えなくなっても（画面ロック中も）音声の再生を止めないために必要。
 * 通知の中身・ボタン・MediaSession は NativePlayerPlugin が作り、ここへ渡す。
 *
 * このファイルは scripts/patch-android.js によって android/ 配下へコピーされる。
 */
public class PlaybackService extends Service {

    static final int NOTIFICATION_ID = 7001;
    private static volatile Notification pending;
    private static volatile PlaybackService instance;

    /** 通知を表示 / 更新する。foreground=true（再生中）なら前面サービスにして強制終了を防ぐ */
    static void show(Context ctx, Notification n, boolean foreground) {
        pending = n;
        PlaybackService s = instance;
        try {
            if (foreground) {
                if (s == null) {
                    Intent i = new Intent(ctx, PlaybackService.class);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
                    else ctx.startService(i);
                } else {
                    s.enterForeground(n);
                }
            } else if (s != null) {
                s.stopForeground(false);          // 通知は残したまま前面サービスを解除（スワイプで消せる）
                nm(ctx).notify(NOTIFICATION_ID, n);
            } else {
                nm(ctx).notify(NOTIFICATION_ID, n);
            }
        } catch (Exception ignored) {
            // バックグラウンドからの前面サービス開始が拒否された場合は、通知だけ更新する
            try { nm(ctx).notify(NOTIFICATION_ID, n); } catch (Exception ignored2) { }
        }
    }

    /** 通知とサービスを止める */
    static void hide(Context ctx) {
        pending = null;
        PlaybackService s = instance;
        try {
            if (s != null) {
                s.stopForeground(true);
                s.stopSelf();
            }
            nm(ctx).cancel(NOTIFICATION_ID);
        } catch (Exception ignored) {
        }
    }

    private static NotificationManager nm(Context ctx) {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private void enterForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        Notification n = pending;
        if (n == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            enterForeground(n);
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
