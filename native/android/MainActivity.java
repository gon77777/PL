package __APP_ID__;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;

import androidx.lifecycle.Lifecycle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * Capacitor 標準の MainActivity に、小窓再生（PiP）用のフックを追加したもの。
 * このファイルは scripts/patch-android.js によって android/ 配下へコピーされる。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlayerPlugin.class); // super.onCreate より前に登録する
        super.onCreate(savedInstanceState);
        // 「このアプリで開く」で起動された場合（再生成時は二重に開かない）
        if (savedInstanceState == null) {
            NativePlayerPlugin.setPendingLaunchUri(NativePlayerPlugin.uriFromIntent(getIntent()));
        }
    }

    /** アプリが既に起動している状態で、別の動画を「このアプリで開く」で渡されたとき */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        android.net.Uri u = NativePlayerPlugin.uriFromIntent(intent);
        if (u == null) return;
        NativePlayerPlugin p = player();
        if (p != null) p.onOpenUri(u);
        else NativePlayerPlugin.setPendingLaunchUri(u);
    }

    private NativePlayerPlugin player() {
        if (getBridge() == null) return null;
        PluginHandle handle = getBridge().getPlugin("NativePlayer");
        return handle == null ? null : (NativePlayerPlugin) handle.getInstance();
    }

    /** ホーム / 履歴ボタンでアプリを離れるとき */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        NativePlayerPlugin p = player();
        if (p != null) p.onUserLeaveHint();
    }

    /** 小窓（PiP）の開始 / 終了 */
    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        // 小窓の × で閉じられた場合、この時点の Lifecycle は CREATED（STARTED 以上なら「拡大して戻った」）
        boolean dismissed = !isInPictureInPictureMode
            && getLifecycle().getCurrentState() == Lifecycle.State.CREATED;
        NativePlayerPlugin p = player();
        if (p != null) p.onPipModeChanged(isInPictureInPictureMode, dismissed);
    }
}
