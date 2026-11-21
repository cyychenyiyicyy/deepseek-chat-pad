package ai.deepseek.tablet;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * /__ds_keepalive/* 的实现：从「远程连接保活」扩成通用的「后台与权限」中心。
 *
 * <p><b>为什么扩</b>：用户反馈「这个保护不应该放在远程连接里面，应该放在通用设置里面，
 * 因为除了远程连接，其他也需要保护」。「通用设置」要一格一格地管常见权限（通知、省电、
 * 自启动、精确闹钟、悬浮窗、应用详情、流量），所以本类从「远程连接专用的保活口子」
 * 升级成一份通用的权限状态中心：同一套路由既服务远程连接面板（旧路由一字不改），
 * 也服务通用设置（新增 permissions.json / open / notify）。
 *
 * <p><b>接口一览</b>（带「旧」的接口行为完全不变，现有页面可以继续用）：
 * <pre>
 * POST /__ds_keepalive/start          {}            旧：起前台服务 +（13+ 未授予时）申请通知权限
 * POST /__ds_keepalive/stop           {}            旧：停前台服务（并清掉「应当保活」标志）
 * GET  /__ds_keepalive/state                        旧：{ok,running,shouldRun,notificationsGranted,batteryExempt,sdkInt}
 * GET  /__ds_keepalive/state.json                   旧：与 /state 同响应，能力探测别名（见下）
 * POST /__ds_keepalive/battery        {}            旧：拉起「忽略电池优化」页，回 launched + state 全部字段
 * GET  /__ds_keepalive/permissions.json            新：权限中心快照（所有格子一次给全）
 * GET  /__ds_keepalive/permissions                 新：同上，无扩展名别名（仅供本机调试）
 * POST /__ds_keepalive/open           {target,mode?} 新：跳到某个权限的系统设置页
 * POST /__ds_keepalive/notify         {enabled}    新：常驻通知开/关（false 只降级文案，绝不撤服务）
 * </pre>
 *
 * <p><b>为什么需要 {@code .json} 这个别名</b>：旧 APK 没有这些路由，请求会掉到
 * {@link AssetHandler}，而它有一层「最后一段没有扩展名就回落 index.html」的 SPA 兜底
 * （单页应用刷新 404 太难看）。也就是说旧 APK 对 {@code /__ds_keepalive/permissions} 会回
 * <b>200 + 一段 HTML</b>，而不是 404 —— 页面若只判断 HTTP 状态码就会误以为壳支持权限中心。
 * 带扩展名的路径不会触发兜底（{@code AssetHandler.spaFallback} 明确放行带点的路径），
 * 所以探测请用 {@code GET /__ds_keepalive/permissions.json}：<b>旧 APK 真 404，新 APK 真 JSON</b>。
 *
 * <p><b>约定</b>（与 DbHandler / RemoteWsHandler / RemoteAuthHandler 一致）：
 * <ul>
 *   <li>一律 JSON，统一 {@code {"ok":true,...}} / {@code {"ok":false,"error":"..."}}</li>
 *   <li>POST 先把请求体按 Content-Length 读干净（上限 {@link #MAX_BODY_BYTES}）再回包：
 *       不读就关连接，内核会发 RST，Chromium 可能把已经写出去的响应也算作失败</li>
 *   <li>任何异常都在 {@link #handle} 里兜成 JSON 5xx，绝不让它冒到 LocalServer 把连接打死</li>
 *   <li>本类<b>不</b>在后台线程里碰 UI：要弹权限框/系统页面的都挪到主线程，
 *       且必须拿到「当前 resumed 的 Activity」（LocalServer 拿到的是 Application context）</li>
 *   <li>「系统里没有这个设置页」属于业务结果（HTTP 200 + {@code ok:false} + {@code fallback}），
 *       不是协议错误；协议错误（方法不对、请求体坏了）才用 4xx</li>
 * </ul>
 *
 * <p><b>权限数据的读法</b>：全部走「能读到就报真值，读不到就报 false」的保守策略，
 * 每一处都单独 try/catch —— 一个厂商 ROM 把某个 API 魔改了，也只该让那一格显示「未开启」，
 * 不能让整份快照 500。
 */
final class KeepAliveHandler {

    private static final String TAG = "DsKeepAlive";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_keepalive/";

    // ---------------------------------------------------------------- 旧路由（行为不变）

    private static final String PATH_START = "/__ds_keepalive/start";
    private static final String PATH_STOP = "/__ds_keepalive/stop";
    private static final String PATH_STATE = "/__ds_keepalive/state";
    /** 能力探测别名：带扩展名，旧 APK 会真 404（原因见类注释） */
    private static final String PATH_STATE_PROBE = "/__ds_keepalive/state.json";
    private static final String PATH_BATTERY = "/__ds_keepalive/battery";

    // ---------------------------------------------------------------- 权限中心新路由

    private static final String PATH_PERMISSIONS = "/__ds_keepalive/permissions";
    /** 能力探测别名：带扩展名，旧 APK 真 404（原因见类注释） */
    private static final String PATH_PERMISSIONS_PROBE = "/__ds_keepalive/permissions.json";
    private static final String PATH_OPEN = "/__ds_keepalive/open";
    private static final String PATH_NOTIFY = "/__ds_keepalive/notify";

    /** POST /open 允许的 target（白名单，见 {@link #normalizeTarget}） */
    private static final String TARGET_NOTIFICATIONS = "notifications";
    private static final String TARGET_BATTERY = "battery";
    private static final String TARGET_APP_DETAILS = "appDetails";
    private static final String TARGET_AUTO_START = "autoStart";
    private static final String TARGET_EXACT_ALARM = "exactAlarm";
    private static final String TARGET_OVERLAY = "overlay";
    private static final String TARGET_DATA_USAGE = "dataUsage";

    /** POST /open 的 mode：只对 notifications 有意义，request = 直接弹运行时权限框 */
    private static final String MODE_REQUEST = "request";

    /** 厂商标识：autoStart 的跳转目标按厂商分支 */
    private static final String VENDOR_XIAOMI = "xiaomi";
    private static final String VENDOR_HUAWEI = "huawei";
    private static final String VENDOR_OPPO = "oppo";
    private static final String VENDOR_VIVO = "vivo";
    private static final String VENDOR_SAMSUNG = "samsung";
    private static final String VENDOR_OTHER = "other";

    /**
     * 各家「自启动 / 后台启动管理」页的组件名。
     *
     * <p>厂商 ROM 改包名与类名是常态（同一个小米型号换个 MIUI 版本就可能找不到），
     * 所以每家给多个候选，按顺序试，第一个能打开的算数；全挂就回
     * {@code {ok:false,error:"intent_unavailable",fallback:"appDetails"}}，由页面决定要不要
     * 退到应用详情页（详情页里其实没有自启动开关，自动跳过去反而像「点错了」，
     * 所以这里不自动降级，这一点与其它 target 相反）。
     */
    private static final String[][] AUTO_START_COMPONENTS = {
        // 小米：安全中心 → 应用管理 → 权限 → 自启动
        {VENDOR_XIAOMI, "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"},
        // 华为/荣耀：手机管家 → 应用启动管理（两个类名都在不同 EMUI 版本上出现过）
        {VENDOR_HUAWEI, "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
        {VENDOR_HUAWEI, "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupAppControlActivity"},
        {VENDOR_HUAWEI, "com.huawei.systemmanager",
                "com.huawei.systemmanager.optimize.process.ProtectActivity"},
        // OPPO / realme / 一加（ColorOS）：手机管家 → 权限隐私 → 自启动管理
        {VENDOR_OPPO, "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
        {VENDOR_OPPO, "com.coloros.safecenter",
                "com.coloros.safecenter.startupapp.StartupAppListActivity"},
        {VENDOR_OPPO, "com.oppo.safe",
                "com.oppo.safe.permission.startup.StartupAppListActivity"},
        // vivo（OriginOS / Funtouch）：i 管家 → 应用管理 → 权限管理 → 自启动
        {VENDOR_VIVO, "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
        {VENDOR_VIVO, "com.iqoo.secure",
                "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"}
    };

    /**
     * {@code Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM}（API 31 才有）与
     * {@code Settings.ACTION_DATA_USAGE_SETTINGS}。
     *
     * <p>这两个刻意写成**字面量**而不是引用框架常量：本工程 minSdk 28、compileSdk 34，
     * 引用一个 API 31 的字段会让 lint 的 NewApi 报警（虽然本工程的 lint 是
     * {@code abortOnError false}，但不该靠这个），而这两个值都是 Android 设置契约里的稳定
     * 字符串、编译期同样会被内联，写死与引用常量在运行时完全等价。要做版本收窄的话，
     * 这两个常量正好是本类唯一需要人肉对齐的地方。
     */
    private static final String ACTION_REQUEST_SCHEDULE_EXACT_ALARM =
            "android.settings.REQUEST_SCHEDULE_EXACT_ALARM";
    private static final String ACTION_DATA_USAGE_SETTINGS = "android.settings.DATA_USAGE_SETTINGS";

    /** 所有 POST 的请求体都只可能是空或一个极小的 JSON */
    private static final int MAX_BODY_BYTES = 8 * 1024;

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
        Log.i(TAG, "keep-alive / 权限中心接口就绪");
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
        Log.i(TAG, "keep-alive / 权限中心接口停止");
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

        // 权限中心快照：通用设置只调这一个接口就能把所有格子渲染出来。
        // permissions.json 同时是能力探测口（旧 APK 真 404），原因见类注释。
        if (PATH_PERMISSIONS.equals(path) || PATH_PERMISSIONS_PROBE.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, permissionsObject().toString(),
                    "HEAD".equals(method));
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
            // 旧路由：参数与响应形状都不动（页面可能还在用），内部走同一套跳转逻辑
            boolean launched = requestBatteryExemption();
            JSONObject json = stateObject();
            json.put("launched", launched);
            HttpUtil.sendJson(out, 200, keepAlive, json.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_OPEN.equals(path)) {
            requirePost(method);
            JSONObject body = parseJsonObject(readBody(in, headers));
            String target = normalizeTarget(readString(body, "target"));
            if (target == null) {
                throw new HttpError(400, "bad_target");
            }
            JSONObject result = openTarget(target, readString(body, "mode"));
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_NOTIFY.equals(path)) {
            requirePost(method);
            JSONObject body = parseJsonObject(readBody(in, headers));
            if (!body.has("enabled")) {
                throw new HttpError(400, "bad_body");
            }
            JSONObject result = notificationSwitch(body.optBoolean("enabled", true));
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        // 旧 APK 的 SPA 回落会把未知路径回成 index.html，所以未知子路径给 404 是有意义的：
        // 新 APK 上路径打错（或未来版本删了接口）页面能立刻看出来
        throw new HttpError(404, "not_found");
    }

    // ---------------------------------------------------------------- 动作：保活（旧）

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
     * 拉起系统「忽略电池优化」授权页（旧 /battery 路由的实现）。
     *
     * <p>为什么必须由页面触发：这个 Intent 一旦从后台发出会被系统拦（Android 10+ 限制后台
     * 弹 Activity），而它又是国产 ROM 上「后台还是被杀」的头号原因。
     *
     * <p>响应里的 {@code batteryExempt} 是<b>拉起来之前</b>那一刻的状态：用户在白名单页点完
     * 「允许」后，页面应在 {@code visibilitychange} / 回到前台时重新 GET 一次拿最新值。
     *
     * @return true 表示系统页面已经拉起（不等于用户已经点了允许）
     */
    private boolean requestBatteryExemption() throws JSONException {
        Context app = application;
        if (app == null) {
            return false;
        }
        JSONObject ignored = new JSONObject();
        openFirstAvailable(ignored, new Intent[] {
                ignoreBatteryOptimizationsIntent(app), batteryOptimizationListIntent()});
        return ignored.optBoolean("launched", false);
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
        // 工作线程不能直接 requestPermissions：丢回主线程，且不等结果（页面从状态接口读真实值）
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

    /**
     * 页面点「申请通知权限」时用：借当前 Activity 直接弹系统权限框（比跳到设置页少一步）。
     *
     * <p>与 {@link #ensureNotificationPermission()} 的区别：那个是自动的（进程内只弹一次），
     * 这个是用户显式点击，所以不看「问过没问过」的闸门 —— 用户再点一次就是想再要一次。
     *
     * @return true = 权限框真的发出去了（不等于用户点了允许，真实结果要从状态接口重读）
     */
    private boolean requestNotificationNow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // 12 及以下没有这个运行时权限：只能去系统设置里开/关
            return false;
        }
        Context app = application;
        if (app == null || hasPostNotificationsPermission(app)) {
            // 已经授予了就没必要再弹
            return false;
        }
        final Activity activity = resumedActivity();
        if (activity == null) {
            // 应用不在前台：系统会直接拒绝这次弹框
            return false;
        }
        if (!canRequestNotifications(app, false)) {
            // 已经永久拒绝（系统不会再弹，会立刻回调 denied）：不许谎报「已经申请了」，
            // 让调用方落回设置页那条路
            Log.i(TAG, "通知权限已无法再弹框（永久拒绝），改走系统设置页");
            return false;
        }
        notificationAsked.set(true);
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        activity.requestPermissions(
                                new String[] {Manifest.permission.POST_NOTIFICATIONS},
                                REQUEST_CODE_NOTIFICATIONS);
                        Log.i(TAG, "已按页面要求弹通知权限框");
                    } catch (RuntimeException failed) {
                        Log.w(TAG, "弹通知权限框失败", failed);
                    }
                }
            });
            return true;
        } catch (RuntimeException failed) {
            Log.w(TAG, "投递通知权限申请失败", failed);
            return false;
        }
    }

    // ---------------------------------------------------------------- 动作：跳到权限设置页

    /**
     * 按 target 打开对应的系统页面。
     *
     * <p>降级链（详见交付报告 input-M1-权限中心.md 的接口表）：每个 target 先试最精确的那个
     * 系统页，打不开就退到「应用详情页」（那里至少有「通知 / 权限 / 电池」的入口）；
     * 只有 autoStart 例外 —— 详情页里没有自启动开关，所以只回 fallback 让页面自己决定。
     *
     * @param target 已通过 {@link #normalizeTarget} 白名单校验
     * @param mode   只有 notifications 用：{@code request} 表示直接弹运行时权限框
     */
    private JSONObject openTarget(String target, String mode) throws JSONException {
        JSONObject result = new JSONObject();
        result.put("target", target);
        Context app = application;
        if (app == null) {
            return failed(result, "no_context", null);
        }

        if (TARGET_NOTIFICATIONS.equals(target)) {
            boolean wantsDialog = MODE_REQUEST.equals(mode);
            // 可选路径：直接弹系统的运行时权限框（canRequest=true 时页面应该走这条）
            if (wantsDialog && requestNotificationNow()) {
                result.put("ok", true);
                result.put("launched", true);
                result.put("mode", MODE_REQUEST);
                return result;
            }
            openFirstAvailable(result, new Intent[] {notificationsIntent(app)});
            if (wantsDialog) {
                // 页面要的是弹窗，但已经弹不了了（永久拒绝 / 不在前台）：如实告诉它这次落到了设置页，
                // 免得页面以为「弹窗弹了、等回调」空等一场
                result.put("mode", "settings");
                result.put("requestUnavailable", true);
            }
            return result;
        }

        if (TARGET_BATTERY.equals(target)) {
            return openFirstAvailable(result, new Intent[] {
                    ignoreBatteryOptimizationsIntent(app), batteryOptimizationListIntent()});
        }

        if (TARGET_APP_DETAILS.equals(target)) {
            Intent details = detailsIntent(app);
            if (launch(details)) {
                return launched(result, details);
            }
            return failed(result, "intent_unavailable", null);
        }

        if (TARGET_AUTO_START.equals(target)) {
            return openAutoStart(result, app);
        }

        if (TARGET_EXACT_ALARM.equals(target)) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                // Android 11 及以下没有「精确闹钟」授权这回事
                result.put("ok", true);
                result.put("launched", false);
                result.put("notNeeded", true);
                return result;
            }
            // 本安装没有声明 SCHEDULE_EXACT_ALARM（见报告「未做项」），系统页能打开
            // 但我们这一项大概率开不了 —— 让页面拿 declared=false 自己提示
            result.put("declared", false);
            return openFirstAvailable(result, new Intent[] {exactAlarmIntent(app)});
        }

        if (TARGET_OVERLAY.equals(target)) {
            // 本安装没有声明 SYSTEM_ALERT_WINDOW，同理：页能开，开关可能不出现
            result.put("declared", false);
            return openFirstAvailable(result, new Intent[] {overlayIntent(app)});
        }

        if (TARGET_DATA_USAGE.equals(target)) {
            return openFirstAvailable(result, new Intent[] {
                    dataUsageIntent(), batteryOptimizationListIntent()});
        }

        // normalizeTarget 已经把白名单筛过一遍，走到这里说明调用方绕过了它
        throw new HttpError(400, "bad_target");
    }

    /**
     * 按顺序试每个候选 Intent，第一个能拉起的算命中；全挂就退到应用详情页。
     *
     * @param candidates 允许有 null 元素（某个 Intent 构造失败时占位）
     */
    private JSONObject openFirstAvailable(JSONObject result, Intent[] candidates)
            throws JSONException {
        if (candidates != null) {
            for (int index = 0; index < candidates.length; index++) {
                Intent candidate = candidates[index];
                if (candidate != null && launch(candidate)) {
                    launched(result, candidate);
                    result.put("degraded", false);
                    return result;
                }
            }
        }
        Context app = application;
        Intent details = app == null ? null : detailsIntent(app);
        if (details != null && launch(details)) {
            launched(result, details);
            result.put("degraded", true);
            result.put("fallback", TARGET_APP_DETAILS);
            return result;
        }
        result.put("degraded", true);
        return failed(result, "intent_unavailable", TARGET_APP_DETAILS);
    }

    /** 自启动：按厂商试组件，三星/其它直接退应用详情。 */
    private JSONObject openAutoStart(JSONObject result, Context app) throws JSONException {
        String vendor = detectVendor();
        result.put("vendor", vendor);
        if (VENDOR_SAMSUNG.equals(vendor) || VENDOR_OTHER.equals(vendor)) {
            // 原厂系统没有「自启动」这个概念：应用详情页就是最接近的东西
            Intent details = detailsIntent(app);
            if (details != null && launch(details)) {
                launched(result, details);
                result.put("degraded", true);
                result.put("fallback", TARGET_APP_DETAILS);
                return result;
            }
            return failed(result, "intent_unavailable", TARGET_APP_DETAILS);
        }
        for (int index = 0; index < AUTO_START_COMPONENTS.length; index++) {
            String[] entry = AUTO_START_COMPONENTS[index];
            if (!vendor.equals(entry[0])) {
                continue;
            }
            Intent intent = componentIntent(entry[1], entry[2]);
            if (intent != null && launch(intent)) {
                launched(result, intent);
                result.put("degraded", false);
                return result;
            }
        }
        // 厂商页一个都打不开（ROM 改了类名 / 组件没导出 / 被安全策略拦）：
        // 不自动跳详情页，把决定权交回页面（fallback 字段就是给它看的）
        Log.w(TAG, "没有可用的自启动管理页：" + vendor);
        return failed(result, "intent_unavailable", TARGET_APP_DETAILS);
    }

    /**
     * 常驻通知开/关。
     *
     * <p><b>为什么「关」不等于「没有通知」</b>：这条通知是<b>前台服务</b>的通知，
     * 系统要求前台服务必须有一条可见通知 —— 想真隐藏只有
     * {@code stopForeground(STOP_FOREGROUND_DETACH)}，那会让服务失去前台地位、
     * 立刻回到「一后台就被杀」的老路。所以这里只做文案降级：
     * enabled=false 时标题/正文换成「Chat Pad 在后台保持」，服务照跑、通知照在。
     * 响应里 {@code residentNotification.canHide} 恒为 false 就是这件事的机器可读版本。
     */
    private JSONObject notificationSwitch(boolean enabled) throws JSONException {
        Context app = application;
        if (app == null) {
            throw new HttpError(500, "no_context");
        }
        // true = 服务正在跑，通知文案已即时刷新；false = 只落盘，下次启动/重建时生效
        boolean applied = RemoteKeepAliveService.setNotificationEnabled(app, enabled);
        boolean stored = RemoteKeepAliveService.isNotificationEnabled(app);
        if (stored != enabled) {
            // SharedPreferences 写失败（磁盘满 / 存储异常）：别谎报成功
            throw new HttpError(500, "not_persisted");
        }
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("enabled", stored);
        json.put("applied", applied);
        json.put("running", RemoteKeepAliveService.isRunning());
        json.put("shouldRun", RemoteKeepAliveService.shouldRun(app));
        json.put("notifications", notificationsJson(app));
        json.put("residentNotification", residentNotificationJson(app));
        return json;
    }

    // ---------------------------------------------------------------- 动作：慢工具

    /**
     * 拉起一个系统页面。
     *
     * <p>必须带 {@link Intent#FLAG_ACTIVITY_NEW_TASK}：{@link #application} 是 Application
     * context，从非 Activity context 起 Activity 不带这个 flag 会抛
     * {@code AndroidRuntimeException: Calling startActivity() from outside of an Activity
     * context requires the FLAG_ACTIVITY_NEW_TASK flag}。借 resumed Activity 起的时候
     * 多带这个 flag 也只是多开一个任务，用户按返回回到对话页，行为一致。
     *
     * <p>三条 catch 缺一不可：厂商 ROM 会把系统页换掉（{@link ActivityNotFoundException}）、
     * 给它加权限（{@link SecurityException}）、或者把它导出成异常状态（{@link RuntimeException}）。
     * 任何一条都不许冒到 LocalServer 去把连接打死。
     */
    private boolean launch(Intent intent) {
        if (intent == null) {
            return false;
        }
        Intent request = new Intent(intent);
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
            Log.i(TAG, "已拉起系统页面：" + describeIntent(request));
            return true;
        } catch (ActivityNotFoundException noSettingsPage) {
            Log.w(TAG, "系统没有这个设置页：" + describeIntent(request));
            return false;
        } catch (SecurityException denied) {
            Log.w(TAG, "系统不允许打开这个设置页：" + describeIntent(request), denied);
            return false;
        } catch (RuntimeException failed) {
            // 厂商 ROM 会改这些 Activity 的权限/存在性；退化成「不崩、返回 false」
            Log.w(TAG, "拉起系统页面失败：" + describeIntent(request), failed);
            return false;
        }
    }

    /**
     * 这个 Intent 在当前系统上能不能解析到（只用来给页面一个「大概能打开」的判断）。
     *
     * <p>注意 Android 11+ 的包可见性过滤：本工程没有声明 {@code queries}，
     * 所以 {@code resolveActivity} 对别的应用的组件可能返回 null，而 {@code startActivity}
     * 仍然能成功。也就是说 intentAvailable=false <b>不等于</b>「点了会失败」，
     * 真值以 /open 的返回为准 —— 页面别拿它决定要不要显示这一格。
     */
    private boolean canResolve(Intent intent) {
        Context app = application;
        if (app == null || intent == null) {
            return false;
        }
        try {
            PackageManager manager = app.getPackageManager();
            if (manager == null) {
                return false;
            }
            // MATCH_DEFAULT_ONLY：只算带 CATEGORY_DEFAULT 的入口，和 startActivity 的解析规则一致
            return manager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null;
        } catch (RuntimeException broken) {
            Log.d(TAG, "解析 Intent 失败：" + describeIntent(intent) + " " + broken);
            return false;
        }
    }

    // ---------------------------------------------------------------- Intent 构造

    /** 本应用的通知设置页（API 26+，带 EXTRA_APP_PACKAGE 才会定位到本应用那一项）。 */
    private Intent notificationsIntent(Context app) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, app.getPackageName());
        return intent;
    }

    /** 「允许忽略电池优化吗」系统弹窗（必须带 package: 的 data，否则直接 ActivityNotFound）。 */
    private Intent ignoreBatteryOptimizationsIntent(Context app) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + app.getPackageName()));
        return intent;
    }

    /** 「电池优化」列表页：部分 ROM 会忽略带 package 的那条 ACTION，只能让用户自己找。 */
    private Intent batteryOptimizationListIntent() {
        return new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
    }

    /** 应用详情页：所有权限/通知/存储的兜底入口。 */
    private Intent detailsIntent(Context app) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + app.getPackageName()));
        return intent;
    }

    /** Android 12+ 的「允许设定精确闹钟」（字面量常量，原因见类字段注释）。 */
    private Intent exactAlarmIntent(Context app) {
        Intent intent = new Intent(ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + app.getPackageName()));
        return intent;
    }

    /** 「显示在其他应用上层」（API 23+）。 */
    private Intent overlayIntent(Context app) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
        intent.setData(Uri.parse("package:" + app.getPackageName()));
        return intent;
    }

    /** 流量使用情况页（拿不到时由调用方退到电池优化列表 / 应用详情）。 */
    private Intent dataUsageIntent() {
        return new Intent(ACTION_DATA_USAGE_SETTINGS);
    }

    /** 显式组件 Intent；ComponentName 构造失败（罕见）时返回 null 由调用方跳过。 */
    private static Intent componentIntent(String packageName, String className) {
        try {
            return new Intent().setComponent(new ComponentName(packageName, className));
        } catch (RuntimeException broken) {
            return null;
        }
    }

    // ---------------------------------------------------------------- 权限快照

    /** 权限中心快照：通用设置靠它一次渲染所有格子。 */
    private JSONObject permissionsObject() throws JSONException {
        Context app = application;
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("sdkInt", Build.VERSION.SDK_INT);
        json.put("notifications", notificationsJson(app));
        json.put("foregroundService", foregroundServiceJson(app));
        json.put("battery", batteryJson(app));
        json.put("exactAlarm", exactAlarmJson(app));
        json.put("overlay", overlayJson(app));
        json.put("autoStart", autoStartJson());
        json.put("appDetails", appDetailsJson(app));
        json.put("residentNotification", residentNotificationJson(app));
        // 与 /state 同名的旧字段：页面只调一个接口就能既渲染权限格子，又渲染保活三态
        json.put("running", RemoteKeepAliveService.isRunning());
        json.put("shouldRun", app != null && RemoteKeepAliveService.shouldRun(app));
        json.put("notificationsGranted", notificationsGranted(app));
        json.put("batteryExempt", app != null && RemoteKeepAliveService.isBatteryExempt(app));
        return json;
    }

    private JSONObject notificationsJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        boolean granted = notificationsGranted(app);
        json.put("granted", granted);
        // canRequest：还能靠一次弹窗解决吗
        // （true 时页面应调 POST /open {"target":"notifications","mode":"request"}）
        json.put("canRequest", app != null && canRequestNotifications(app, granted));
        // channelBlocked：应用总开关开着，但「后台保活」这条渠道被单独关掉了。
        // 这种「权限是授予的、却看不到通知」的状态只有渠道能反映出来，页面提示语要单独写一句
        json.put("channelBlocked", app != null && notificationChannelBlocked(app));
        // declared：清单里有没有 POST_NOTIFICATIONS（本工程恒为 true，留着是为了和下面两格对齐）
        json.put("declared", true);
        return json;
    }

    private JSONObject foregroundServiceJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("running", RemoteKeepAliveService.isRunning());
        // running=false 且 shouldRun=true = 用户配过保活但服务被系统清了（onResume 会自愈）
        json.put("shouldRun", app != null && RemoteKeepAliveService.shouldRun(app));
        return json;
    }

    private JSONObject batteryJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        boolean exempt = app != null && RemoteKeepAliveService.isBatteryExempt(app);
        json.put("exempt", exempt);
        // ignored 是同一个值的历史别名（老页面按这个名字读），两个都给，免得谁白跑一次迁移
        json.put("ignored", exempt);
        json.put("declared", true);
        return json;
    }

    private JSONObject exactAlarmJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("needed", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
        json.put("granted", exactAlarmGranted(app));
        // 本安装未声明 SCHEDULE_EXACT_ALARM（见报告「未做项」）：系统永远回「未授予」，
        // 页面看到 declared=false 就该显示成「本版未申请」而不是「未开启」
        json.put("declared", false);
        return json;
    }

    private JSONObject overlayJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("granted", overlayGranted(app));
        // 同理：未声明 SYSTEM_ALERT_WINDOW，系统设置页里不会有本应用的开关
        json.put("declared", false);
        return json;
    }

    /**
     * 自启动页状态。注意它<b>不</b>看 Activity 上下文：候选组件能不能解析只跟包管理有关
     * （见 {@link #autoStartAvailable}），所以不需要 Context 参数。
     */
    private JSONObject autoStartJson() throws JSONException {
        String vendor = detectVendor();
        JSONObject json = new JSONObject();
        json.put("vendor", vendor);
        json.put("intentAvailable", autoStartAvailable(vendor));
        json.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        return json;
    }

    private JSONObject appDetailsJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("intentAvailable", app != null && canResolve(detailsIntent(app)));
        return json;
    }

    private JSONObject residentNotificationJson(Context app) throws JSONException {
        JSONObject json = new JSONObject();
        // enabled=false 只是把文案降级成「后台保持」，服务与通知都还在（见 notificationSwitch 注释）
        json.put("enabled", app == null || RemoteKeepAliveService.isNotificationEnabled(app));
        json.put("canHide", false);
        return json;
    }

    // ---------------------------------------------------------------- 状态读取

    /**
     * 通知到底能不能显示：用户级总开关（26+）与 13+ 的运行时权限，两个都满足才算数。
     *
     * <p>比「只看 POST_NOTIFICATIONS」更准：API 28~32 没有运行时权限，用户可以在系统设置里
     * 一键关掉全部通知，那种情况下权限查询仍然回 granted，只有 areNotificationsEnabled 能看出来。
     */
    private static boolean notificationsGranted(Context app) {
        if (app == null) {
            return false;
        }
        boolean granted;
        try {
            granted = areNotificationsEnabled(app);
        } catch (RuntimeException broken) {
            granted = false;
        }
        if (granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted = hasPostNotificationsPermission(app);
        }
        return granted;
    }

    /**
     * 用户有没有在系统里关掉本应用的通知。
     *
     * <p>为什么反射：{@code NotificationManagerCompat} 在 androidx.core 里（工程虽然带了它），
     * 但这里只需要一个 boolean，不想为一行判断多一层依赖；反射失败（ROM 改了方法名）就退回
     * {@link RemoteKeepAliveService#isNotificationAllowed(Context)}（那个只看 13+ 的运行时权限）。
     */
    private static boolean areNotificationsEnabled(Context app) {
        try {
            NotificationManager manager =
                    (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                Object value = NotificationManager.class
                        .getMethod("areNotificationsEnabled")
                        .invoke(manager);
                if (value instanceof Boolean) {
                    return ((Boolean) value).booleanValue();
                }
            }
        } catch (Exception unavailable) {
            // NoSuchMethod / IllegalAccess / InvocationTarget / SecurityException 全在这里
            Log.d(TAG, "areNotificationsEnabled 不可用，退回权限判断：" + unavailable);
        }
        return RemoteKeepAliveService.isNotificationAllowed(app);
    }

    private static boolean hasPostNotificationsPermission(Context app) {
        try {
            // 权限名是编译期字符串常量，API 33 以下查表也不会失败
            return app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException broken) {
            return false;
        }
    }

    /**
     * 「后台保活」这条通知渠道是不是被用户单独关掉了。
     *
     * <p>8+ 每个渠道可以单独设成「关闭」，此时应用总开关还是开的、权限也还在，
     * 但那条常驻通知就是不显示 —— 用户会以为「保活没生效」。这个状态只有渠道能看出来，
     * 所以单独报一格。
     */
    private static boolean notificationChannelBlocked(Context app) {
        try {
            NotificationManager manager =
                    (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                return false;
            }
            // minSdk 28 > 26：渠道 API 无条件可用；渠道还没建出来时返回 null，按「没被关」处理
            NotificationChannel channel =
                    manager.getNotificationChannel(RemoteKeepAliveService.CHANNEL_ID);
            return channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE;
        } catch (RuntimeException broken) {
            Log.d(TAG, "读通知渠道状态失败：" + broken);
            return false;
        }
    }

    /**
     * 页面这一格还能不能靠一次弹窗解决。
     *
     * <p>判定（13+）：
     * <ul>
     *   <li>已授予 → false（没什么可申请的）</li>
     *   <li>{@code shouldShowRequestPermissionRationale} 为 true → 用户拒过一次但系统还允许再问（软拒绝）</li>
     *   <li>本进程还没问过 → true（弹窗能出来）</li>
     *   <li>问过且 rationale 为 false → 永久拒绝，只能去系统设置（false）</li>
     * </ul>
     * 12 及以下没有这个运行时权限（用户只能在系统设置里关），恒 false。
     */
    private boolean canRequestNotifications(Context app, boolean granted) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return false;
        }
        if (granted || app == null) {
            return false;
        }
        Activity activity = resumedActivity();
        if (activity == null) {
            // 不在前台：系统不会弹权限框，保守回「本进程还没问过」
            return !notificationAsked.get();
        }
        try {
            if (activity.shouldShowRequestPermissionRationale(
                    Manifest.permission.POST_NOTIFICATIONS)) {
                return true;
            }
        } catch (RuntimeException broken) {
            Log.d(TAG, "读权限 rationale 失败：" + broken);
        }
        return !notificationAsked.get();
    }

    /**
     * 精确闹钟授权。
     *
     * <p>{@code canScheduleExactAlarms()} 是 API 31 起的；11 及以下没有这个授权概念，
     * 直接算「已授权」（granted=true、needed=false，页面据此隐藏这一格）。
     */
    private static boolean exactAlarmGranted(Context app) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        if (app == null) {
            return false;
        }
        AlarmManager alarms = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) {
            return false;
        }
        try {
            return alarms.canScheduleExactAlarms();
        } catch (RuntimeException broken) {
            Log.d(TAG, "读精确闹钟授权失败：" + broken);
            return false;
        }
    }

    /** 悬浮窗授权（API 23+ 恒可用；minSdk 28）。 */
    private static boolean overlayGranted(Context app) {
        if (app == null) {
            return false;
        }
        try {
            return Settings.canDrawOverlays(app);
        } catch (RuntimeException broken) {
            Log.d(TAG, "读悬浮窗授权失败：" + broken);
            return false;
        }
    }

    /** 按 MANUFACTURER + BRAND 猜厂商（两者分开判断：红米/POCO 的 MANUFACTURER 仍是 Xiaomi）。 */
    private static String detectVendor() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String brand = Build.BRAND == null ? "" : Build.BRAND;
        String signature = (manufacturer + " " + brand).toLowerCase(Locale.US);
        if (signature.contains("xiaomi") || signature.contains("redmi")
                || signature.contains("poco")) {
            return VENDOR_XIAOMI;
        }
        if (signature.contains("huawei") || signature.contains("honor")) {
            return VENDOR_HUAWEI;
        }
        if (signature.contains("oppo") || signature.contains("realme")
                || signature.contains("oneplus")) {
            return VENDOR_OPPO;
        }
        if (signature.contains("vivo") || signature.contains("iqoo")) {
            return VENDOR_VIVO;
        }
        if (signature.contains("samsung")) {
            return VENDOR_SAMSUNG;
        }
        return VENDOR_OTHER;
    }

    /** 自启动页能不能打开（三星/其它看应用详情页）。 */
    private boolean autoStartAvailable(String vendor) {
        if (VENDOR_SAMSUNG.equals(vendor) || VENDOR_OTHER.equals(vendor)) {
            Context app = application;
            return app != null && canResolve(detailsIntent(app));
        }
        for (int index = 0; index < AUTO_START_COMPONENTS.length; index++) {
            String[] entry = AUTO_START_COMPONENTS[index];
            if (vendor.equals(entry[0]) && canResolve(componentIntent(entry[1], entry[2]))) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 状态（旧）

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
        // 语义收紧了：现在也反映「用户在系统里关掉了本应用通知」（26+ 的 areNotificationsEnabled），
        // 不再只看 13+ 的运行时权限 —— 见 notificationsGranted
        json.put("notificationsGranted", notificationsGranted(app));
        json.put("batteryExempt", app != null && RemoteKeepAliveService.isBatteryExempt(app));
        json.put("sdkInt", Build.VERSION.SDK_INT);
        return json;
    }

    // ---------------------------------------------------------------- 请求体

    /**
     * 把请求体读出来（上限 {@link #MAX_BODY_BYTES}）；超限/分块一律 4xx。
     *
     * @return 请求体原文（空体返回空串，调用方自己决定空体算不算错误）
     */
    private static String readBody(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            // 页面发的是定长（空体或一个小 JSON），chunked 只可能来自异常客户端
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared <= 0L) {
            return "";
        }
        if (declared > MAX_BODY_BYTES) {
            // 不读完就回包：HTTP 允许在发完响应后关连接，这里会走到 "必须关连接" 的分支
            throw new HttpError(413, "payload_too_large");
        }
        byte[] body = new byte[(int) declared];
        int filled = 0;
        while (filled < body.length) {
            int read = in.read(body, filled, body.length - filled);
            if (read == -1) {
                throw new HttpError(400, "body_truncated");
            }
            filled += read;
        }
        return new String(body, StandardCharsets.UTF_8);
    }

    /** 解析 JSON 请求体；空体/非法 JSON 一律 400（页面发错比自己猜更不容易出事故）。 */
    private static JSONObject parseJsonObject(String raw) {
        if (raw == null) {
            throw new HttpError(400, "bad_body");
        }
        String text = raw.trim();
        if (text.isEmpty()) {
            throw new HttpError(400, "bad_body");
        }
        try {
            return new JSONObject(text);
        } catch (JSONException malformed) {
            throw new HttpError(400, "bad_body");
        }
    }

    /** 读一个字符串字段；缺失或类型不对回 null。 */
    private static String readString(JSONObject body, String key) {
        try {
            String value = body.optString(key, null);
            return value == null ? null : value.trim();
        } catch (RuntimeException broken) {
            return null;
        }
    }

    /** target 白名单：只认这七个，别的一律 400 bad_target（不猜、也不做模糊匹配）。 */
    private static String normalizeTarget(String raw) {
        if (raw == null) {
            return null;
        }
        if (TARGET_NOTIFICATIONS.equals(raw)
                || TARGET_BATTERY.equals(raw)
                || TARGET_APP_DETAILS.equals(raw)
                || TARGET_AUTO_START.equals(raw)
                || TARGET_EXACT_ALARM.equals(raw)
                || TARGET_OVERLAY.equals(raw)
                || TARGET_DATA_USAGE.equals(raw)) {
            return raw;
        }
        return null;
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

    // ---------------------------------------------------------------- 响应小工具

    /** 成功：ok/launched 置真，并把「实际用了哪个 action」写回去，方便页面/日志对账。 */
    private static JSONObject launched(JSONObject result, Intent intent) throws JSONException {
        result.put("ok", true);
        result.put("launched", true);
        String action = describeIntent(intent);
        if (action != null) {
            result.put("action", action);
        }
        return result;
    }

    /** 失败：ok=false + error，可选 fallback（页面据此决定要不要再调一次 appDetails）。 */
    private static JSONObject failed(JSONObject result, String error, String fallback)
            throws JSONException {
        result.put("ok", false);
        result.put("launched", false);
        result.put("error", error);
        if (fallback != null) {
            result.put("fallback", fallback);
        }
        return result;
    }

    /** 用于日志与响应：优先报 action，其次报 component（自启动那几条是显式组件）。 */
    private static String describeIntent(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        if (action != null) {
            return action;
        }
        ComponentName component = intent.getComponent();
        return component == null ? null : component.flattenToString();
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
