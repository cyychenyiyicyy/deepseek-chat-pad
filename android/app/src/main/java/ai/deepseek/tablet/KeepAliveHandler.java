package ai.deepseek.tablet;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * /__ds_keepalive/* 的实现：后台保活与「7788 权限」的原生口子。
 *
 * <p>页面同源直接 fetch，不需要任何额外权限。接口一览：
 * <pre>
 * POST /__ds_keepalive/start     {}   起前台服务 + （13+ 未授予时）申请通知权限
 * POST /__ds_keepalive/stop      {}   停前台服务（并清掉「应当保活」标志）
 * GET  /__ds_keepalive/state          {ok, running, shouldRun, notificationsGranted, batteryExempt, sdkInt}
 * POST /__ds_keepalive/battery   {}   拉起系统「忽略电池优化」授权页，并回当前是否已豁免
 * GET  /__ds_keepalive/state.json     与 /state 同响应，**能力探测别名**，见下
 * </pre>
 *
 * <p>能力探测为什么需要 {@code /state.json} 这个别名：旧 APK 没有这些路由，请求会掉到
 * {@link AssetHandler}，而它有一层「最后一段没有扩展名就回落 index.html」的 SPA 兜底
 * （单页应用刷新 404 太难看）。也就是说旧 APK 对 {@code /__ds_keepalive/state} 会回
 * <b>200 + 一段 HTML</b>，而不是 404 —— 页面若只判断 HTTP 状态码就会误以为壳支持保活。
 * 带扩展名的路径不会触发兜底（{@code AssetHandler.spaFallback} 明确放行带点的路径），
 * 所以探测请用 {@code GET /__ds_keepalive/state.json}：<b>旧 APK 真 404，新 APK 真 JSON</b>。
 *
 * <p>约定（与 DbHandler / RemoteWsHandler / RemoteAuthHandler 一致）：
 * <ul>
 *   <li>一律 JSON，统一 {@code {"ok":true,...}} / {@code {"ok":false,"error":"..."}}</li>
 *   <li>POST 先把请求体按 Content-Length 读干净（上限 {@link #MAX_BODY_BYTES}）再回包：
 *       不读就关连接，内核会发 RST，Chromium 可能把已经写出去的响应也算作失败</li>
 *   <li>任何异常都在 {@link #handle} 里兜成 JSON 5xx，绝不让它冒到 LocalServer 把连接打死</li>
 *   <li>本类<b>不</b>在后台线程里碰 UI：要弹权限框/系统页面的都挪到主线程，
 *       且必须拿到「当前 resumed 的 Activity」（LocalServer 拿到的是 Application context）</li>
 * </ul>
 */
final class KeepAliveHandler {

    private static final String TAG = "DsKeepAlive";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_keepalive/";

    private static final String PATH_START = "/__ds_keepalive/start";
    private static final String PATH_STOP = "/__ds_keepalive/stop";
    private static final String PATH_STATE = "/__ds_keepalive/state";
    /** 能力探测别名：带扩展名，旧 APK 会真 404（原因见类注释） */
    private static final String PATH_STATE_PROBE = "/__ds_keepalive/state.json";
    private static final String PATH_BATTERY = "/__ds_keepalive/battery";

    /** 这几个接口的请求体只可能是空或一个极小的 JSON */
    private static final int MAX_BODY_BYTES = 8 * 1024;
    private static final int READ_BUFFER_BYTES = 1024;

    /** 申请通知权限的 requestCode。与 MainActivity 的 4712 刻意错开，不会互相覆盖回调 */
    static final int REQUEST_CODE_NOTIFICATIONS = 4713;

    private final Application application;
    private final ActivityTracker tracker;
    /**
     * 本次进程是否已经问过通知权限。页面每次重连都会调 /start，不设这个闸门就会反复弹框
     * （Android 13 在用户拒绝两次后虽然会静默拒绝，但那时再调也是白调）。
     * 与 MainActivity 的一次性标志（跨安装）配合，总弹框次数被限制在 2 次以内。
     */
    private final AtomicBoolean notificationAsked = new AtomicBoolean(false);

    KeepAliveHandler(Context context) {
        Context appContext = context == null ? null : context.getApplicationContext();
        Application found = appContext instanceof Application ? (Application) appContext : null;
        this.application = found;
        if (found == null) {
            // 没有 Application 也能干活（服务用 Application context 起，权限框那几路会退化成
            // 「后台不允许弹」，页面拿 running/notificationsGranted 照样能判断）
            this.tracker = null;
            Log.w(TAG, "拿不到 Application 上下文：保活仍可用，但权限弹窗会退化");
            return;
        }
        this.tracker = new ActivityTracker();
        // LocalServer 是在 MainActivity 的主线程上构造的；即使不是，
        // registerActivityLifecycleCallbacks 内部也是 synchronized 的
        found.registerActivityLifecycleCallbacks(tracker);
        Log.i(TAG, "keep-alive 接口就绪");
    }

    /** 服务停止时调用：注销生命周期回调（不阻塞调用线程，幂等）。 */
    void cancelAll() {
        Application registered = application;
        ActivityTracker current = tracker;
        if (registered == null || current == null) {
            return;
        }
        try {
            registered.unregisterActivityLifecycleCallbacks(current);
        } catch (RuntimeException ignored) {
            // 已经注销过，忽略
        }
        Log.i(TAG, "keep-alive 接口停止");
    }

    // ---------------------------------------------------------------- 路由

    /**
     * 参数形状与 DbHandler 的调用点一致（这里的接口都没有查询参数，所以不需要原始 target）。
     *
     * @return true 表示这条连接必须关闭（与其它 handler 的约定一致）
     */
    boolean handle(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws IOException {
        try {
            return route(method, path, headers, in, out, keepAlive);
        } catch (HttpError refused) {
            // 请求体可能没读完，一律关连接：残留字节会被当成下一个请求
            Log.w(TAG, path + " -> " + refused.status + " " + refused.getMessage());
            HttpUtil.sendJson(out, refused.status, false, errorJson(refused.getMessage()));
            return true;
        } catch (IOException writeFailed) {
            // 写响应失败（页面已经走了），交给 LocalServer 收尾关连接
            throw writeFailed;
        } catch (Exception failure) {
            // 起服务 / 权限 / JSON 的异常都不能冒泡到 LocalServer
            Log.w(TAG, "keepalive 接口失败：" + path, failure);
            HttpUtil.sendJson(out, 500, false, errorJson(describe(failure)));
            return true;
        }
    }

    private boolean route(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws Exception {
        if (PATH_STATE.equals(path) || PATH_STATE_PROBE.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, stateJson(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_START.equals(path)) {
            requirePost(method);
            // 先把请求体读干净（页面可能带 {}），再动手，最后回包
            readBody(in, headers);
            boolean started = startKeepAlive();
            HttpUtil.sendJson(out, 200, keepAlive, stateJson(started), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_STOP.equals(path)) {
            requirePost(method);
            readBody(in, headers);
            stopKeepAlive();
            HttpUtil.sendJson(out, 200, keepAlive, stateJson(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_BATTERY.equals(path)) {
            requirePost(method);
            readBody(in, headers);
            boolean launched = requestBatteryExemption();
            JSONObject json = stateObject();
            json.put("launched", launched);
            HttpUtil.sendJson(out, 200, keepAlive, json.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        // 旧 APK 的 SPA 回落会把未知路径回成 index.html，所以未知子路径给 404 是有意义的：
        // 新 APK 上路径打错（或未来版本删了接口）页面能立刻看出来
        throw new HttpError(404, "not_found");
    }

    // ---------------------------------------------------------------- 动作

    /**
     * 起前台服务；Android 13+ 顺手要一次通知权限。
     *
     * @return 这次调用有没有把服务拉起来（false = 系统拒绝，例如后台启动受限）
     */
    private boolean startKeepAlive() {
        Context app = application;
        if (app == null) {
            throw new HttpError(500, "no_context");
        }
        // 先要权限：没授予时前台服务仍能跑，但常驻通知不显示，用户不知道后台有东西在动
        ensureNotificationPermission();
        return RemoteKeepAliveService.start(app);
    }

    private void stopKeepAlive() {
        Context app = application;
        if (app == null) {
            throw new HttpError(500, "no_context");
        }
        RemoteKeepAliveService.stop(app);
    }

    /**
     * 拉起系统「忽略电池优化」授权页。
     *
     * <p>为什么必须由页面触发：这个 Intent 一旦从后台发出会被系统拦（Android 10+ 限制后台
     * 弹 Activity），而它又是国产 ROM 上「后台还是被杀」的头号原因。
     *
     * <p>响应里的 {@code batteryExempt} 是<b>拉起来之前</b>那一刻的状态：用户在白名单页点完
     * 「允许」后，页面应在 {@code visibilitychange} / 回到前台时重新 {@code GET /state} 拿最新值。
     *
     * @return true 表示系统页面已经拉起（不等于用户已经点了允许）
     */
    private boolean requestBatteryExemption() {
        Context app = application;
        if (app == null) {
            throw new HttpError(500, "no_context");
        }
        // 首选：直接定位到本应用那一项（系统会弹「允许忽略电池优化吗」）。
        // 必须带 package: 的 data，否则系统直接抛 ActivityNotFoundException
        Intent scoped = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        scoped.setData(Uri.parse("package:" + app.getPackageName()));
        if (launchSystemPage(scoped)) {
            return true;
        }
        // 兜底：部分 ROM 会忽略带 package 的那条 ACTION，只能打开「电池优化」列表让用户自己找
        Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        if (launchSystemPage(list)) {
            return true;
        }
        Log.w(TAG, "系统里没有电池优化相关设置页");
        return false;
    }

    /** 拉起一个系统设置页：有前台 Activity 就借它，没有就 Application context + NEW_TASK 试一把。 */
    private boolean launchSystemPage(Intent intent) {
        Intent request = new Intent(intent);
        // 统一走 NEW_TASK：从 Application context 起必须带，从 Activity 起也只是多开一个任务，
        // 用户按返回键回到对话页，行为一致
        request.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = resumedActivity();
        try {
            if (activity != null) {
                activity.startActivity(request);
            } else if (application != null) {
                // 没有前台的 Activity（极少见）：应用还在前台时系统仍会放行；
                // 真被拦了（Android 10+ 限制后台弹 Activity）也只是返回 false
                application.startActivity(request);
            } else {
                return false;
            }
            Log.i(TAG, "已拉起系统页面：" + request.getAction());
            return true;
        } catch (ActivityNotFoundException noSettingsPage) {
            Log.w(TAG, "系统没有这个设置页：" + request.getAction());
            return false;
        } catch (RuntimeException failed) {
            // 厂商 ROM 会改这些 Activity 的权限/存在性；退化成「不崩、返回 false」
            Log.w(TAG, "拉起系统页面失败：" + request.getAction(), failed);
            return false;
        }
    }

    /** Android 13+ 的通知权限：没授予就借当前 Activity 要一次。 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // 12 及以下没有这个运行时权限
            return;
        }
        final Context app = application;
        if (app == null) {
            return;
        }
        if (RemoteKeepAliveService.isNotificationAllowed(app)) {
            return;
        }
        Activity activity = resumedActivity();
        if (activity == null) {
            // 应用不在前台：系统不允许后台弹权限框。留给 MainActivity 下次 onResume 申请
            // （那边有一次性标志，不会反复骚扰用户）
            Log.i(TAG, "当前没有前台的 Activity，通知权限交给 onResume 补申请");
            return;
        }
        final Activity target = activity;
        if (!notificationAsked.compareAndSet(false, true)) {
            // 本次进程已经问过：用户拒绝后不再反复弹
            return;
        }
        // 工作线程不能直接 requestPermissions：丢回主线程，且不等结果（页面从 /state 读真实值）
        target.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    target.requestPermissions(
                            new String[] {Manifest.permission.POST_NOTIFICATIONS},
                            REQUEST_CODE_NOTIFICATIONS);
                    Log.i(TAG, "已申请通知权限");
                } catch (RuntimeException failed) {
                    Log.w(TAG, "申请通知权限失败", failed);
                }
            }
        });
    }

    // ---------------------------------------------------------------- 状态

    private String stateJson() throws JSONException {
        return stateJson(null);
    }

    /**
     * @param startedOverride /start 这次的实际结果；null 表示只读服务当前状态
     */
    private String stateJson(Boolean startedOverride) throws JSONException {
        JSONObject json = stateObject();
        if (startedOverride != null) {
            json.put("started", startedOverride.booleanValue());
        }
        return json.toString();
    }

    private JSONObject stateObject() throws JSONException {
        Context app = application;
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("running", RemoteKeepAliveService.isRunning());
        // 额外字段：页面据此区分「用户配过保活但服务被系统清了」（true+false = 该自愈）
        json.put("shouldRun", app != null && RemoteKeepAliveService.shouldRun(app));
        json.put("notificationsGranted",
                app != null && RemoteKeepAliveService.isNotificationAllowed(app));
        json.put("batteryExempt", app != null && RemoteKeepAliveService.isBatteryExempt(app));
        json.put("sdkInt", Build.VERSION.SDK_INT);
        return json;
    }

    // ---------------------------------------------------------------- 请求体

    /** 把请求体读完丢掉（内容不用）；超限/分块一律 4xx。 */
    private static void readBody(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            // 页面发的是定长（空体或一个小 JSON），chunked 只可能来自异常客户端
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared <= 0L) {
            return;
        }
        if (declared > MAX_BODY_BYTES) {
            // 不读完就回包：HTTP 允许在发完响应后关连接，这里会走到 "必须关连接" 的分支
            throw new HttpError(413, "payload_too_large");
        }
        byte[] buffer = new byte[READ_BUFFER_BYTES];
        long remaining = declared;
        while (remaining > 0L) {
            int want = (int) Math.min((long) buffer.length, remaining);
            int read = in.read(buffer, 0, want);
            if (read == -1) {
                throw new HttpError(400, "body_truncated");
            }
            remaining -= read;
        }
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

    private static boolean isChunked(HttpUtil.Headers headers) {
        String transferEncoding = headers.get("Transfer-Encoding");
        return transferEncoding != null
                && transferEncoding.toLowerCase(Locale.US).contains("chunked");
    }

    // ---------------------------------------------------------------- Activity 追踪

    private Activity resumedActivity() {
        ActivityTracker current = tracker;
        return current == null ? null : current.resumedActivity();
    }

    /**
     * 只跟踪「当前 resumed 的那个 Activity」：LocalServer 拿到的是 Application context。
     *
     * <p>与 {@code RemoteAuthHandler.ActivityTracker} 是同一个思路、同一套取舍 —— 那个是
     * private 内部类，本次改动范围又不允许动那个文件，所以只能各留一份（两份都很短，
     * 都只读 resumed 快照，不会互相干扰）。
     */
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

    // ---------------------------------------------------------------- 小工具

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

    private static String describe(Throwable error) {
        if (error == null) {
            return "unknown_error";
        }
        String message = error.getMessage();
        if (message != null && !message.trim().isEmpty()) {
            return message.trim();
        }
        return error.getClass().getSimpleName();
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
