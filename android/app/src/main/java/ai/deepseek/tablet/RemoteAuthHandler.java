package ai.deepseek.tablet;

import android.app.Activity;
import android.app.Application;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * /__ds_auth/* 的实现：**应用内授权容器**（原生全屏 Dialog + WebView，或交给系统浏览器）。
 *
 * <p>它解决的问题：远端 DSH Server 的第三方登录必须在浏览器里完成，而页面跑在
 * {@code http://127.0.0.1:18888} 的 WebView 里 —— 它既不能打开外部浏览器，也不能把
 * 「用户还在登录页」这件事告诉原生侧。所以把「开一个窗口去登录」这一步交给原生：
 * 页面只要调用 {@code POST /__ds_auth/open} 把 URL 交过来，用户在窗口里走完第三方登录，
 * 页面自己按 {@code qrId} 轮询服务端拿结果（见
 * {@code work/2026-11-21-chatpad接入DSH远程/input-J6-登录方式调研.md} §2.3 路径 B）。
 *
 * <p><b>为什么不接 {@code dshremote://oauth} 回调</b>（这是本类第一版的设计，已废弃）：
 * <ol>
 *   <li>服务端只认 {@code dshremote://oauth} 这一个自定义 scheme，别的 scheme / 外部 URL 会被
 *       归一化成同源 {@code /app}（{@code docs/plugin-integration.md:110-112}）——我们没法用自己的
 *       scheme 当 {@code return_to}；</li>
 *   <li>声明 {@code dshremote} 就会跟官方 RN/Go 客户端抢回调（同一台设备两个 App 注册同一 scheme）；</li>
 *   <li>全仓没有 loopback 回调，也没有「任意 scheme 白名单」。</li>
 * </ol>
 * 所以本类<b>不解析 token、不轮询结果</b>：QR 会话的结果由页面用
 * {@code GET /api/v1/auth/oauth/qr/{qrId}} 直接问服务端。这里只保留一条兜底：
 * 万一服务器仍然往 {@code dshremote://oauth?token=…} 回跳，WebView 里<b>不要真的导航</b>
 * （导航到自定义 scheme 只会得到一张错误页），把那条 URL 原样记进 {@code lastRedirect} 给页面。
 *
 * <p>接口一览（页面同源 fetch，不需要任何额外权限）：
 * <pre>
 * POST /__ds_auth/open    {url, title?, serverUrl?, allowHost?, mode?}  → {ok,open,mode,id,url}
 * POST /__ds_auth/close   {}                                           → {ok,open:false,closed}
 * GET  /__ds_auth/state                                                → {ok,open,mode,id,url,title,lastRedirect}
 * </pre>
 *
 * <p>线程模型（本类最容易写错的地方）：
 * <ul>
 *   <li>{@link #handle} 跑在 LocalServer 的线程池线程里，<b>绝不</b>在里面碰 View</li>
 *   <li>Dialog / WebView 全部由 {@code activity.runOnUiThread(...)} 在 UI 线程创建，
 *       工作线程只用 {@link CountDownLatch} 等「窗口弹出来了没有」这一个事件（有超时）</li>
 *   <li>对外可读的状态（open / url / title / lastRedirect）都是 volatile，
 *       UI 线程写、worker 线程读，不加锁也不阻塞</li>
 *   <li>WebView 的 {@code destroy()} 推到主线程队列的下一拍：在它自己的回调栈里销毁会偶发崩溃</li>
 * </ul>
 *
 * <p>安全边界（不做「任意网页打开器」）：
 * <ul>
 *   <li>只接受 https；传了 {@code serverUrl} 就要求与之<b>严格同源</b>（scheme+host+端口），
 *       传了 {@code allowHost} 就要求 host（可带端口、逗号分隔）在名单里；</li>
 *   <li>两个都没传时退一步：拒绝回环/内网地址；</li>
 *   <li>窗口里只放行 https 导航；{@code dshremote:} / {@code http:} / {@code file:} /
 *       {@code content:} / {@code intent:} / {@code javascript:} 一律拦下（只记录不导航），
 *       既不跳出 App 也不加载本地文件；</li>
 *   <li>token 只在 URL 里由服务端控制，本类不解析、不落日志（日志一律走 {@link #safeUrlForLog}）。</li>
 * </ul>
 */
final class RemoteAuthHandler {

    private static final String TAG = "DsRemoteAuth";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_auth/";

    private static final String PATH_OPEN = "/__ds_auth/open";
    private static final String PATH_CLOSE = "/__ds_auth/close";
    private static final String PATH_STATE = "/__ds_auth/state";

    /** 默认模式：应用内全屏 WebView */
    private static final String MODE_INLINE = "inline";
    /**
     * 外部模式：交给系统浏览器（{@code Intent.ACTION_VIEW}）。
     *
     * <p>为什么需要它：Google 的登录页会直接拒绝 WebView（UA 里带 {@code wv} 或 JS 探测到
     * 无浏览器环境就报 {@code disallowed_useragent}，见
     * {@code input-J6-登录方式调研.md} §6.2 与 dsh-Go 的 {@code hosts_state.dart:509-510}）。
     * 这种 provider 只能开系统浏览器，而"登录完成了没有"由页面的 QR 轮询回答，与哪个窗口完成无关。
     */
    private static final String MODE_EXTERNAL = "external";

    private static final String DEFAULT_TITLE = "登录授权";
    private static final String HINT_DEFAULT = "在这里完成第三方登录后点「关闭」返回，应用会自动继续";
    private static final String HINT_LOADING = "正在加载…";

    // ---------------------------------------------------------------- 上限与超时

    /** 请求体上限：只有一两个短字段，8 KiB 绰绰有余 */
    private static final int MAX_BODY_BYTES = 8 * 1024;
    private static final int READ_BUFFER_BYTES = 1024;
    /** 单个 URL 的长度上限 */
    private static final int MAX_URL_LENGTH = 2048;
    /** 标题长度上限（超了截断，不报错） */
    private static final int MAX_TITLE_LENGTH = 48;
    /** 等 UI 线程把窗口弹出来的上限（不含网页加载时间） */
    private static final long UI_TIMEOUT_MS = 8000L;

    // ---------------------------------------------------------------- 配色（与壳的深色底一致）

    private static final int COLOR_BAR = 0xFF0F1115;
    private static final int COLOR_PAGE = 0xFFFFFFFF;
    private static final int COLOR_TITLE = 0xFFE6E8EC;
    private static final int COLOR_ACTION = 0xFF8FB4FF;
    private static final int COLOR_HINT = 0xFF8A8F98;

    private final Application application;
    private final ActivityTracker tracker;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final AtomicInteger sessionCounter = new AtomicInteger();

    // 下面这几个都由 UI 线程写、worker 线程读，所以全部 volatile（读的是快照，不加锁）
    private volatile Dialog dialog;
    private volatile WebView webView;
    private volatile TextView titleView;
    private volatile TextView hintView;
    private volatile boolean open;
    private volatile String currentUrl = "";
    private volatile String currentTitle = "";
    private volatile String lastRedirect = "";
    private volatile String mode = MODE_INLINE;
    private volatile int sessionId;

    RemoteAuthHandler(Context context) {
        Context appContext = context == null ? null : context.getApplicationContext();
        Application found = appContext instanceof Application ? (Application) appContext : null;
        this.application = found;
        if (found == null) {
            this.tracker = null;
            Log.w(TAG, "拿不到 Application 上下文：授权容器定位不到 Activity，/open 会直接报错");
            return;
        }
        this.tracker = new ActivityTracker();
        // LocalServer 是在 MainActivity 的主线程上构造的；即使不是，
        // registerActivityLifecycleCallbacks 内部也是 synchronized 的
        found.registerActivityLifecycleCallbacks(tracker);
        Log.i(TAG, "auth container ready");
    }

    /** 服务停止时调用：关窗口 + 注销生命周期回调（不阻塞调用线程）。 */
    void cancelAll() {
        Application registered = application;
        ActivityTracker current = tracker;
        if (registered != null && current != null) {
            try {
                registered.unregisterActivityLifecycleCallbacks(current);
            } catch (RuntimeException ignored) {
                // 已经注销过，忽略
            }
        }
        open = false;
        uiHandler.post(new Runnable() {
            @Override
            public void run() {
                closeDialogQuietly();
            }
        });
        Log.i(TAG, "auth container stopped");
    }

    // ---------------------------------------------------------------- 路由

    /**
     * @return true 表示这条连接必须关闭（与 DbHandler / RemoteWsHandler 的约定一致）
     */
    boolean handle(String method, String path, HttpUtil.Headers headers, InputStream in, OutputStream out,
            boolean keepAlive) throws IOException {
        try {
            return route(method, path, headers, in, out, keepAlive);
        } catch (HttpError refused) {
            // 请求体可能还没读完，一律关连接：残留字节会被当成下一个请求
            Log.w(TAG, path + " -> " + refused.status + " " + refused.getMessage());
            HttpUtil.sendJson(out, refused.status, false, errorJson(refused.getMessage()));
            return true;
        } catch (IOException writeFailed) {
            // 写响应失败（页面已经走了），交给 LocalServer 收尾关连接
            throw writeFailed;
        } catch (Exception failure) {
            // UI / JSON 异常都不能冒泡到 LocalServer，否则整条连接被直接打死
            Log.w(TAG, "auth 接口失败：" + path, failure);
            HttpUtil.sendJson(out, 500, false, errorJson(describe(failure)));
            return true;
        }
    }

    private boolean route(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws IOException, JSONException {
        if (PATH_STATE.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, stateJson(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_OPEN.equals(path)) {
            requirePost(method);
            return openContainer(in, headers, out, keepAlive);
        }

        if (PATH_CLOSE.equals(path)) {
            requirePost(method);
            closeContainer(in, headers, out, keepAlive);
            return !keepAlive;
        }

        HttpUtil.sendJson(out, 404, keepAlive, errorJson("not_found"));
        return !keepAlive;
    }

    // ---------------------------------------------------------------- POST /open

    private boolean openContainer(InputStream in, HttpUtil.Headers headers, OutputStream out,
            boolean keepAlive) throws IOException, JSONException {
        // CSRF 闸门：必须声明 application/json。
        // 恶意网页可以用 no-cors 表单/POST 打 http://127.0.0.1:18888，
        // 但 no-cors 只允许三种 CORS 安全类型（urlencoded / multipart / text/plain），
        // 改成 application/json 会触发预检，而 LocalServer 不响应 CORS，请求发不出来。
        String contentType = headers.get("Content-Type");
        if (contentType == null || contentType.toLowerCase(Locale.US).indexOf("application/json") < 0) {
            throw new HttpError(415, "json_content_type_required");
        }
        JSONObject body = readJsonBody(in, headers);
        String url = trimToEmpty(body.optString("url", body.optString("startUrl", "")));
        String title = trimToEmpty(body.optString("title", ""));
        String serverUrl = trimToEmpty(body.optString("serverUrl", body.optString("server", "")));
        String allowHost = trimToEmpty(body.optString("allowHost", body.optString("allow_host", "")));
        String requestedMode = trimToEmpty(body.optString("mode", MODE_INLINE)).toLowerCase(Locale.US);

        // 校验放在开窗口之前：不允许的地址一个字节都不发出去
        validateUrl(url, serverUrl, allowHost);
        if (title.length() > MAX_TITLE_LENGTH) {
            title = title.substring(0, MAX_TITLE_LENGTH);
        }
        // inline（默认，应用内全屏 WebView）之外都当外部浏览器；browser / tab 是给前端的别名
        if (MODE_EXTERNAL.equals(requestedMode) || "browser".equals(requestedMode)
                || "tab".equals(requestedMode)) {
            requestedMode = MODE_EXTERNAL;
        } else {
            requestedMode = MODE_INLINE;
        }
        int id = beginSession(title, requestedMode);

        if (MODE_EXTERNAL.equals(requestedMode)) {
            OpenOutcome outcome = openExternally(url, id);
            if (outcome.error != null) {
                HttpUtil.sendJson(out, outcome.status, keepAlive, errorJson(outcome.error));
                return !keepAlive;
            }
        } else {
            OpenOutcome outcome = openInline(url, title, id);
            if (outcome.error != null) {
                HttpUtil.sendJson(out, outcome.status, keepAlive, errorJson(outcome.error));
                return !keepAlive;
            }
        }

        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("open", open);
        json.put("mode", mode);
        json.put("id", id);
        json.put("url", currentUrl);
        HttpUtil.sendJson(out, 200, keepAlive, json.toString());
        return !keepAlive;
    }

    /**
     * inline 模式：建（或复用）全屏窗口并加载 URL。
     *
     * <p>工作线程只等「窗口弹出来了没有」，不等用户操作 —— 那是页面轮询 {@code /state}
     * 与 QR 会话的事。
     */
    private OpenOutcome openInline(final String url, final String title, final int id) {
        Activity activity = resumedActivity();
        if (activity == null) {
            Log.w(TAG, "当前没有处于前台的 Activity，无法弹授权窗口");
            return new OpenOutcome(503, "no_foreground_activity");
        }
        final Activity target = activity;
        final CountDownLatch shown = new CountDownLatch(1);
        // 只由 UI 线程写、await 返回后由 worker 线程读（latch 本身提供内存屏障）
        final String[] failure = new String[1];
        target.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    showOrNavigate(target, url, title, id);
                } catch (RuntimeException showFailed) {
                    // BadTokenException / WindowManager 拒绝 / WebView 初始化失败都从这里出去
                    Log.w(TAG, "授权窗口弹不出来", showFailed);
                    failure[0] = "dialog_failed: " + describe(showFailed);
                    // show() 抛异常时窗口可能已经建了一半，先收干净
                    closeDialogQuietly();
                } finally {
                    shown.countDown();
                }
            }
        });
        try {
            if (!shown.await(UI_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "等 UI 线程创建授权窗口超时");
                return new OpenOutcome(500, "ui_timeout");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new OpenOutcome(500, "interrupted");
        }
        if (failure[0] != null) {
            return new OpenOutcome(500, failure[0]);
        }
        return new OpenOutcome(200, null);
    }

    /** external 模式：交系统浏览器。完成后由页面的 QR 轮询收尾，原生不需要状态。 */
    private OpenOutcome openExternally(String url, int id) {
        Activity activity = resumedActivity();
        if (activity == null) {
            return new OpenOutcome(503, "no_foreground_activity");
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            activity.startActivity(intent);
        } catch (ActivityNotFoundException noBrowser) {
            Log.w(TAG, "系统里没有能打开 https 的应用");
            return new OpenOutcome(503, "no_browser");
        } catch (RuntimeException failed) {
            Log.w(TAG, "打开系统浏览器失败", failed);
            return new OpenOutcome(500, "open_external_failed: " + describe(failed));
        }
        open = false;
        currentUrl = url;
        Log.i(TAG, "auth 交给系统浏览器: " + safeLogUrl(url) + " (id=" + id + ")");
        return new OpenOutcome(200, null);
    }

    /** UI 线程：窗口没开就建一个，已经开着就换页面（重试 / 换 provider 都走这条）。 */
    private void showOrNavigate(Activity activity, String url, String title, int id) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            throw new IllegalStateException("activity_not_available");
        }
        String shownTitle = title.length() == 0 ? DEFAULT_TITLE : title;

        if (dialog != null && webView != null) {
            if (titleView != null) {
                titleView.setText(shownTitle);
            }
            currentTitle = shownTitle;
            currentUrl = url;
            sessionId = id;
            open = true;
            setHint(HINT_LOADING);
            webView.loadUrl(url);
            Log.i(TAG, "auth 窗口复用，加载: " + safeLogUrl(url));
            return;
        }
        if (dialog != null) {
            // 有窗口没 WebView 属于中间态（上一次建失败），关掉重来
            closeDialogQuietly();
        }

        Dialog created = new Dialog(activity);
        created.requestWindowFeature(Window.FEATURE_NO_TITLE);
        created.setCanceledOnTouchOutside(false);

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(COLOR_BAR);

        root.addView(buildTitleBar(activity, shownTitle), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        WebView view = new WebView(activity);
        configureWebView(view);
        view.setWebViewClient(new AuthWebViewClient(id));
        // weight=1：占满标题栏与底部提示之间的全部空间
        root.addView(view, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        TextView hint = buildHint(activity);
        root.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        created.setContentView(root);
        created.setOnCancelListener(new DialogInterface.OnCancelListener() {
            @Override
            public void onCancel(DialogInterface ignored) {
                // 返回键 / 点外面 → 关窗口（页面靠 /state 的 open=false 知道用户退出了）
                closeDialogQuietly();
            }
        });
        created.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface ignored) {
                // 任何关闭路径都要落到 open=false，否则页面会以为用户还在登录页。
                // 注意：这里**不能**先把 webView 置空再 disposeWebView()，否则那个 WebView 永远销毁不掉。
                open = false;
                dialog = null;
                hintView = null;
                titleView = null;
                disposeWebView();
            }
        });

        webView = view;
        hintView = hint;
        dialog = created;
        created.show();
        Window window = created.getWindow();
        if (window != null) {
            // Dialog 默认是 wrap_content 的浮层，这里改成整屏
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT);
        }
        currentTitle = shownTitle;
        currentUrl = url;
        sessionId = id;
        open = true;
        setHint(HINT_LOADING);
        view.loadUrl(url);
        Log.i(TAG, "auth 窗口打开: " + safeLogUrl(url) + " (id=" + id + ")");
    }

    private View buildTitleBar(Activity activity, String title) {
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(COLOR_BAR);
        bar.setPadding(dp(activity, 16), dp(activity, 10), dp(activity, 8), dp(activity, 10));

        TextView label = new TextView(activity);
        label.setText(title);
        label.setTextColor(COLOR_TITLE);
        label.setTextSize(16f);
        titleView = label;
        bar.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView close = new TextView(activity);
        close.setText("关闭");
        close.setTextColor(COLOR_ACTION);
        close.setTextSize(15f);
        close.setPadding(dp(activity, 12), dp(activity, 4), dp(activity, 12), dp(activity, 4));
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View ignored) {
                closeDialogQuietly();
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return bar;
    }

    private TextView buildHint(Activity activity) {
        TextView hint = new TextView(activity);
        hint.setText(HINT_DEFAULT);
        hint.setTextColor(COLOR_HINT);
        hint.setTextSize(12f);
        hint.setGravity(Gravity.CENTER);
        hint.setBackgroundColor(COLOR_BAR);
        hint.setPadding(dp(activity, 8), dp(activity, 8), dp(activity, 8), dp(activity, 12));
        return hint;
    }

    /**
     * 授权窗口的 WebView 配置。
     *
     * <p>与 MainActivity 里那个页面 WebView 的差异都有原因：
     * <ul>
     *   <li>Cookie 走 {@code CookieManager} 的默认行为，<b>一个都不清</b>：「已登录就免密」的短路
     *       全靠会话 cookie，清了等于每次都要重新输密码。Cookie 是进程级的，窗口关了再开也还在</li>
     *   <li>文件访问关掉：这个 WebView 只加载远端网页，不需要 {@code file://}</li>
     *   <li>UA 去掉 {@code wv} 标记：能少踩一点"这是 WebView"的探测（Google 仍可能拒，
     *       那种 provider 请用 {@code mode:"external"} 开系统浏览器）</li>
     * </ul>
     */
    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // window.open 留在同一个 WebView 里（部分提供商的账号选择器用弹窗）
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // 固定 100：系统字号/无障碍缩放会把授权页的表单挤变形
        settings.setTextZoom(100);
        String userAgent = settings.getUserAgentString();
        if (userAgent != null && userAgent.length() > 0) {
            settings.setUserAgentString(userAgent.replace("; wv", "").replace(" wv", ""));
        }
        view.setBackgroundColor(COLOR_PAGE);
    }

    /** UI 线程改底部提示；非 UI 线程调用时直接丢掉（提示只是装饰，不值得为它跨线程排队）。 */
    private void setHint(String text) {
        TextView hint = hintView;
        if (hint == null) {
            return;
        }
        hint.setText(text);
    }

    // ---------------------------------------------------------------- POST /close

    private void closeContainer(InputStream in, HttpUtil.Headers headers, OutputStream out,
            boolean keepAlive) throws IOException, JSONException {
        // body 可有可无：有就读掉，别把残留字节留给下一个请求
        readJsonBody(in, headers);
        final boolean wasOpen = open;
        open = false;
        uiHandler.post(new Runnable() {
            @Override
            public void run() {
                closeDialogQuietly();
            }
        });
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("open", false);
        json.put("closed", wasOpen);
        HttpUtil.sendJson(out, 200, keepAlive, json.toString());
        Log.i(TAG, "auth 窗口关闭请求：wasOpen=" + wasOpen);
    }

    // ---------------------------------------------------------------- GET /state

    private String stateJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("open", open);
        json.put("mode", mode);
        json.put("id", sessionId);
        json.put("url", currentUrl);
        json.put("title", currentTitle);
        json.put("lastRedirect", lastRedirect);
        return json.toString();
    }

    // ---------------------------------------------------------------- 会话

    /**
     * 每次 {@code /open} 都开一个新会话号：页面用它判断「现在这个状态是不是我这次开的」，
     * 迟到的旧请求因此不会把新会话认成自己的。
     */
    private int beginSession(String title, String requestedMode) {
        int id = sessionCounter.incrementAndGet();
        sessionId = id;
        mode = requestedMode;
        currentTitle = title.length() == 0 ? DEFAULT_TITLE : title;
        // 上一次的残留状态（尤其是 lastRedirect 里的 URL）不能带进新会话
        currentUrl = "";
        lastRedirect = "";
        open = false;
        return id;
    }

    /** 记录被拦下的非 https 跳转（服务器仍可能回跳 {@code dshremote://oauth?token=…}）。 */
    private void recordRedirect(String url) {
        lastRedirect = url == null ? "" : url;
        setHint("已拦截跳转：" + describeScheme(url));
    }

    private static String describeScheme(String url) {
        if (url == null || url.length() == 0) {
            return "（空）";
        }
        int colon = url.indexOf(':');
        if (colon <= 0) {
            return "（未知）";
        }
        return url.substring(0, colon + 1);
    }

    // ---------------------------------------------------------------- WebView 回调

    /**
     * 窗口里的导航策略：<b>只放行 https</b>，其余一律吞掉并记录。
     *
     * <p>{@code dshremote:} 是唯一的"正常会被吞掉"的情况：服务器可能仍然按
     * {@code return_to=dshremote://oauth} 回跳，导航过去只会让 WebView 显示一张错误页，
     * 所以拦住并把 URL 记进 {@code /state.lastRedirect}（页面可以自己决定要不要用它）。
     */
    private final class AuthWebViewClient extends WebViewClient {

        private final int expectedSession;

        AuthWebViewClient(int expectedSession) {
            this.expectedSession = expectedSession;
        }

        /** API 24+ 走这个签名。 */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            return handleNavigation(uri == null ? null : uri.toString(), request != null
                    && request.isForMainFrame());
        }

        /**
         * 旧签名：API &lt; 24 才会被回调（本工程 minSdk 28，实际走不到）。
         * 保留它是为了对称性：不同 ROM 的 WebView 实现对重载的选择并不完全一致。
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(url, true);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (url == null || url.length() == 0) {
                return;
            }
            currentUrl = url;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && url.length() > 0) {
                currentUrl = url;
            }
            setHint(HINT_DEFAULT);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) {
                // 子资源加载失败不影响用户登录
                return;
            }
            String description = error == null || error.getDescription() == null
                    ? "load_failed"
                    : error.getDescription().toString();
            Log.w(TAG, "授权页加载失败: " + description);
            if (isCurrentSession(expectedSession)) {
                // 只改提示：窗口还开着，不能把 open 改成 false（那会让页面误以为用户退出了）
                setHint("加载失败：" + description);
            }
        }

        /**
         * @return true 表示这次导航被本类接管（不再交给 WebView）
         */
        private boolean handleNavigation(String url, boolean mainFrame) {
            if (url == null || url.length() == 0) {
                return false;
            }
            String lower = url.toLowerCase(Locale.US);
            if (lower.startsWith("https://")) {
                // 正常路径：第三方登录的整条链路都放行
                if (mainFrame) {
                    currentUrl = url;
                }
                return false;
            }
            if (isCurrentSession(expectedSession)) {
                recordRedirect(url);
            }
            // 不带 query 打日志：回调 URL 里可能有一次性 token
            Log.i(TAG, "已拦截非 https 跳转: " + safeLogUrl(url));
            return true;
        }

        private boolean isCurrentSession(int id) {
            return sessionId == id;
        }
    }

    // ---------------------------------------------------------------- URL 校验

    private static void validateUrl(String url, String serverUrl, String allowHost) {
        if (url.length() == 0) {
            throw new HttpError(400, "url_required");
        }
        if (url.length() > MAX_URL_LENGTH) {
            throw new HttpError(400, "url_too_long");
        }
        if (hasControlChar(url)) {
            throw new HttpError(400, "url_bad_char");
        }
        Uri uri;
        try {
            uri = Uri.parse(url);
        } catch (RuntimeException broken) {
            throw new HttpError(400, "url_invalid");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            // 只接受 https：登录页走明文等于把授权码摊在网上
            throw new HttpError(400, "https_required");
        }
        String host = uri.getHost();
        if (host == null || host.length() == 0) {
            throw new HttpError(400, "host_required");
        }
        if (uri.getUserInfo() != null) {
            // https://evil@real-host/… 这种写法容易骗过人工核对
            throw new HttpError(400, "userinfo_not_allowed");
        }

        if (serverUrl.length() > 0) {
            Uri server = parseServerUrl(serverUrl);
            if (!sameOrigin(uri, server)) {
                // 防止被当成「任意网页打开器」
                throw new HttpError(403, "cross_origin_rejected");
            }
            return;
        }
        if (allowHost.length() > 0) {
            if (!hostAllowed(uri, allowHost)) {
                throw new HttpError(403, "host_not_allowed");
            }
            return;
        }
        // 两个都没传：只能退一步做保守校验（页面最好还是传 serverUrl）
        if (isPrivateHost(host)) {
            throw new HttpError(403, "private_host_rejected");
        }
    }

    private static Uri parseServerUrl(String serverUrl) {
        if (hasControlChar(serverUrl)) {
            throw new HttpError(400, "server_url_bad_char");
        }
        Uri server;
        try {
            server = Uri.parse(serverUrl);
        } catch (RuntimeException broken) {
            throw new HttpError(400, "server_url_invalid");
        }
        if (!"https".equalsIgnoreCase(server.getScheme())) {
            throw new HttpError(400, "server_url_https_required");
        }
        if (server.getHost() == null || server.getHost().length() == 0) {
            throw new HttpError(400, "server_url_invalid");
        }
        return server;
    }

    private static boolean sameOrigin(Uri left, Uri right) {
        if (left == null || right == null) {
            return false;
        }
        if (!equalsIgnoreCaseSafe(left.getScheme(), right.getScheme())) {
            return false;
        }
        if (!equalsIgnoreCaseSafe(left.getHost(), right.getHost())) {
            return false;
        }
        return effectivePort(left) == effectivePort(right);
    }

    /** host 白名单：支持 {@code a.com,b.com:8443} 这种写法；带不带默认端口都算命中。 */
    private static boolean hostAllowed(Uri uri, String allowHost) {
        String host = uri.getHost();
        if (host == null) {
            return false;
        }
        String lowerHost = host.toLowerCase(Locale.US);
        int port = effectivePort(uri);
        String hostWithPort = port > 0 ? lowerHost + ":" + port : lowerHost;
        String[] entries = allowHost.split(",");
        for (int i = 0; i < entries.length; i++) {
            String entry = entries[i].trim().toLowerCase(Locale.US);
            if (entry.length() == 0) {
                continue;
            }
            if (entry.equals(lowerHost) || entry.equals(hostWithPort)) {
                return true;
            }
        }
        return false;
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        if (port > 0) {
            return port;
        }
        if ("https".equalsIgnoreCase(uri.getScheme())) {
            return 443;
        }
        if ("http".equalsIgnoreCase(uri.getScheme())) {
            return 80;
        }
        return -1;
    }

    /** 域名/IPv4 字面量里明显指向本机或内网的地址（没传 serverUrl / allowHost 时才用得上）。 */
    private static boolean isPrivateHost(String host) {
        String lower = host.toLowerCase(Locale.US);
        if ("localhost".equals(lower) || lower.endsWith(".localhost")
                || lower.endsWith(".local") || lower.endsWith(".internal")) {
            return true;
        }
        if (lower.indexOf('[') >= 0 || lower.indexOf(':') >= 0) {
            // IPv6 字面量：::1 / ULA / 链路本地都在这一档
            return true;
        }
        int[] octets = parseIpv4(lower);
        if (octets == null) {
            return false;
        }
        int first = octets[0];
        int second = octets[1];
        if (first == 0 || first == 10 || first == 127) {
            return true;
        }
        if (first == 169 && second == 254) {
            return true;
        }
        if (first == 172 && second >= 16 && second <= 31) {
            return true;
        }
        if (first == 192 && second == 168) {
            return true;
        }
        // 100.64/10：运营商级 NAT，也不该被当成公网
        return first == 100 && second >= 64 && second <= 127;
    }

    private static int[] parseIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) {
            return null;
        }
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                octets[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException notIp) {
                return null;
            }
            if (octets[i] < 0 || octets[i] > 255) {
                return null;
            }
        }
        return octets;
    }

    private static boolean hasControlChar(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 0x20 || c == 0x7F) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 窗口生命周期（均在 UI 线程）

    private void closeDialogQuietly() {
        Dialog current = dialog;
        if (current == null) {
            open = false;
            return;
        }
        try {
            if (current.isShowing()) {
                current.dismiss();
            } else {
                // 没显示过就没人收尾，自己清理
                cleanupAfterDismiss();
            }
        } catch (RuntimeException ignored) {
            // 窗口可能已经被系统回收掉了
            cleanupAfterDismiss();
        }
    }

    /** onDismiss 之外的第二条清理路径（窗口还没 show 就失败时走这条）。 */
    private void cleanupAfterDismiss() {
        open = false;
        dialog = null;
        hintView = null;
        titleView = null;
        disposeWebView();
    }

    /**
     * 销毁 WebView。{@code destroy()} 不能在它自己的回调栈里调，推到主线程下一拍。
     * （Cookie 不受影响：它在 {@code CookieManager} 里，是进程级的。）
     */
    private void disposeWebView() {
        final WebView disposed = webView;
        webView = null;
        if (disposed == null) {
            return;
        }
        try {
            disposed.stopLoading();
        } catch (RuntimeException ignored) {
            // 已经销毁
        }
        uiHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (disposed.getParent() instanceof ViewGroup) {
                        ((ViewGroup) disposed.getParent()).removeView(disposed);
                    }
                    disposed.destroy();
                } catch (RuntimeException ignored) {
                    // 销毁失败没有补救手段
                }
            }
        });
    }

    // ---------------------------------------------------------------- Activity 追踪

    private Activity resumedActivity() {
        ActivityTracker current = tracker;
        return current == null ? null : current.resumedActivity();
    }

    /** 只跟踪「当前 resumed 的那个 Activity」：LocalServer 拿到的是 Application context。 */
    private static final class ActivityTracker implements Application.ActivityLifecycleCallbacks {

        private final AtomicReference<Activity> resumed = new AtomicReference<Activity>();

        Activity resumedActivity() {
            Activity current = resumed.get();
            if (current == null) {
                return null;
            }
            if (current.isFinishing() || current.isDestroyed()) {
                resumed.compareAndSet(current, null);
                return null;
            }
            return current;
        }

        @Override
        public void onActivityCreated(Activity activity, Bundle savedInstanceState) {
            // 只关心 resume：创建阶段窗口还不一定能弹
        }

        @Override
        public void onActivityStarted(Activity activity) {
            // 同上
        }

        @Override
        public void onActivityResumed(Activity activity) {
            resumed.set(activity);
        }

        @Override
        public void onActivityPaused(Activity activity) {
            resumed.compareAndSet(activity, null);
        }

        @Override
        public void onActivityStopped(Activity activity) {
            resumed.compareAndSet(activity, null);
        }

        @Override
        public void onActivitySaveInstanceState(Activity activity, Bundle outState) {
            // 不需要保存任何东西
        }

        @Override
        public void onActivityDestroyed(Activity activity) {
            resumed.compareAndSet(activity, null);
        }
    }

    // ---------------------------------------------------------------- 请求体

    private static JSONObject readJsonBody(InputStream in, HttpUtil.Headers headers)
            throws IOException {
        byte[] body = readBody(in, headers);
        if (body.length == 0) {
            return new JSONObject();
        }
        try {
            return new JSONObject(new String(body, StandardCharsets.UTF_8));
        } catch (JSONException broken) {
            throw new HttpError(400, "invalid_json");
        }
    }

    /** 按 Content-Length 读完整请求体；超限 413，短读 400。 */
    private static byte[] readBody(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            // 页面发的都是定长 JSON，chunked 只可能来自异常客户端
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared > MAX_BODY_BYTES) {
            throw new HttpError(413, "payload_too_large");
        }
        if (declared <= 0L) {
            return new byte[0];
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.min(declared, 4096L));
        byte[] chunk = new byte[READ_BUFFER_BYTES];
        long remaining = declared;
        while (remaining > 0L) {
            int want = (int) Math.min((long) chunk.length, remaining);
            int read = in.read(chunk, 0, want);
            if (read == -1) {
                throw new HttpError(400, "body_truncated");
            }
            buffer.write(chunk, 0, read);
            remaining -= read;
            if (buffer.size() > MAX_BODY_BYTES) {
                throw new HttpError(413, "payload_too_large");
            }
        }
        return buffer.toByteArray();
    }

    private static boolean isChunked(HttpUtil.Headers headers) {
        String transferEncoding = headers.get("Transfer-Encoding");
        return transferEncoding != null
                && transferEncoding.toLowerCase(Locale.US).indexOf("chunked") >= 0;
    }

    private static long parseContentLength(String value) {
        if (value == null) {
            return -1L;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException ignored) {
            return -1L;
        }
    }

    // ---------------------------------------------------------------- 小工具

    private static final class OpenOutcome {

        private final int status;
        private final String error;

        OpenOutcome(int status, String error) {
            this.status = status;
            this.error = error;
        }
    }

    private static String errorJson(String error) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(error) + "}";
    }

    private static void requireReadOnly(String method) {
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            throw new HttpError(405, "method_not_allowed");
        }
    }

    private static void requirePost(String method) {
        if (!"POST".equals(method)) {
            throw new HttpError(405, "method_not_allowed");
        }
    }

    private static String trimToEmpty(String value) {
        return value == null ? "" : value.trim();
    }

    private static boolean equalsIgnoreCaseSafe(String left, String right) {
        if (left == null) {
            return right == null;
        }
        return left.equalsIgnoreCase(right);
    }

    /**
     * 日志里只留 scheme+host+path。
     *
     * <p>注意这里<b>不是</b> simple 的"截掉 query"：{@code dshremote://oauth?token=…} 这种
     * 自定义 scheme 的 URL 被 {@code java.net.URI} 当成 opaque 处理，所以只用字符扫描。
     */
    private static String safeLogUrl(String url) {
        if (url == null || url.length() == 0) {
            return "";
        }
        int cut = url.length();
        int query = url.indexOf('?');
        if (query >= 0 && query < cut) {
            cut = query;
        }
        int fragment = url.indexOf('#');
        if (fragment >= 0 && fragment < cut) {
            cut = fragment;
        }
        return url.substring(0, cut);
    }

    private static int dp(Activity activity, int value) {
        if (activity == null) {
            return value;
        }
        float density = activity.getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }

    private static String describe(Throwable error) {
        if (error == null) {
            return "unknown_error";
        }
        String message = error.getMessage();
        String type = error.getClass().getSimpleName();
        if (message == null || message.trim().isEmpty()) {
            return type;
        }
        return type + ": " + message;
    }

    /** 带 HTTP 状态码的处理失败；在 handle 里统一转成 JSON。 */
    private static final class HttpError extends RuntimeException {

        private final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
