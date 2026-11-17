package ai.deepseek.tablet;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
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
    private static final String LOOPBACK_HOST = "127.0.0.1";

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
        super.onPause();
        if (webView != null) {
            // 页面进入后台后停掉定时器与合成，后台 CPU / 内存占用明显下降
            webView.onPause();
            webView.pauseTimers();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
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

        // Android WebView 里 env(safe-area-inset-*) 恒为 0，网页没法自己避让系统栏，
        // 所以顶部按状态栏高度让出空间（否则顶栏会和状态栏叠在一起），
        // 底部兜住键盘与导航栏。
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            int top = bars.top;
            int bottom = Math.max(bars.bottom, ime.bottom);
            view.setPadding(0, top, 0, bottom);
            return windowInsets;
        });

        setContentView(rootLayout);
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

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(resolveIntentType(mimeTypes));
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (multiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
            startActivityForResult(Intent.createChooser(intent, getString(R.string.pick_file)),
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
        if (renderProcessRestartScheduled) {
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
