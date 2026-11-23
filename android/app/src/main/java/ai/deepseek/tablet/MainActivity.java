package ai.deepseek.tablet;

import android.Manifest;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.Interceptor;
import okhttp3.OkHttpClient;

/**
 * WebView 原生壳。
 *
 * <p>启动顺序：背景线程起本地服务器 → 拿到真实端口 → 主线程 loadUrl。
 * 服务器起不来则显示原生错误页（提示端口占用），不会白屏。
 */
public final class MainActivity extends AppCompatActivity {

    private static final String TAG = "DeepSeekTablet";
    private static final int REQ_FILE_CHOOSER = 4711;
    /** 申请 POST_NOTIFICATIONS 的 requestCode（与 KeepAliveHandler 的 4713 刻意错开） */
    private static final int REQ_POST_NOTIFICATIONS = 4712;
    private static final int REQ_RECORD_AUDIO = 4714;
    private static final String LOOPBACK_HOST = "127.0.0.1";

    /**
     * 附件上传的「来源记忆」（A 段）。
     *
     * <p>用户第一次点「+」时弹原生面板让他选来源（系统文件 / MT 管理器 / 其他应用），
     * 选完记在这里；之后直接走上次那个来源，不再每次问。想换来源就长按「+」
     * （页面通过 {@link PickerBridge#reset()} 清掉记忆，见那边的注释）。
     */
    private static final String PREFS_PICKER = "dsp.picker.v1";
    private static final String KEY_PICKER_SOURCE = "source";
    /** 系统文件：`ACTION_OPEN_DOCUMENT`（SAF），可多选，始终可用 */
    private static final String SOURCE_SYSTEM = "system";
    /** MT 管理器：`ACTION_GET_CONTENT` + `setPackage("bin.mt.plus")`，解析不到就不跳 */
    private static final String SOURCE_MT = "mt";
    /** 其他应用：`createChooser(ACTION_GET_CONTENT)`，让系统列出所有能选文件的应用 */
    private static final String SOURCE_CHOOSER = "chooser";
    /** MT 管理器的包名（官方版；共存版是 bin.mt.plus.canary，不在本次范围） */
    private static final String MT_PACKAGE = "bin.mt.plus";

    /**
     * 等窗口拿到焦点再弹权限框的节奏。
     *
     * <p>为什么必须等：{@code requestPermissions} 在 Activity 还没真正可见/获得焦点时调用，
     * 一部分 ROM 会<b>静默丢掉</b>这次请求（不弹框、也不回调），调用方却以为已经问过了 ——
     * 这正是用户反馈的「通知权限根本没有请求」。所以这里轮询窗口焦点，最多等
     * {@code 5 × 350ms ≈ 1.75s}，等不到就放弃（不落盘「问过」，下次 onResume 还有机会）。
     */
    private static final int NOTIFY_ASK_MAX_ATTEMPTS = 5;
    private static final long NOTIFY_ASK_INTERVAL_MS = 350L;

    private static final int COLOR_BACKGROUND = 0xFF0F1115;
    /** 浅色主题时的窗口底色，与网页 --dsw-alias-bg-base 对齐 */
    private static final int COLOR_BACKGROUND_LIGHT = 0xFFFFFFFF;
    private static final int COLOR_TEXT = 0xFFE7E9EC;

    private static final long ACTIVITY_RESTART_DELAY_MS = 600L;

    /* ── 渲染进程回收后的恢复节奏（S1） ───────────────────────────────────
     * 「切出去再回来就整页重来」的根因是：渲染进程在后台被回收之后，回前台一律 recreate()。
     * 现在分三档，前两档都**不动 Activity**，只有真的崩溃循环才重建（见 handleRendererLoss）。 */

    /**
     * 失败窗口：这段时间内连续丢渲染进程才算「崩溃循环」。
     *
     * <p>为什么需要窗口：单次回收（内存压力）在国产 ROM 上极常见，一失败就重建 Activity 等于
     * 把用户刚回来的那一屏直接扔掉；而「加载完立刻又死」才是真的坏了，那种必须升级。
     */
    private static final long RENDERER_FAILURE_WINDOW_MS = 60_000L;
    /** 窗口内允许的**就地**恢复次数；超过就重建 Activity（页面自己能稳住才是常态） */
    private static final int MAX_IN_PLACE_RECOVERY = 2;
    /**
     * 页面加载完成后多久算「这一次真的活着」。
     *
     * <p>必须在「加载完成」之后再等一段：只看 {@code onPageFinished} 会把「加载完就死」也当成
     * 恢复成功，于是崩溃循环永远升级不了（无限重新加载）。活到这个点才清零失败计数。
     */
    private static final long RENDERER_HEALTHY_AFTER_MS = 15_000L;
    /** 页面 UI 状态中转箱的容量上限（一次快照 JSON 的字节数；草稿本来就限 8 KB/条） */
    private static final int UI_RELAY_MAX_CHARS = 64 * 1024;

    /** 出站必须是 https：初始 URL 在 ProxyHandler 里已校验，这里兜住重定向到 http 的情况。 */
    private static final Interceptor HTTPS_ONLY_INTERCEPTOR = chain -> {
        String scheme = chain.request().url().scheme();
        if (!"https".equalsIgnoreCase(scheme)) {
            throw new IOException("只允许 https 上游请求，实际是 " + scheme);
        }
        return chain.proceed(chain.request());
    };

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private FrameLayout rootLayout;
    private RemoteDshWebView remoteDshWeb;
    private WebView webView;
    private TextView errorView;
    private LocalServer server;
    private OkHttpClient httpClient;

    private ValueCallback<Uri[]> filePathCallback;
    /**
     * 来源面板是**异步**的：`AlertDialog` 弹出来时 `onShowFileChooser` 已经返回，
     * 所以参数得拍成快照，等用户点完面板还能按原来的 accept / 多选设置拼 Intent。
     */
    private String[] pendingAcceptTypes;
    private boolean pendingMultiple;
    private String loadedUrl;
    private PermissionRequest pendingMicRequest;
    private boolean renderProcessRestartScheduled;
    /** 当前 WebView 的底色（跟着网页主题走；WebView 就地重建时用它，避免闪一下深色） */
    private int surfaceColor = COLOR_BACKGROUND;
    /**
     * 应用是否可见。后台时绝不做任何会把界面拉回前台的操作——
     * 系统在后台回收 WebView 渲染进程非常常见，若此时重建 Activity 就会「自己跳出来」。
     */
    private boolean appVisible;

    /* ── 渲染进程丢失后的恢复状态（S1） ───────────────────────────────────
     * 以前只有一个 `rendererNeedsRebuild`：只要在后台丢过渲染进程，回前台就 recreate()
     * 整个 Activity —— 而 onDestroy 会 stop() 本地服务器（连带拆 WS 隧道、停掉保活前台服务），
     * 再走一遍 startServerAsync + loadUrl。用户看到的就是「切出去一下回来整页重来」。
     * 现在拆成「待恢复 / 已连续失败」两个标记，配合就地重建 WebView（见 rebuildWebViewInPlace）。 */

    /** 后台期间渲染进程丢过，等用户回来再恢复（**不再**一回来就 recreate） */
    private boolean rendererRecoveryPending;
    /** 待恢复时直接升级成「重建 Activity」：连续失败已经发生过了 */
    private boolean rendererRecoveryEscalate;
    /** 当前失败窗口内已经就地恢复过几次 */
    private int rendererRecoveryFailures;
    /** 失败窗口起点（`SystemClock.uptimeMillis()`；0 = 没有正在观察的失败） */
    private long rendererFailureWindowStart;
    /**
     * 页面 UI 状态中转箱（S1）。
     *
     * <p>**必须是 Activity 上的同一个实例**：WebView 就地重建时 {@link #configureWebView()}
     * 会重新注册一次 JS 桥，如果每次都 new 一个，刚存进去的那份快照就跟着旧实例一起丢了
     * （这正是「草稿恢复不了」的坑）。
     */
    private final UiStateRelay uiStateRelay = new UiStateRelay();

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate");
        /*
         * [R14 通知直达] 进程被杀之后用户点通知，系统是**新建**这个 Activity 并把那条
         * PendingIntent 当启动 intent 送进来 —— 所以冷启动这条路必须也读一次 getIntent()。
         * 必须在 startServerAsync() 之前：页面一起来就会 GET /__ds_notify/open.json，
         * 晚一步读就等于这次直达丢了。
         */
        captureNotifyIntent(getIntent());
        configureWindow();
        buildContentView();
        configureWebView();
        configureBackNavigation();
        startServerAsync();
    }

    // ---------------------------------------------------------------- 窗口 / 视图

    private void configureWindow() {
        Window window = getWindow();
        // 让页面延伸到状态栏/导航栏下面，inset 交给网页自己处理
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setBackgroundDrawable(new ColorDrawable(COLOR_BACKGROUND));
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        window.setNavigationBarDividerColor(Color.TRANSPARENT);
        applySystemBarAppearance(true);
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        window.setAttributes(attributes);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    /**
     * 让系统栏图标跟随网页主题：深色页面用浅色图标，浅色页面用深色图标。
     * 同时把窗口/WebView 底色一起换掉，避免切到浅色时加载过程闪一下黑。
     */
    private void applySystemBarAppearance(boolean dark) {
        Window window = getWindow();
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
        }
        int background = dark ? COLOR_BACKGROUND : COLOR_BACKGROUND_LIGHT;
        surfaceColor = background;
        window.setBackgroundDrawable(new ColorDrawable(background));
        if (rootLayout != null) {
            rootLayout.setBackgroundColor(background);
        }
        if (webView != null) {
            webView.setBackgroundColor(background);
        }
    }

    /** 网页通过 window.DSNative.setDark(...) 通知原生切换系统栏 */
    public class ThemeBridge {
        @android.webkit.JavascriptInterface
        public void setDark(final boolean dark) {
            runOnUiThread(() -> applySystemBarAppearance(dark));
        }
    }

    @Override
    protected void onPause() {
        // 先标记不可见：渲染进程若在这一刻被回收，也不该把界面拉回来
        appVisible = false;
        super.onPause();
        if (webView != null) {
            // 页面进入后台后停掉定时器与合成，后台 CPU / 内存占用明显下降。
            // 但远程 DSH 的心跳跑在页面 JS 里：一旦冻结定时器，25s 的 ping 就断，
            // 服务端 75 秒把连接踢掉 —— 用户切到系统浏览器授权、再切回来就只剩「已断开」。
            // 所以保活服务在跑的时候不能停定时器（此时进程已被前台服务保活，不会白耗）。
            webView.onPause();
            if (!RemoteKeepAliveService.shouldRun(this)) {
                webView.pauseTimers();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        appVisible = true;
        // 每次真的回到前台都检查一次：通知权限（13+，只问一次）与后台保活自愈。
        // 放在这个位置（早于下面渲染进程恢复的提前 return）才能保证恢复路径也走到。
        requestNotificationPermissionOnce();
        restoreKeepAliveIfNeeded();
        if (rendererRecoveryPending) {
            /*
             * 后台丢过渲染进程，用户现在回来了：**只重建 WebView**，不重建 Activity。
             *
             * 为什么不是 recreate()：Activity 重建会把本地服务器、WS 隧道、保活前台服务
             * 一起拆掉（onDestroy），再整页加载一遍。而用户真正在意的是「回来的还是原来那一屏」。
             * 换一个 WebView 只丢页面本身，服务器端口不变 → origin 不变 → 缓存照样直出，
             * 页面还能从原生中转箱（DSNativeUi）里把草稿 / 滚动位置捞回来。
             */
            rendererRecoveryPending = false;
            boolean escalated = rendererRecoveryEscalate;
            rendererRecoveryEscalate = false;
            if (!escalated && rebuildWebViewInPlace()) {
                Log.i(TAG, "renderer recovery on resume: WebView rebuilt in place (no activity recreate)");
            } else {
                // 连续失败 / 连 WebView 都造不出来：这时重建 Activity 才是合理的
                renderProcessRestartScheduled = false;
                Log.i(TAG, "renderer recovery on resume: escalating to activity recreate");
                mainHandler.post(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        recreate();
                    }
                });
                return;
            }
        }
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
    }

    // ---------------------------------------------------------------- 通知直达（R14）

    /**
     * 点通知带进来的会话 id 的**进程内信箱**（页面通过 `GET /__ds_notify/open.json` 取走）。
     *
     * <p>为什么用静态字段：{@link LocalServer}（以及它的 {@link RemoteNotifyHandler}）拿到的
     * 只有 Application context，拿不到 Activity；而「刚刚点了哪条通知」这件事本身就属于
     * <b>进程</b>而不是某个 Activity 实例。Activity 因渲染进程回收重建时，这份信箱也不会丢。
     *
     * <p>为什么不落 SharedPreferences：这是一次性的**投递**，不是设置。落盘会带来两个新问题 ——
     * 「取走之后崩溃，重启又弹一遍」以及「清不干净的老 id」。进程死掉时语义就是「这次直达没了」，
     * 用户再点一次通知即可（这也是系统通知的正常心智）。
     */
    private static final Object PENDING_SESSION_LOCK = new Object();
    /** 待页面取走的会话 id（`null` = 没有）。只在锁内读写。 */
    private static String pendingSessionId;
    /** 累计投递次数：诊断 + 前端判断「是不是新的一次」。只在锁内自增。 */
    private static int pendingSessionRev;

    /**
     * 通知点进来时走这里：Activity 已在栈顶（`FLAG_ACTIVITY_SINGLE_TOP`），**不会**重建。
     *
     * <p>三条纪律：
     * <ol>
     *   <li>先收下会话 id，再把 `getIntent()` 换成一个干净的 Intent —— 系统在 Activity 重建时
     *       会把 ActivityRecord 里那份**原始** intent 再交回来一次，不抹掉就等于同一条通知投递两遍；</li>
     *   <li>App 此刻已经在前台：页面收不到 `visibilitychange`，所以必须由原生**推一下**
     *       （{@link #notifyPageDeepLink()}），否则用户点了通知却什么都不会发生；</li>
     *   <li>整个过程不碰 WebView 的生命周期，不重建、不重载页面。</li>
     * </ol>
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Log.i(TAG, "onNewIntent");
        boolean captured = captureNotifyIntent(intent);
        setIntent(cleanIntent());
        if (captured) {
            notifyPageDeepLink();
        }
    }

    /**
     * 从 intent 里取出会话 id 放进信箱。
     *
     * @return true = 这次真的带来了一个**新的**会话 id（调用方据此决定要不要推事件）
     */
    private boolean captureNotifyIntent(@Nullable Intent intent) {
        if (intent == null) {
            return false;
        }
        String raw;
        try {
            // 键名只在 RemoteNotifyHandler 里定义一次（那边发通知时 putExtra 用的就是它）
            raw = intent.getStringExtra(RemoteNotifyHandler.EXTRA_SESSION_ID);
        } catch (RuntimeException broken) {
            Log.w(TAG, "读通知 extra 失败", broken);
            return false;
        }
        if (raw == null) {
            // 普通启动 / 汇总通知（不带会话）：不是直达，什么都不做
            return false;
        }
        final String sessionId = raw.trim();
        if (sessionId.isEmpty()) {
            return false;
        }
        int rev;
        synchronized (PENDING_SESSION_LOCK) {
            pendingSessionId = sessionId;
            pendingSessionRev++;
            rev = pendingSessionRev;
        }
        Log.i(TAG, "通知直达：收到会话 " + maskSessionId(sessionId) + "（第 " + rev + " 次投递）");
        // 收下即抹掉 extra：重建时系统交回的是原始 intent，不能让同一条通知再投一遍
        setIntent(cleanIntent());
        return true;
    }

    /**
     * 取走待处理的会话 id，**读后清空**。
     *
     * <p>清空是幂等的关键：页面在「启动 + 每次回到前台」都会拉一次这个接口，如果不清，
     * 一次点通知会让用户被反复拽回同一个会话（他刚切走就被拽回来）。清空之后第二次读返回空串。
     *
     * @return 没有待处理时返回空串，永不为 null（调用方不用判空）
     */
    static String consumePendingSessionId() {
        synchronized (PENDING_SESSION_LOCK) {
            String value = pendingSessionId;
            pendingSessionId = null;
            return value == null ? "" : value;
        }
    }

    /** 累计投递次数（诊断用；只读，不清）。 */
    static int pendingSessionRev() {
        synchronized (PENDING_SESSION_LOCK) {
            return pendingSessionRev;
        }
    }

    /** 一个不含任何 extra 的空 intent：抹掉已经处理过的 deep link，防止重建时重复投递。 */
    private Intent cleanIntent() {
        return new Intent(this, MainActivity.class);
    }

    /** 日志里只留 id 前缀：会话 id 本身不该整段进 logcat。 */
    private static String maskSessionId(String sessionId) {
        if (sessionId.length() <= 8) {
            return sessionId;
        }
        return sessionId.substring(0, 8) + "…";
    }

    /**
     * 告诉页面「有新的 deep link 了，去 `/__ds_notify/open.json` 取」。
     *
     * <p>为什么需要它：App 已经在前台时点通知**不会**触发 `visibilitychange`，页面那两次
     * （启动 + 回前台）轮询都赶不上。这里只发一个空事件，取数据和「会话在不在」全由
     * `services/remote/deepLink.ts` 判定 —— 原生不多知道一件业务上的事。
     *
     * <p>页面还没加载完成时注入会失败（没有监听者），这是可接受的一类失败：
     * 那种情况下页面的**启动轮询**会自己把同一个 id 取走。
     */
    private void notifyPageDeepLink() {
        WebView view = webView;
        if (view == null) {
            return;
        }
        String script = "(function(){try{window.dispatchEvent(new Event('ds:deeplink'));}catch(e){}})()";
        try {
            view.evaluateJavascript(script, null);
        } catch (RuntimeException broken) {
            Log.d(TAG, "投递 deep link 事件失败（页面未就绪时由启动轮询兜住）", broken);
        }
    }

    // ---------------------------------------------------------------- 后台保活 / 通知权限

    /**
     * Android 13+ 的运行时通知权限（{@code POST_NOTIFICATIONS}）。
     *
     * <p>没有它，后台保活的前台服务照样跑，只是那条「Chat Pad 正在保持远程连接」的常驻通知
     * 不显示 —— 用户看不到后台有东西在跑，就会觉得「怎么偷偷跑了」。所以能要就要一次。
     *
     * <p><b>这里才是真正发起申请的地方</b>（R3 修正）。以前 {@code KeepAliveHandler} 在页面
     * 连上时也试过一次，但那个时机经常没有窗口焦点，请求会被 ROM 吃掉；而「问过没问过」的标志
     * 又先落了盘，于是本安装再也不会问 —— 用户看到的正是「根本没有请求，却显示已设置成功」。
     * 现在：
     * <ul>
     *   <li>发起处只有这里（onResume），以及页面点按钮时 {@code KeepAliveHandler.requestNotificationNow}</li>
     *   <li>判定「能不能看到通知」用 {@link KeepAliveHandler#isNotificationVisible(Context)}，
     *       它把 33+ 权限 / 总开关 / 渠道三层都算进来（Android 9 上也不会假报成功）</li>
     *   <li>「装一次只问一次」的标志落在 {@link KeepAliveHandler#hasAskedNotificationPermission}
     *       里（跨进程有效，且和页面按钮共用同一个闸门）</li>
     *   <li>只有真的把 requestPermissions 调出去了才记「问过」</li>
     * </ul>
     *
     * <p>只用框架 API：{@code Activity.requestPermissions(int, String[], int)} 自 API 23 起就有，
     * 不必引入 androidx 的 ActivityCompat。
     *
     * <p><b>为什么这里不用 {@code shouldShowRequestPermissionRationale} 当闸门</b>：它返回 false
     * 有两种完全相反的含义 —— 「从没问过」和「拒绝且不再询问」。拿它挡第一次申请会把正常路径
     * 一起挡掉（首次启动永远弹不出来）。所以闸门只用 {@link KeepAliveHandler#hasAskedNotificationPermission}
     * 这一份「我们自己问过没有」的记录，rationale 留给页面的 {@code canRequest} 去解释。
     */
    private void requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // 12 及以下没有这个运行时权限：通知开关只在系统设置里
            return;
        }
        if (KeepAliveHandler.isNotificationPermissionGranted(this)) {
            // 权限本身已经授予：这时看不到通知只可能是总开关/渠道被关，弹框没有任何用
            return;
        }
        if (KeepAliveHandler.hasAskedNotificationPermission(this)) {
            // 装一次只问一次：问过之后（哪怕被拒）不再弹，页面会如实显示「未开启 + 去设置」
            return;
        }
        scheduleNotificationPermissionRequest(0);
    }

    /**
     * 等窗口有焦点再弹（最多 {@link #NOTIFY_ASK_MAX_ATTEMPTS} 次）。
     *
     * <p>用 {@code mainHandler.postDelayed} 而不是 {@code Window.getDecorView().post}：
     * 后者在窗口还没 attach 时会直接丢掉任务，而这里需要「等一会儿再试」的语义。
     *
     * <p><b>为什么「没焦点就不申请、也不落盘」</b>：没焦点时 {@code requestPermissions} 在多数
     * ROM 上会静默丢掉（不弹框、也不回调）。此时如果顺手记下「问过了」，本安装就再也不会问 ——
     * 这正好复现了用户反馈的「根本没有请求，却显示已经设置成功」。所以宁可这次不申请，
     * 让下一次 onResume（用户切走再回来）再试。
     */
    private void scheduleNotificationPermissionRequest(final int attempt) {
        if (attempt > NOTIFY_ASK_MAX_ATTEMPTS) {
            Log.i(TAG, "等不到窗口焦点，这次不申请通知权限（下次 onResume 再试）");
            return;
        }
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                if (!hasWindowFocus()) {
                    if (attempt < NOTIFY_ASK_MAX_ATTEMPTS) {
                        scheduleNotificationPermissionRequest(attempt + 1);
                    } else {
                        // 一直没焦点（例如被系统弹窗压着）：放弃本次，**不落盘**
                        Log.i(TAG, "等不到窗口焦点，这次不申请通知权限");
                    }
                    return;
                }
                askNotificationPermissionNow();
            }
        }, attempt == 0 ? 0L : NOTIFY_ASK_INTERVAL_MS);
    }

    /**
     * 真的把系统权限框弹出去。
     *
     * <p>顺序讲究：<b>先调用、成功了才落盘</b>。反过来的话，万一这次调用被 ROM 吃掉，
     * 本安装就再也不会问了 —— 那正是「根本没有请求，却显示已经设置成功」的另一半成因。
     */
    private void askNotificationPermissionNow() {
        if (KeepAliveHandler.hasAskedNotificationPermission(this)) {
            return;
        }
        if (KeepAliveHandler.isNotificationVisible(this)) {
            return;
        }
        boolean posted = false;
        try {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    REQ_POST_NOTIFICATIONS);
            posted = true;
            Log.i(TAG, "已发出 POST_NOTIFICATIONS 申请");
        } catch (RuntimeException failed) {
            // 个别 ROM 在窗口还没拿到焦点时会抛；失败就算了，不落盘，下次再试
            Log.w(TAG, "request POST_NOTIFICATIONS failed", failed);
        }
        if (posted) {
            KeepAliveHandler.markNotificationPermissionAsked(this);
        }
    }

    /**
     * 权限框的结果：只有它才能真正说明「用户点了什么」。
     *
     * <p>以前这个回调根本没实现，结果被系统静默丢弃，日志里什么都看不到 —— 真机排障时
     * 「到底弹没弹、用户点了什么」全靠猜。现在至少留一条明确日志，并在授予后立刻把常驻通知
     * 重建一遍（没权限期间 startForeground 挂上去的那条通知，授予后未必会自己刷新出来）。
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO) {
            PermissionRequest request = pendingMicRequest;
            pendingMicRequest = null;
            if (request != null) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        && isTrustedMicrophoneRequest(request)) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
            return;
        }
        if (requestCode != REQ_POST_NOTIFICATIONS) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, "POST_NOTIFICATIONS result: granted=" + granted);
        if (granted) {
            // 有权限了：把「正在保持远程连接 · N 个任务」那条通知立刻刷出来
            RemoteKeepAliveService.refreshResident(getApplicationContext());
        }
    }

    /**
     * 保活自愈：页面要求过保活（标志落盘在 {@link RemoteKeepAliveService}），但服务此刻没跑，
     * 就在前台补一次 {@code startForegroundService}。
     *
     * <p>为什么必须在前台补：Android 12+ 从后台启动前台服务会被系统直接拒
     * （{@code ForegroundServiceStartNotAllowedException}）。onResume 是「应用确实在前台」
     * 的唯一可靠信号，在这里补成功率最高，也不会出现「后台偷偷拉起界面」的副作用。
     *
     * <p>这里只起服务，绝不重建 Activity、也绝不在 onTrimMemory 之类的低内存回调里做任何
     * 重启界面的动作 —— 后台被回收时把界面拉回来，用户会觉得应用自己在跳。
     */
    private void restoreKeepAliveIfNeeded() {
        if (RemoteKeepAliveService.isRunning()) {
            return;
        }
        if (!RemoteKeepAliveService.shouldRun(this)) {
            return;
        }
        Log.i(TAG, "keep-alive missing but requested before, starting foreground service again");
        // start() 自己吞异常并在系统拒绝时返回 false，这里不需要再兜
        RemoteKeepAliveService.start(getApplicationContext());
    }

    private void buildContentView() {
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(COLOR_BACKGROUND);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = newShellWebView();
        rootLayout.addView(webView);

        errorView = new TextView(this);
        errorView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        errorView.setGravity(Gravity.CENTER);
        errorView.setTextColor(COLOR_TEXT);
        errorView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        int padding = dp(28);
        errorView.setPadding(padding, padding, padding, padding);
        errorView.setVisibility(View.GONE);
        errorView.setClickable(true);
        errorView.setOnClickListener(view -> {
            if (errorView != null) {
                errorView.setVisibility(View.GONE);
            }
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
            }
            if (server != null && loadedUrl != null && webView != null) {
                // 服务器还在（例如资源缺失或渲染进程重建过），直接重新加载
                webView.loadUrl(loadedUrl);
                return;
            }
            startServerAsync();
        });
        rootLayout.addView(errorView);

        // 沉浸式状态栏：页面内容一直铺到状态栏底下（背景色由网页自己画），
        // 顶部那条栏靠 --ds-safe-top 自己下移，所以这里不再给顶部留内边距。
        // Android WebView 里 env(safe-area-inset-top) 恒为 0，只能由壳把高度写进 CSS 变量。
        // 底部仍然兜住键盘与导航栏，否则输入框会被挡住。
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            int top = bars.top;
            int bottom = Math.max(bars.bottom, ime.bottom);
            view.setPadding(0, 0, 0, bottom);
            publishSafeTop(top);
            return windowInsets;
        });

        setContentView(rootLayout);
    }

    /**
     * 造一个主 WebView（回调、JS 桥由 {@link #configureWebView()} 装，摆放位置由调用方决定）。
     *
     * <p>抽出来的唯一原因：渲染进程被回收后要**就地**换一个新的（见
     * {@link #rebuildWebViewInPlace()}），而那份配置必须和启动时逐字一致 —— 抄两遍迟早会漏。
     */
    private WebView newShellWebView() {
        WebView view = new WebView(this);
        view.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        view.setBackgroundColor(surfaceColor);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        return view;
    }

    /** 最近一次拿到的状态栏高度（**物理像素**，换算成 CSS px 由 publishSafeTop 负责）；
     *  页面加载完成时补发一次，避免页面晚于 inset 就绪。 */
    private int lastSafeTop = -1;

    /**
     * 把状态栏高度写进网页的 CSS 变量 --ds-safe-top。
     *
     * <p><b>单位必须换算。</b> {@link WindowInsetsCompat} 给的是**物理像素**（px），
     * 而 CSS 变量要的是 **CSS 像素**。页面用的是 {@code width=device-width,initial-scale=1}
     * + {@code setUseWideViewPort(true)}，所以 1 CSS px 恒等于 1 dp，
     * 换算就是除以 {@code displayMetrics.density}。
     *
     * <p>不除会怎样（2026-11-21 真机反馈的根因）：320dpi 的平板上 density=2，24dp 的状态栏
     * 被写成 {@code 48px}；480dpi 上 density=3，写成 {@code 72px}。前端把这份"CSS px"原样
     * 作为安全区，整条顶栏于是被多推下去 {@code 24×(density−1)} 像素 —— 就是用户说的
     * "最顶上这一整条挪得太下面了"。物理像素只在这里出现一次，出去必须是 CSS px。
     */
    private void publishSafeTop(int topPx) {
        lastSafeTop = topPx;
        if (webView == null) {
            return;
        }
        float density = getResources().getDisplayMetrics().density;
        int cssTop = density > 0f ? Math.round(topPx / density) : topPx;
        // 真机上 logcat 搜 "safe top" 就能看到「物理 / density / CSS」三个数，
        // 下次有人怀疑状态栏高度时不用再猜（本次根因就是这三个数没人核对过）。
        Log.i(TAG, "safe top: " + topPx + "px physical / density " + density + " -> " + cssTop + "px css");
        String script = "(function(){try{document.documentElement.style.setProperty("
                + "'--ds-safe-top','" + cssTop + "px');}catch(e){}})()";
        try {
            webView.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
            // 页面还没就绪时注入失败没关系，onPageFinished 会再发一次
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // 走 http://127.0.0.1，不需要 file:// 访问能力
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 页面据此判断自己运行在原生壳里，改为走本地代理而不是直连 API
        settings.setUserAgentString(
                settings.getUserAgentString() + " DeepSeekTablet/" + BuildConfig.VERSION_NAME);
        // 固定 100，别让系统字号/无障碍缩放把平板布局撑坏
        settings.setTextZoom(100);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setGeolocationEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 页面自带深色主题，禁止强制反色（targetSdk >= 33 时这个 API 是 no-op，下面还有新接口）
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // 不可见时把渲染进程降到最低优先级，是「后台内存高」最有效的一处开关
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        }
        webView.addJavascriptInterface(new ThemeBridge(), "DSNative");
        // 来源记忆的读/清（页面长按「+」时用 reset() 换来源，见 PickerBridge 注释）
        webView.addJavascriptInterface(new PickerBridge(), "DSNativePicker");
        // UI 状态中转箱（S1）：页面重载 / WebView 就地重建后，把草稿与滚动位置捞回来。
        // 只活在内存里，退出应用即消失（见 UiStateRelay 的注释）。
        webView.addJavascriptInterface(uiStateRelay, "DSNativeUi");
        remoteDshWeb = new RemoteDshWebView(this, webView, mainHandler);
        webView.addJavascriptInterface(remoteDshWeb, "DSNativeDshWeb");

        webView.setWebViewClient(new ShellWebViewClient());
        webView.setWebChromeClient(new ShellWebChromeClient());
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                // 交回系统默认行为，退出应用
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }

    // ---------------------------------------------------------------- 服务器启动

    private void startServerAsync() {
        final OkHttpClient client = ensureHttpClient();
        if (server != null) {
            server.stop();
            server = null;
        }
        final LocalServer started = new LocalServer(getApplicationContext(), client);
        server = started;
        Thread bootstrap = new Thread(() -> {
            try {
                int port = started.start();
                Log.i(TAG, "local server ready on " + LOOPBACK_HOST + ":" + port);
                boolean siteBundled = hasBundledSite();
                mainHandler.post(() -> onServerReady(started, port, siteBundled));
            } catch (Throwable error) {
                Log.e(TAG, "local server failed to start", error);
                mainHandler.post(() -> onServerFailed(started, error));
            }
        }, "ds-server-bootstrap");
        bootstrap.setDaemon(true);
        bootstrap.start();
    }

    private void onServerReady(LocalServer started, int port, boolean siteBundled) {
        if (isFinishing() || isDestroyed() || started != server) {
            return;
        }
        if (!siteBundled) {
            showError(getString(R.string.error_missing_assets));
            return;
        }
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
        if (webView == null) {
            return;
        }
        webView.setVisibility(View.VISIBLE);
        loadedUrl = "http://" + LOOPBACK_HOST + ":" + port + "/";
        Log.i(TAG, "loadUrl " + loadedUrl);
        webView.loadUrl(loadedUrl);
    }

    private void onServerFailed(LocalServer failed, Throwable error) {
        if (isFinishing() || isDestroyed() || failed != server) {
            return;
        }
        String detail = error.getMessage();
        if (detail == null || detail.isEmpty()) {
            detail = error.getClass().getSimpleName();
        }
        showError(getString(R.string.error_server_start, detail));
    }

    private void showError(String message) {
        if (webView != null) {
            webView.setVisibility(View.GONE);
        }
        if (errorView != null) {
            errorView.setText(message);
            errorView.setVisibility(View.VISIBLE);
        }
    }

    private OkHttpClient ensureHttpClient() {
        if (httpClient == null) {
            httpClient = new OkHttpClient.Builder()
                    .connectTimeout(20, TimeUnit.SECONDS)
                    .writeTimeout(120, TimeUnit.SECONDS)
                    // 0 = 不超时：SSE / 流式对话可能长时间没有新数据
                    .readTimeout(0, TimeUnit.SECONDS)
                    .callTimeout(0, TimeUnit.SECONDS)
                    .retryOnConnectionFailure(true)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .addNetworkInterceptor(HTTPS_ONLY_INTERCEPTOR)
                    .build();
        }
        return httpClient;
    }

    private boolean hasBundledSite() {
        try {
            String[] entries = getAssets().list("www");
            if (entries != null) {
                for (String entry : entries) {
                    if ("index.html".equals(entry)) {
                        return true;
                    }
                }
            }
        } catch (IOException listFailed) {
            Log.w(TAG, "cannot list assets/www", listFailed);
        }
        return false;
    }

    // ---------------------------------------------------------------- WebView 回调

    private final class ShellWebViewClient extends WebViewClient {

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            // 页面（重新）加载完成后补发一次状态栏高度：
            // WebView 重新加载后 documentElement 上的 CSS 变量会丢，不补发顶栏就会被状态栏压住
            if (lastSafeTop > 0) {
                publishSafeTop(lastSafeTop);
            }
            // 「加载完成」不等于「这一次真的活着」：见 markRendererHealthy 的注释
            mainHandler.removeCallbacks(markRendererHealthy);
            mainHandler.postDelayed(markRendererHealthy, RENDERER_HEALTHY_AFTER_MS);
            Log.i(TAG, "page finished: " + url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || !request.isForMainFrame()) {
                return false;
            }
            return openOrConsume(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return openOrConsume(url == null ? null : Uri.parse(url));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                WebResourceError error) {
            if (request != null && request.isForMainFrame() && error != null) {
                Log.w(TAG, "main frame error: " + error.getErrorCode() + " "
                        + error.getDescription() + " @ " + request.getUrl());
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail != null && detail.didCrash();
            /*
             * 两种情况必须分开（以前不分，这就是「切出去再回来就整页重来」的根因）：
             *   didCrash()=false：系统在回收内存，渲染进程被 kill —— 国产 ROM 切后台极常见；
             *   didCrash()=true ：页面自己崩了（渲染侧 native 崩溃 / OOM 打死）。
             * 两种都得销毁这个实例（返回 true 之后它已经不可用），但**恢复方式**不该一样：
             * 回收只要重新加载一次就够，连续崩溃才需要重建 Activity。
             */
            Log.e(TAG, "render process gone (crashed=" + crashed + ", visible=" + isVisibleNow() + ")");
            // 这个回调就在 WebView 内部调用栈里，立刻 destroy / loadUrl 有重入风险，挪到下一个消息周期
            mainHandler.post(() -> handleRendererLoss(crashed));
            return true;
        }
    }

    private final class ShellWebChromeClient extends WebChromeClient {

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (!isVisibleNow() || !isTrustedMicrophoneRequest(request)) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                return;
            }
            if (pendingMicRequest != null) {
                request.deny();
                return;
            }
            pendingMicRequest = request;
            try {
                requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
            } catch (RuntimeException failed) {
                pendingMicRequest = null;
                request.deny();
            }
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMicRequest == request) pendingMicRequest = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                WebChromeClient.FileChooserParams params) {
            if (filePathCallback != null) {
                // 上一个选择还没回，先按取消收尾（null = WebView 认的「取消」）
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
            if (callback == null) {
                return false;
            }
            filePathCallback = callback;
            // 面板是异步的：先把这次请求的参数拍快照
            pendingAcceptTypes = params == null ? null : params.getAcceptTypes();
            pendingMultiple = params != null
                    && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
            if (!launchFileChooser()) {
                // 连来源面板都弹不出来：必须回调，否则页面上的 <input type=file> 会一直挂住
                cancelFileChooser();
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
            if (BuildConfig.DEBUG && consoleMessage != null) {
                Log.d(TAG, "[web] " + consoleMessage.message() + " ("
                        + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + ")");
            }
            return true;
        }
    }

    /** @return true 表示已接管（去系统浏览器打开或已消费），false 表示留在 WebView 里。 */
    private boolean openOrConsume(@Nullable Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        String normalized = scheme.toLowerCase(Locale.US);
        if ("http".equals(normalized) || "https".equals(normalized)) {
            if (isLoopback(uri.getHost())) {
                return false;
            }
            // 外链一律丢给系统浏览器，别在壳里丢掉页面上下文
            return openExternally(uri);
        }
        if ("file".equals(normalized) || "about".equals(normalized)
                || "javascript".equals(normalized) || "data".equals(normalized)
                || "blob".equals(normalized)) {
            return false;
        }
        // mailto: / tel: / 第三方 scheme 交给系统
        return openExternally(uri);
    }

    private static boolean isLoopback(String host) {
        if (host == null) {
            return false;
        }
        String value = host.toLowerCase(Locale.US);
        return LOOPBACK_HOST.equals(value) || "localhost".equals(value) || "::1".equals(value);
    }

    private boolean openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException noHandler) {
            Log.w(TAG, "no activity for " + uri);
        }
        return true;
    }

    // ---------------------------------------------------------------- 文件选择

    /**
     * 附件上传的文件选择器，**来源可切换**（A 段）。
     *
     * <p>为什么不再只用系统 DocumentsUI：用户反馈「有的设备它有点小问题」——
     * 那台设备上系统文件选择器打不开某些目录 / 选完读不到，用户习惯用 MT 管理器
     * 这类国产文件管理器挑文件。所以这里给三个来源，各用不同的 Intent：
     *
     * | 来源 | Intent | 说明 |
     * |---|---|---|
     * | 系统文件 | {@code ACTION_OPEN_DOCUMENT} + {@code CATEGORY_OPENABLE} | SAF，返回的 `content://` 一定可读；支持多选；**始终可用** |
     * | MT 管理器 | {@code ACTION_GET_CONTENT} + 通配 MIME + {@code setPackage("bin.mt.plus")} | 先 {@code resolveActivity}，解析不到**不硬跳**（硬跳就是 ActivityNotFound 闪退） |
     * | 其他应用 | {@code createChooser(ACTION_GET_CONTENT)} | 让系统列出所有能选文件的应用；**刻意不加** `CATEGORY_OPENABLE`，否则会把没声明它的国产管理器挡在候选之外 |
     *
     * <p>MT 管理器那边有官方依据：它的更新日志从 v2.13.4 起就写着「优化文件选择器界面并
     * **支持外部程序调用**」（v2.13.0 还修过「外部程序调用 MT 管理器打开文件时容易出现
     * Permission Denial」）。也就是说它**注册了**给外部应用选文件的入口；但不同版本 /
     * 不同 ROM 上注册的 action 不完全一样，所以只把它当成「候选来源之一」，解析不到就退回
     * 系统或应用选择器，靠 {@link AlertDialog} 让用户自己决定。
     *
     * <p>记忆：选过的来源落 {@link SharedPreferences}，下次直接走它；长按「+」由页面调
     * {@link PickerBridge#reset()} 清掉记忆，下次就又弹面板。
     */
    private boolean launchFileChooser() {
        String remembered = rememberedPickerSource();
        if (remembered != null && launchPickerSource(remembered)) {
            return true;
        }
        // 没有记忆，或记忆的来源这次拉不起来（被卸载 / 换了 ROM）：请用户选一次
        return showPickerSourcePanel(remembered != null);
    }

    /** @return true 表示已经接管这次选择（面板或选择器已弹出）；false 表示连面板都弹不出来 */
    private boolean showPickerSourcePanel(boolean fallback) {
        final List<String> sources = new ArrayList<>();
        final List<String> labels = new ArrayList<>();
        sources.add(SOURCE_SYSTEM);
        labels.add(getString(R.string.pick_source_system));
        // 没装 MT 管理器就不画这一项：列一个装不上的来源只会让人以为「点了没反应」
        if (isMountManagerInstalled()) {
            sources.add(SOURCE_MT);
            labels.add(getString(mtPickerUsable()
                    ? R.string.pick_source_mt
                    : R.string.pick_source_mt_unavailable));
        }
        sources.add(SOURCE_CHOOSER);
        labels.add(getString(R.string.pick_source_other));

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(R.string.pick_source_title);
        if (fallback) {
            builder.setMessage(R.string.pick_source_fallback);
        }
        builder.setItems(labels.toArray(new CharSequence[0]), new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                // 防御：列表项与来源数组理论上等长，索引越界不能把页面卡住
                if (which < 0 || which >= sources.size()) {
                    cancelFileChooser();
                    return;
                }
                String source = sources.get(which);
                if (!launchPickerSource(source)) {
                    Toast.makeText(MainActivity.this, R.string.pick_source_failed,
                            Toast.LENGTH_SHORT).show();
                    cancelFileChooser();
                    return;
                }
                rememberPickerSource(source);
            }
        });
        builder.setNegativeButton(R.string.pick_source_cancel, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                cancelFileChooser();
            }
        });
        // 返回键 / 点外面关掉面板也算取消：不回调的话页面的「+」会一直挂着
        builder.setOnCancelListener(new DialogInterface.OnCancelListener() {
            @Override
            public void onCancel(DialogInterface dialog) {
                cancelFileChooser();
            }
        });
        try {
            builder.show();
            return true;
        } catch (RuntimeException broken) {
            // 窗口正在销毁等极端情况：弹不出来也要把这次选择收尾
            Log.w(TAG, "来源面板弹不出来", broken);
            cancelFileChooser();
            return false;
        }
    }

    /** 按来源拼 Intent 并拉起；false = 这个来源这次用不了（不会抛、也不会硬跳）。 */
    private boolean launchPickerSource(String source) {
        if (SOURCE_SYSTEM.equals(source)) {
            return launchSystemDocumentPicker();
        }
        if (SOURCE_MT.equals(source)) {
            return launchMountManagerPicker();
        }
        if (SOURCE_CHOOSER.equals(source)) {
            return launchOtherAppsPicker();
        }
        return false;
    }

    /**
     * 系统文件：`ACTION_OPEN_DOCUMENT`（SAF）。
     *
     * <p>SAF 返回的 `content://` 一定可读，这也是「选了文件但页面没反应」最稳的一条路。
     * 用 `createChooser` 包一层：部分 ROM 上直接 start 会被默认文件管理器独占，
     * 包一层至少让用户看得到「文件」这个来源。
     */
    private boolean launchSystemDocumentPicker() {
        String[] mimeTypes = toMimeTypes(pendingAcceptTypes);
        Intent document = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        document.addCategory(Intent.CATEGORY_OPENABLE);
        document.setType(resolveIntentType(mimeTypes));
        if (mimeTypes.length > 0) {
            document.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (pendingMultiple) {
            document.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        document.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return startForFileChooser(Intent.createChooser(document, getString(R.string.pick_file)));
    }

    /**
     * MT 管理器：`ACTION_GET_CONTENT` + 通配 MIME + `setPackage("bin.mt.plus")`。
     *
     * <p><b>先 resolveActivity 再跳</b>：MT 管理器虽然从 v2.13.4 起「支持外部程序调用」，
     * 但那是它的**文件选择器**入口，不同版本注册的 action / MIME 不完全一样；直接把
     * 带 package 的 Intent 扔出去，解析不到就是 {@code ActivityNotFoundException}。
     * 解析不到时返回 false，由面板回退到「其他应用」或让用户重选 —— 绝不硬跳。
     */
    private boolean launchMountManagerPicker() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        intent.setPackage(MT_PACKAGE);
        if (pendingMultiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (intent.resolveActivity(getPackageManager()) == null) {
            Log.i(TAG, "MT 管理器没有注册 GET_CONTENT，不硬跳（回退到来源面板）");
            return false;
        }
        return startForFileChooser(intent);
    }

    /**
     * 其他应用：`createChooser(ACTION_GET_CONTENT)`。
     *
     * <p><b>刻意不加 `CATEGORY_OPENABLE`</b>：MT 管理器这类第三方文件管理器很多不声明它，
     * 加上就等于把它们从候选列表里筛掉 —— 那正好是这次要解决的问题。代价是可能选到
     * 不可流式读的地址，所以 {@link #extractPickedUris} 那边统一只收 `content://`。
     */
    private boolean launchOtherAppsPicker() {
        String[] mimeTypes = toMimeTypes(pendingAcceptTypes);
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (pendingMultiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return startForFileChooser(Intent.createChooser(intent, getString(R.string.pick_file)));
    }

    private boolean startForFileChooser(Intent chooser) {
        try {
            startActivityForResult(chooser, REQ_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException noPicker) {
            Log.w(TAG, "文件选择器拉不起来", noPicker);
            return false;
        } catch (RuntimeException broken) {
            // 个别 ROM 在窗口不可见时抛 SecurityException 之类：当成「这次用不了」
            Log.w(TAG, "文件选择器启动失败", broken);
            return false;
        }
    }

    /** 取消这次选择：**必须**回 `null`（空数组在单选 `<input type=file>` 上会让「+」一直挂着）。 */
    private void cancelFileChooser() {
        ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        pendingAcceptTypes = null;
        pendingMultiple = false;
        if (callback != null) {
            callback.onReceiveValue(null);
        }
    }

    private SharedPreferences pickerPreferences() {
        return getSharedPreferences(PREFS_PICKER, MODE_PRIVATE);
    }

    @Nullable
    private String rememberedPickerSource() {
        String value;
        try {
            value = pickerPreferences().getString(KEY_PICKER_SOURCE, null);
        } catch (RuntimeException broken) {
            return null;
        }
        if (SOURCE_SYSTEM.equals(value) || SOURCE_MT.equals(value) || SOURCE_CHOOSER.equals(value)) {
            return value;
        }
        return null;
    }

    private void rememberPickerSource(String source) {
        try {
            pickerPreferences().edit().putString(KEY_PICKER_SOURCE, source).apply();
        } catch (RuntimeException broken) {
            // 记不住就下次再问一遍，不影响本次选择
            Log.w(TAG, "来源记忆没写进去", broken);
        }
    }

    private void forgetPickerSource() {
        try {
            pickerPreferences().edit().remove(KEY_PICKER_SOURCE).apply();
        } catch (RuntimeException broken) {
            Log.w(TAG, "来源记忆清不掉", broken);
        }
    }

    /** MT 管理器装没装（共存版 `bin.mt.plus.canary` 不算）。 */
    private boolean isMountManagerInstalled() {
        try {
            getPackageManager().getPackageInfo(MT_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException notInstalled) {
            return false;
        } catch (RuntimeException broken) {
            Log.w(TAG, "查 MT 管理器安装状态失败", broken);
            return false;
        }
    }

    /** MT 管理器有没有给通配 MIME 的 `GET_CONTENT` 注册入口（决定面板上那一项画成哪个文案）。 */
    private boolean mtPickerUsable() {
        Intent probe = new Intent(Intent.ACTION_GET_CONTENT);
        probe.setType("*/*");
        probe.setPackage(MT_PACKAGE);
        try {
            return probe.resolveActivity(getPackageManager()) != null;
        } catch (RuntimeException broken) {
            Log.w(TAG, "解析 MT 管理器入口失败", broken);
            return false;
        }
    }

    /**
     * 页面用的极小原生桥：只服务于「来源记忆」。
     *
     * <p>为什么要它：`onShowFileChooser` **拿不到「长按」这个手势**，而需求要求
     * 「记忆上次来源，长按可换」。页面在长按「+」时先调
     * `window.DSNativePicker.reset()` 把记忆清掉，下一次 {@code onShowFileChooser}
     * 就会重新弹面板 —— 为此不必新开一条 HTTP 路由。
     */
    public class PickerBridge {

        /** 当前记住的来源（`system` / `mt` / `chooser`；空串 = 还没选过）。 */
        @android.webkit.JavascriptInterface
        public String current() {
            String value = rememberedPickerSource();
            return value == null ? "" : value;
        }

        /** 清掉记忆：下一次点「+」重新弹来源面板。 */
        @android.webkit.JavascriptInterface
        public void reset() {
            forgetPickerSource();
        }
    }

    /**
     * UI 状态中转箱（S1）：页面把「草稿 / 滚动位置 / 当前会话」暂存在这里。
     *
     * <p><b>为什么需要它。</b>`sessionStorage` 的寿命 = **浏览上下文**：WebView 一旦被销毁重建
     * （渲染进程被系统回收，见 {@link #rebuildWebViewInPlace()}），浏览器就会把它清空 ——
     * 而那恰恰是用户遇到的「切出去一下回来草稿没了」。这份中转箱挂在本 Activity 上，
     * 换 WebView 不会丢；Activity 自己重建或退出应用就没了 —— 正好是「这一次运行内有效」
     * 的语义（**不是** `localStorage`，不会跨启动残留、不会串到下一次会话）。
     *
     * <p><b>三条纪律。</b>
     * <ol>
     *   <li>**只进内存、绝不落盘**：没有 SharedPreferences、不写文件，进程结束就消失；</li>
     *   <li>**不做任何业务判断**：收到的字符串原样存、原样给，键与结构全由页面决定
     *       （原生不多知道一件界面上的事，与 {@link PickerBridge} 同一个原则）；</li>
     *   <li>调用发生在 **JavaBridge 线程**（不是主线程），读写都要加锁。</li>
     * </ol>
     */
    public class UiStateRelay {

        /** 页面写进来的那份快照（JSON 字符串；`null` = 还没有） */
        private String payload;

        /** 页面在状态变化 / 切后台之前推一份（超过上限整份丢掉，别把内存撑爆）。 */
        @android.webkit.JavascriptInterface
        public void put(String json) {
            if (json == null || json.length() > UI_RELAY_MAX_CHARS) {
                Log.w(TAG, "ui relay: 快照为空或过大，丢弃（"
                        + (json == null ? "null" : json.length() + " chars") + "）");
                return;
            }
            synchronized (this) {
                payload = json;
            }
        }

        /** 页面启动时读一次（没有就返回空串：调用方只判长度，不用判 null）。 */
        @android.webkit.JavascriptInterface
        public String take() {
            synchronized (this) {
                return payload == null ? "" : payload;
            }
        }

        /** 清空（退出登录等场景；幂等）。 */
        @android.webkit.JavascriptInterface
        public void clear() {
            synchronized (this) {
                payload = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        pendingAcceptTypes = null;
        pendingMultiple = false;
        if (callback == null) {
            return;
        }
        Uri[] picked = extractPickedUris(resultCode, data);
        if (picked.length == 0) {
            // 用户取消 / 选到的都不是 content://：一律回 null。
            // 空数组是「选了 0 个文件」，在单选 input 上会让页面的「+」永远卡住。
            Log.i(TAG, "file chooser returned nothing (resultCode=" + resultCode + ")");
            callback.onReceiveValue(null);
            return;
        }
        callback.onReceiveValue(picked);
    }

    /**
     * 从结果里取 URI。**只收 `content://`**：WebView 关着 `setAllowFileAccess(false)`，
     * `file://` 地址进来只会「选了没反应」—— 挡掉并给一句人话，比静默失败强。
     */
    private Uri[] extractPickedUris(int resultCode, @Nullable Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return new Uri[0];
        }
        List<Uri> uris = new ArrayList<>();
        boolean skippedUnreadable = false;
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri == null) {
                    continue;
                }
                if (!isReadablePickedUri(uri)) {
                    skippedUnreadable = true;
                    continue;
                }
                if (!uris.contains(uri)) {
                    uris.add(uri);
                }
            }
        }
        if (uris.isEmpty()) {
            Uri single = data.getData();
            if (single != null) {
                if (isReadablePickedUri(single)) {
                    uris.add(single);
                } else {
                    skippedUnreadable = true;
                }
            }
        }
        if (skippedUnreadable) {
            Log.w(TAG, "选中的文件里有非 content:// 地址，已忽略（WebView 读不了 file://）");
            if (uris.isEmpty()) {
                Toast.makeText(this, R.string.pick_source_unreadable, Toast.LENGTH_LONG).show();
            }
        }
        return uris.toArray(new Uri[0]);
    }

    private static boolean isReadablePickedUri(Uri uri) {
        String scheme = uri.getScheme();
        return scheme != null && "content".equalsIgnoreCase(scheme);
    }

    private static String[] toMimeTypes(@Nullable String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) {
            return new String[0];
        }
        List<String> result = new ArrayList<>();
        for (String accept : acceptTypes) {
            if (accept == null) {
                continue;
            }
            String value = accept.trim().toLowerCase(Locale.US);
            if (value.isEmpty()) {
                continue;
            }
            if (value.startsWith(".")) {
                String mapped = mimeFromExtension(value.substring(1));
                if (mapped != null && !result.contains(mapped)) {
                    result.add(mapped);
                }
            } else if (value.contains("/")) {
                if (!result.contains(value)) {
                    result.add(value);
                }
            }
        }
        return result.toArray(new String[0]);
    }

    private static String mimeFromExtension(String extension) {
        switch (extension) {
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "gif":
                return "image/gif";
            case "webp":
                return "image/webp";
            case "pdf":
                return "application/pdf";
            case "txt":
                return "text/plain";
            case "json":
                return "application/json";
            case "md":
                return "text/markdown";
            case "csv":
                return "text/csv";
            default:
                return null;
        }
    }

    private static String resolveIntentType(String[] mimeTypes) {
        if (mimeTypes.length == 0) {
            return "*/*";
        }
        if (mimeTypes.length == 1) {
            return mimeTypes[0];
        }
        String first = mimeTypes[0];
        int slash = first.indexOf('/');
        if (slash > 0) {
            String prefix = first.substring(0, slash);
            boolean sameFamily = true;
            for (String type : mimeTypes) {
                if (!type.startsWith(prefix + "/")) {
                    sameFamily = false;
                    break;
                }
            }
            if (sameFamily) {
                return prefix + "/*";
            }
        }
        return "*/*";
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // manifest 里声明了 configChanges，横竖屏不重建 Activity，WebView 状态保留
    }

    /* ── 渲染进程丢失后的恢复（S1） ─────────────────────────────────────── */

    /**
     * 页面加载完成之后再等一段，才承认「这一次真的活了」。
     *
     * <p>为什么不能只看 {@code onPageFinished}：崩溃循环的形态就是「加载完立刻再死」。
     * 若在 onPageFinished 就清零，失败计数永远到不了阈值 → 无限重新加载，用户看到的是
     * 一直闪。活过 {@link #RENDERER_HEALTHY_AFTER_MS} 才清零，崩溃循环才有出口。
     */
    private final Runnable markRendererHealthy = () -> {
        rendererFailureWindowStart = 0L;
        rendererRecoveryFailures = 0;
        renderProcessRestartScheduled = false;
    };

    /** 现在「用户真的在看这一页」吗（onResume 之后、onPause 之前，且 Activity 处于 RESUMED）。 */
    private boolean isVisibleNow() {
        if (!appVisible || isFinishing() || isDestroyed()) {
            return false;
        }
        return getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }

    /**
     * 渲染进程丢失的统一收口（`onRenderProcessGone` 只负责把它挪到下一个消息周期）。
     *
     * <p>三档恢复，前两档都**不重建 Activity**：
     * <ol>
     *   <li>后台丢的：只记一笔，等用户自己回来（绝不 startActivity —— 那等于应用自己跳到前台）；</li>
     *   <li>前台丢的（或回来时发现丢过）：就地换一个 WebView 重新加载；</li>
     *   <li>窗口期内连续失败：才 recreate()。</li>
     * </ol>
     *
     * @param crashed true = 渲染进程自己崩了；false = 被系统回收（内存压力）
     */
    private void handleRendererLoss(boolean crashed) {
        // 返回 true 之后这个实例已经不可用：必须销毁，否则它会静默吃掉所有触摸与回调
        destroyWebView();
        if (isFinishing() || isDestroyed()) {
            return;
        }
        boolean escalate = noteRendererFailure(crashed);
        if (!isVisibleNow()) {
            /*
             * 用户已经切走了（或正在切）：这一屏谁都看不见，重建是纯浪费 —— 更不该 startActivity
             * 把应用拉回前台（那是「应用会自己跳出来」的老毛病）。等下一次 onResume。
             */
            rendererRecoveryPending = true;
            rendererRecoveryEscalate = escalate;
            Log.i(TAG, "renderer gone while backgrounded; recovery deferred to resume (escalate=" + escalate + ")");
            return;
        }
        if (!escalate && rebuildWebViewInPlace()) {
            Log.i(TAG, "renderer recovery: WebView rebuilt in place (failure #" + rendererRecoveryFailures + ")");
            return;
        }
        // 连续失败 / 连地址都没有：这时重建 Activity 才是合理的
        showError(getString(R.string.error_renderer_lost));
        scheduleActivityRecreate();
    }

    /**
     * 记一次渲染进程丢失，并回答「该不该升级成重建 Activity」。
     *
     * <p>窗口期内前 {@link #MAX_IN_PLACE_RECOVERY} 次都先就地恢复（多数情况下一次就够），
     * 之后才升级。崩溃（{@code didCrash}）与回收走同一套计数：连崩三次说明页面真的坏了，
     * 而连被回收三次说明这台机器内存实在紧张 —— 两种情况都该把 Activity 也换掉。
     */
    private boolean noteRendererFailure(boolean crashed) {
        long now = SystemClock.uptimeMillis();
        if (rendererFailureWindowStart == 0L || now - rendererFailureWindowStart > RENDERER_FAILURE_WINDOW_MS) {
            rendererFailureWindowStart = now;
            rendererRecoveryFailures = 0;
        }
        rendererRecoveryFailures += 1;
        boolean escalate = rendererRecoveryFailures > MAX_IN_PLACE_RECOVERY;
        Log.i(TAG, "renderer failure #" + rendererRecoveryFailures + " within window (crashed=" + crashed
                + ", escalate=" + escalate + ")");
        return escalate;
    }

    /**
     * 只重建 WebView（**不重建 Activity、不重启本地服务器**），再加载同一地址。
     *
     * <p>为什么这样比 recreate() 好：
     * <ul>
     *   <li>Activity 重建会走 {@link #onDestroy} → {@code server.stop()}，连带拆掉 WS 隧道
     *       （{@code RemoteWsHandler.cancelAll}）与后台保活前台服务，回来时连接得从头建；</li>
     *   <li>本地服务器不重启 = 端口不变（{@link LocalServer} 优先固定端口）= origin 不变，
     *       {@code localStorage} 里的会话缓存照样能直出；</li>
     *   <li>页面还能从原生中转箱（{@code DSNativeUi}）把草稿、滚动位置捞回来 —— 换成
     *       Activity 重建就什么都没了。</li>
     * </ul>
     *
     * @return false = 现在没法就地恢复（没有地址 / 视图还没建好），调用方该升级
     */
    private boolean rebuildWebViewInPlace() {
        final String url = loadedUrl;
        if (url == null || rootLayout == null || isFinishing() || isDestroyed()) {
            return false;
        }
        destroyWebView();
        WebView view = newShellWebView();
        webView = view;
        // 加在 index 0：errorView 是后加的，必须压在它下面（否则错误页会被新的 WebView 盖住）
        rootLayout.addView(view, 0);
        configureWebView();
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
        view.setVisibility(View.VISIBLE);
        Log.i(TAG, "renderer recovery: reload " + url + " in a fresh WebView");
        view.loadUrl(url);
        return true;
    }

    /**
     * 崩溃循环的最后一档：重建 Activity。
     *
     * <p>用 {@link #recreate()} 而不是 {@code startActivity(CLEAR_TASK) + finish()}：后者会
     * 新建一个任务、把界面整个掀掉重来（用户看到的是「应用自己重启了」）。recreate() 留在
     * 原位，而且只有**连续就地恢复失败**之后才会走到这里。
     */
    private void scheduleActivityRecreate() {
        if (renderProcessRestartScheduled || !appVisible) {
            return;
        }
        renderProcessRestartScheduled = true;
        mainHandler.postDelayed(() -> {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            Log.i(TAG, "renderer recovery: escalating to activity recreate");
            recreate();
        }, ACTIVITY_RESTART_DELAY_MS);
    }

    private boolean isTrustedMicrophoneRequest(PermissionRequest request) {
        if (webView == null || loadedUrl == null || isFinishing() || isDestroyed()) return false;
        Uri origin = request.getOrigin();
        Uri page = Uri.parse(loadedUrl);
        String[] resources = request.getResources();
        return origin != null && "http".equals(origin.getScheme()) && LOOPBACK_HOST.equals(origin.getHost())
                && origin.getPort() == page.getPort() && resources.length == 1
                && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]);
    }

    private void destroyWebView() {
        PermissionRequest mic = pendingMicRequest;
        pendingMicRequest = null;
        if (mic != null) {
            try {
                mic.deny();
            } catch (RuntimeException ignored) {
                // The renderer that requested permission may already be gone.
            }
        }
        if (remoteDshWeb != null) {
            remoteDshWeb.retire();
            remoteDshWeb = null;
        }
        WebView view = webView;
        webView = null;
        if (view == null) {
            return;
        }
        ViewGroup parent = view.getParent() instanceof ViewGroup
                ? (ViewGroup) view.getParent() : null;
        if (parent != null) {
            parent.removeView(view);
        }
        try {
            view.stopLoading();
        } catch (RuntimeException ignored) {
            // 渲染进程已死时 stopLoading 可能抛异常，忽略
        }
        try {
            view.destroy();
        } catch (RuntimeException ignored) {
            // 同上
        }
    }

    @Override
    protected void onDestroy() {
        Log.i(TAG, "onDestroy");
        // 「加载完成 15 秒后才算稳定」的确认可能还挂着：Activity 都要走了，别让它去改状态
        mainHandler.removeCallbacks(markRendererHealthy);
        // 选择器面板可能还挂着：Activity 走了必须把回调收尾，否则页面的「+」会一直等
        cancelFileChooser();
        if (server != null) {
            // 关闭监听 socket + 取消在途代理请求
            server.stop();
            server = null;
        }
        if (httpClient != null) {
            try {
                httpClient.connectionPool().evictAll();
            } catch (RuntimeException ignored) {
                // 连接池驱逐失败无所谓
            }
        }
        destroyWebView();
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
