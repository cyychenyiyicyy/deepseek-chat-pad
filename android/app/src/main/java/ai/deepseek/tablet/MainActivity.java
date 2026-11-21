package ai.deepseek.tablet;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
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

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

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
    private static final String LOOPBACK_HOST = "127.0.0.1";

    /** 壳自己的轻量设置（目前只有「通知权限问过没有」这一项） */
    private static final String PREFS_SHELL = "dsp.shell.v1";
    private static final String KEY_NOTIF_ASKED = "notif_requested";

    private static final int COLOR_BACKGROUND = 0xFF0F1115;
    /** 浅色主题时的窗口底色，与网页 --dsw-alias-bg-base 对齐 */
    private static final int COLOR_BACKGROUND_LIGHT = 0xFFFFFFFF;
    private static final int COLOR_TEXT = 0xFFE7E9EC;

    private static final long ACTIVITY_RESTART_DELAY_MS = 600L;

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
    private WebView webView;
    private TextView errorView;
    private LocalServer server;
    private OkHttpClient httpClient;

    private ValueCallback<Uri[]> filePathCallback;
    private String loadedUrl;
    private boolean renderProcessRestartScheduled;
    /**
     * 应用是否可见。后台时绝不做任何会把界面拉回前台的操作——
     * 系统在后台回收 WebView 渲染进程非常常见，若此时重建 Activity 就会「自己跳出来」。
     */
    private boolean appVisible;
    /** 后台期间渲染进程被回收过，等用户自己回来时再重建 */
    private boolean rendererNeedsRebuild;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate");
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
        // 放在这个位置（早于下面 rendererNeedsRebuild 的提前 return）才能保证重建路径也走到。
        requestNotificationPermissionOnce();
        restoreKeepAliveIfNeeded();
        if (rendererNeedsRebuild) {
            // 后台被回收过，用户已经回来了，这时重建是可见且合理的
            rendererNeedsRebuild = false;
            renderProcessRestartScheduled = false;
            Log.i(TAG, "rebuilding after background renderer loss");
            mainHandler.post(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    recreate();
                }
            });
            return;
        }
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
    }

    // ---------------------------------------------------------------- 后台保活 / 通知权限

    /**
     * Android 13+ 的运行时通知权限（{@code POST_NOTIFICATIONS}）。
     *
     * <p>没有它，后台保活的前台服务照样跑，只是那条「Chat Pad 正在保持远程连接」的常驻通知
     * 不显示 —— 用户看不到后台有东西在跑，就会觉得「怎么偷偷跑了」。所以能要就要一次。
     *
     * <p>只用框架 API：{@code Activity.requestPermissions(int, String[], int)} 自 API 23 起就有，
     * 不必引入 androidx 的 ActivityCompat（本项目虽已依赖 androidx.appcompat，但没必要为此多一层）。
     * 每装一次只问一次：用户拒绝后不再反复弹（拒绝不影响保活本身）。
     */
    private void requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (RemoteKeepAliveService.isNotificationAllowed(this)) {
            return;
        }
        SharedPreferences preferences = getSharedPreferences(PREFS_SHELL, MODE_PRIVATE);
        if (preferences.getBoolean(KEY_NOTIF_ASKED, false)) {
            return;
        }
        preferences.edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
        try {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    REQ_POST_NOTIFICATIONS);
        } catch (RuntimeException failed) {
            // 个别 ROM 在窗口还没拿到焦点时会抛；失败就算了，拒绝也只是一条通知不显示
            Log.w(TAG, "request POST_NOTIFICATIONS failed", failed);
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

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(COLOR_BACKGROUND);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
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

    /** 上次告诉网页的状态栏高度，页面加载完成时补发一次（避免页面晚于 inset 就绪） */
    private int lastSafeTop = -1;

    /** 把状态栏高度写进网页的 CSS 变量 --ds-safe-top */
    private void publishSafeTop(int topPx) {
        lastSafeTop = topPx;
        if (webView == null) {
            return;
        }
        String script = "(function(){try{document.documentElement.style.setProperty("
                + "'--ds-safe-top','" + topPx + "px');}catch(e){}})()";
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
            // 渲染进程 OOM/崩溃：返回 true 吃掉这次崩溃，重建 Activity 而不是闪退
            Log.e(TAG, "render process gone (crashed=" + crashed + ")");
            // 这个回调就在 WebView 内部调用栈里，立刻 destroy 有重入风险，挪到下一个消息周期
            mainHandler.post(() -> {
                destroyWebView();
                if (!appVisible) {
                    // 后台被系统回收：只做记录，等用户下次回来再重建。
                    // 这里一旦 startActivity，应用就会自己跳到前台。
                    rendererNeedsRebuild = true;
                    renderProcessRestartScheduled = false;
                    Log.i(TAG, "renderer gone while backgrounded; rebuild deferred");
                    return;
                }
                showError(getString(R.string.error_renderer_lost));
                scheduleActivityRestart();
            });
            return true;
        }
    }

    private final class ShellWebChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                WebChromeClient.FileChooserParams params) {
            if (filePathCallback != null) {
                // 上一个选择还没回，先按取消收尾
                filePathCallback.onReceiveValue(new Uri[0]);
                filePathCallback = null;
            }
            if (callback == null) {
                return false;
            }
            filePathCallback = callback;
            if (!launchFileChooser(params)) {
                // 拉不起选择器也要回调，否则页面上的 <input type=file> 会一直挂住
                filePathCallback = null;
                callback.onReceiveValue(new Uri[0]);
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

    private boolean launchFileChooser(WebChromeClient.FileChooserParams params) {
        String[] acceptTypes = params == null ? null : params.getAcceptTypes();
        boolean multiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        String[] mimeTypes = toMimeTypes(acceptTypes);

        // 优先用 SAF（ACTION_OPEN_DOCUMENT）：返回的 content:// 一定可读，
        // GET_CONTENT 在部分国产 ROM 上会给出读不了的地址，表现为"选了文件但页面没反应"
        Intent document = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        document.addCategory(Intent.CATEGORY_OPENABLE);
        document.setType(resolveIntentType(mimeTypes));
        if (mimeTypes.length > 0) {
            document.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (multiple) {
            document.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        document.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(Intent.createChooser(document, getString(R.string.pick_file)),
                    REQ_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException noDocument) {
            Log.w(TAG, "no document picker, falling back to GET_CONTENT", noDocument);
        }

        // 没有 SAF 文档选择器的老 ROM，退回 GET_CONTENT
        Intent legacy = new Intent(Intent.ACTION_GET_CONTENT);
        legacy.addCategory(Intent.CATEGORY_OPENABLE);
        legacy.setType(resolveIntentType(mimeTypes));
        if (mimeTypes.length > 0) {
            legacy.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (multiple) {
            legacy.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        legacy.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(Intent.createChooser(legacy, getString(R.string.pick_file)),
                    REQ_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException noChooser) {
            Log.w(TAG, "no file chooser available", noChooser);
            return false;
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
        if (callback == null) {
            return;
        }
        // 用户取消时回空数组，WebView 认为没有选中文件
        callback.onReceiveValue(extractPickedUris(resultCode, data));
    }

    private static Uri[] extractPickedUris(int resultCode, @Nullable Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return new Uri[0];
        }
        List<Uri> uris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null && !uris.contains(uri)) {
                    uris.add(uri);
                }
            }
        }
        if (uris.isEmpty()) {
            Uri single = data.getData();
            if (single != null) {
                uris.add(single);
            }
        }
        return uris.toArray(new Uri[0]);
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

    private void scheduleActivityRestart() {
        if (renderProcessRestartScheduled || !appVisible) {
            return;
        }
        renderProcessRestartScheduled = true;
        mainHandler.postDelayed(() -> {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            Intent restart = new Intent(MainActivity.this, MainActivity.class);
            restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            startActivity(restart);
            finish();
        }, ACTIVITY_RESTART_DELAY_MS);
    }

    private void destroyWebView() {
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
