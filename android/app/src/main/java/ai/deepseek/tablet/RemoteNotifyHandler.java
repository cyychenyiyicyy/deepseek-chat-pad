package ai.deepseek.tablet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * /__ds_notify/* 的实现：**页面把「正在干什么」推给原生，原生负责画通知**。
 *
 * <p><b>为什么通知要在原生画</b>：页面在后台会被 WebView 冻结（{@code pauseTimers}），
 * 而且 Web Notification API 在 WebView 里根本没有可用实现 —— 想在「退到后台」时告诉用户
 * 「谁在跑、在调什么工具、跑完了、等你审核」，只有原生 {@code NotificationManager} 一条路。
 * 所以这一层不做任何业务判断，只做渲染 + 去重：页面推一份**当前态快照**，原生按快照对齐通知栏。
 *
 * <p><b>接口一览</b>（与 {@link KeepAliveHandler} 同一套约定：一律 JSON、异常兜成 JSON、
 * POST 先读完请求体再回包）：
 * <pre>
 * POST /__ds_notify/work    {items:[{sessionId,title,state,tool?,detail?,ts}],activeSessionId?}
 *                           推一份当前快照 → 进行中合并成一条汇总通知；完成/出错/待审批各发一条
 * POST /__ds_notify/clear   {sessionId?}   清通知：带 sessionId 清这个会话，不带清全部工作通知
 * GET  /__ds_notify/state                  诊断：{ok,granted,channels:[...],groupKey,posted:[ids]}
 * GET  /__ds_notify/state.json             同上（能力探测别名，见「为什么带扩展名」）
 * GET  /__ds_notify/open                   点通知直达（R14）：{ok,pendingSessionId,hasPending,rev}
 * GET  /__ds_notify/open.json              同上（能力探测别名，理由同上）
 * </pre>
 *
 * <p><b>点通知直达（R14）</b>：通知的 {@code PendingIntent} 里本来就带着
 * {@link #EXTRA_SESSION_ID}，{@link MainActivity} 在 {@code onCreate} / {@code onNewIntent}
 * 里把它收进一个**进程内信箱**（{@link MainActivity#consumePendingSessionId()}）；页面在
 * 「启动 / 回到前台 / 原生推事件」时读 {@code open.json} 取走。<b>取走即清空</b>，所以同一条
 * 通知不会被反复打开。这里只做转发，判定「会话在不在、要不要切到远程模式」全在页面侧。
 *
 * <p><b>为什么探测要用带扩展名的 {@code state.json}</b>：旧 APK 没有这些路由，请求会掉到
 * {@link AssetHandler}，而它有一层「最后一段没扩展名就回落 index.html」的 SPA 兜底 ——
 * 对 {@code /__ds_notify/state} 会回 <b>200 + 一段 HTML</b>。页面若只看状态码，就会把旧壳
 * 误判成「支持通知中心」，然后推快照、永远看不到通知。带点的路径不触发回落：
 * <b>旧 APK 真 404，新 APK 真 JSON</b>（与 {@code /__ds_keepalive/permissions.json} 同一套理由）。
 *
 * <p><b>Android 9（API 28）兼容要点</b>（本工程 minSdk 28 / target 34，逐条都落在代码里）：
 * <ul>
 *   <li><b>通知渠道是硬前提</b>：8.0 起 {@code notify()} 的 {@link Notification.Builder} 必须带
 *       channel id，渠道没建出来时那条通知**静默消失**（不抛异常，日志里也不明显）。
 *       所以 {@link #ensureChannels(Context)} 在「服务启动 / 权限快照 / 推快照」三处都会调，
 *       建渠道是幂等的</li>
 *   <li>{@link Notification.InboxStyle} 从 API 16 起就有，{@code setNumber} 从 1 起就有：可用</li>
 *   <li>{@code Notification.Builder} 上那个 12+ 才有的 {@code setForegroundServiceBehavior}
 *       本文件一行都没调（调了在 9 上会 NoSuchMethodError）</li>
 *   <li>{@code PendingIntent} 一律 {@code FLAG_IMMUTABLE}（API 23+；targetSdk 31+ 更是强制），
 *       minSdk 28 不需要版本分支</li>
 *   <li>{@code setGroup} 从 7.0 起生效；<b>刻意不给任何一条通知加
 *       {@code setGroupSummary(true)}</b> —— 一旦有组摘要，组内其它通知（尤其是保活前台服务的
 *       那条常驻通知）会被折叠进摘要里，用户就找不到它了。现在只挂组名，让系统按需要堆叠</li>
 *   <li>{@code setTimeoutAfter} 需要 API 26（可用）但本文件**故意不用**：通知到时自动消失后
 *       原生这边的「已发过哪些 id」就成假账（{@code /state} 会报一个已不存在的 id）。清理一律
 *       由页面的 {@code /clear} 或用户滑动负责</li>
 *   <li>{@code setPriority} 是 7.1 及以下的老开关，8.0+ 由渠道 importance 决定；这里保留一行
 *       （待审批用 HIGH）只是为了语义完整，在 9 上它不会覆盖渠道设置</li>
 * </ul>
 *
 * <p><b>通知 id 的规则</b>（固定算法，进程重启后也能算出同一个 id，所以 {@code /clear} 不依赖
 * 进程内的记账）：
 * <ul>
 *   <li>汇总：{@link #ID_SUMMARY}（固定）</li>
 *   <li>完成/出错：{@link #ID_EVENT_BASE} + {@code hash(sessionId) & 0x0FFF}（一个会话最多一条，
 *       状态变了就地替换）</li>
 *   <li>待审批：{@link #ID_APPROVAL_BASE} + 同一个哈希（与上面分开，所以「已完成」和
 *       「等你审核」能同时存在）</li>
 *   <li>保活前台服务那条是 {@link RemoteKeepAliveService#NOTIFICATION_ID}，本类**绝不**碰它：
 *       工作通知挤掉前台服务通知，系统会认为服务失去了前台地位</li>
 * </ul>
 *
 * <p><b>去重</b>：页面每秒/每几秒推一次全量快照，如果每次都 notify，完成通知会反复响铃。
 * 所以每条事件通知记一个「内容摘要」（state+ts+detail+tool），摘要没变就只更新不重发。
 *
 * <p><b>对账</b>：待审批通知是 {@code setOngoing(true)}（用户滑不掉），所以每次推快照都会对一次账 —
 * 上一次在等审批、这一次不在等了（页面已处理完或把它摘掉了）就把那条撤掉。否则一条
 * 「等你审核」会永远横在通知栏里，用户自己也没法清。
 */
final class RemoteNotifyHandler {

    private static final String TAG = "DsNotify";

    /** LocalServer 用它把请求交给本类 */
    static final String PATH_PREFIX = "/__ds_notify/";

    private static final String PATH_WORK = "/__ds_notify/work";
    private static final String PATH_CLEAR = "/__ds_notify/clear";
    private static final String PATH_STATE = "/__ds_notify/state";
    /** 能力探测别名：带扩展名，旧 APK 真 404（原因见类注释） */
    private static final String PATH_STATE_PROBE = "/__ds_notify/state.json";
    /** 点通知直达：读走「待打开的会话」并清空（读后清空 = 幂等） */
    private static final String PATH_OPEN = "/__ds_notify/open";
    /** 同上，带扩展名的别名（页面探测能力时必须用它，理由见类注释） */
    private static final String PATH_OPEN_PROBE = "/__ds_notify/open.json";

    // ---------------------------------------------------------------- 渠道 / 通知组

    /** 进行中汇总：低打扰（无声、无振动、无角标） */
    static final String CHANNEL_WORK = "chatpad.work";
    /** 完成 / 出错 / 待审批：要用户注意，会响一声 */
    static final String CHANNEL_ALERT = "chatpad.alert";

    private static final CharSequence CHANNEL_WORK_NAME = "Chat Pad 工作进度";
    private static final CharSequence CHANNEL_ALERT_NAME = "Chat Pad 提醒";
    private static final String CHANNEL_WORK_DESCRIPTION =
            "进行中的任务与工具调用：不响铃，多条合并成一条";
    private static final String CHANNEL_ALERT_DESCRIPTION =
            "任务完成 / 出错 / 等待审核：会响一声，点一下回到对话";

    /**
     * 通知组：工作通知与保活前台服务通知挂在同一个组里（`setGroup` 在 7.0+ 生效）。
     * 刻意不设组摘要，见类注释最后一条兼容说明。
     */
    static final String GROUP_KEY = "chatpad";

    // ---------------------------------------------------------------- 状态字面量

    static final String STATE_RUNNING = "running";
    static final String STATE_DONE = "done";
    static final String STATE_ERROR = "error";
    static final String STATE_APPROVAL = "approval";

    /**
     * 点通知回 App 时带的 extra（会话 id）。
     *
     * <p>完整链路（R14 接通）：本类 {@link #contentIntent(String)} 把它塞进 {@code PendingIntent}
     * → {@link MainActivity#onCreate(android.os.Bundle)} / {@code onNewIntent} 收进进程内信箱
     * → 页面 {@code GET /__ds_notify/open.json} 取走（读后清空）→ `services/remote/deepLink.ts`
     * 切到远程模式并 {@code openSession(id)}。键名只在这里定义一次，两边都不用猜。
     */
    static final String EXTRA_SESSION_ID = "ai.deepseek.tablet.extra.SESSION_ID";

    // ---------------------------------------------------------------- 通知 id

    /** 汇总通知 id（固定值；与前台服务的 {@link RemoteKeepAliveService#NOTIFICATION_ID} 不重叠） */
    private static final int ID_SUMMARY = 0x44530101;
    /** 完成/出错通知 id 基址（0x44531000 ~ 0x44531FFF） */
    private static final int ID_EVENT_BASE = 0x44531000;
    /** 待审批通知 id 基址（0x44532000 ~ 0x44532FFF，与上面分开，两类可同时存在） */
    private static final int ID_APPROVAL_BASE = 0x44532000;
    /** 一个会话最多占 4096 个槽：真实场景（几十个会话）不会撞，撞了也只是两条通知互相覆盖 */
    private static final int ID_SLOT_MASK = 0x0FFF;
    /** PendingIntent 的 requestCode 基址（同一 requestCode + FLAG_UPDATE_CURRENT 会复用同一个 Intent） */
    private static final int REQUEST_OPEN_BASE = 0x445400;

    // ---------------------------------------------------------------- 体量与文案上限

    /** 快照最多认这么多条（页面推全量，几十个会话也够；超出的部分丢弃并回 ignored 计数） */
    private static final int MAX_ITEMS = 24;
    /** 汇总通知正文只列 3 条，其余折叠成「等 N 个」 */
    private static final int MAX_RUNNING_LINES = 3;
    /** 会话标题 / 工具名 / 摘要的截断长度：通知栏放不下长文本，服务器也可能回一大坨 */
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_CHARS = 40;
    private static final int MAX_DETAIL_CHARS = 200;
    /** 请求体上限：一份全量快照（24 条 × 每条约 300 字节）也远小于这个数 */
    private static final int MAX_BODY_BYTES = 64 * 1024;

    // ---------------------------------------------------------------- 进程内的记账

    /**
     * 所有状态都放在**类**上而不是实例上：LocalServer 每次 Activity 重建都会 new 一个新的
     * handler，而通知是进程级的资源 —— 用实例字段的话，重建一次就再也取消不掉之前发的通知了。
     *
     * <p>两张表都按通知 id 记账（id 由会话 id 算出来，见 {@link #eventId}），键的数量上限就是
     * 「见过的会话数」，`/clear` 会把它们清空，不会无限增长。
     */
    private static final Object LOCK = new Object();
    /** 已发出的通知 id → 人类可读的说明（只用于 /state 诊断） */
    private static final Map<Integer, String> POSTED = new LinkedHashMap<Integer, String>();
    /** 去重表：通知 id → 内容摘要；摘要没变就只刷新、不重新响铃 */
    private static final Map<String, String> DIGESTS = new LinkedHashMap<String, String>();
    /**
     * 上一次快照里「还在等审批」的会话 id。
     *
     * <p>为什么单独记：待审批通知是 {@code setOngoing(true)}（滑不掉），如果页面处理完审批、
     * 快照里不再有这条，而原生不主动撤，它就会永远横在通知栏里 —— 用户自己也没法清。
     * 所以每次推快照都做一次对账：<b>上次在等、这次不在等 → 撤掉</b>。
     * 反向（这次在等、上次没有）不用做，正常的 notify 会把它画上去。
     */
    private static final Set<String> APPROVAL_SESSIONS = new HashSet<String>();
    /** 当前进行中的任务数（保活服务的常驻通知要显示它） */
    private static volatile int runningCount;
    /** 页面指定的「当前会话」，点汇总通知时带过去 */
    private static volatile String activeSessionId;

    private final Context application;

    RemoteNotifyHandler(Context context) {
        this.application = context == null ? null : context.getApplicationContext();
        if (application == null) {
            Log.w(TAG, "拿不到 Application 上下文：通知中心仍可调用，但一律回 not_ready");
        }
        // 先把渠道建出来：建渠道只依赖 NotificationManager，不需要前台，越早越稳
        ensureChannels(application);
        Log.i(TAG, "通知中心接口就绪");
    }

    // ---------------------------------------------------------------- 渠道

    /**
     * 建（或确认）`chatpad.work` 与 `chatpad.alert` 两个渠道。幂等，随时可以调。
     *
     * <p>8.0 起「没有渠道 = 没有通知」，而且渠道第一次建好之后**重要性就由用户说了算**
     * （再 createNotificationChannel 传别的 value 只会更新名字/描述，不会把用户调过的
     * importance 抢回来）。所以这里只在「第一次见这个 id」时定重要性，之后每次都只是确保它存在。
     */
    static void ensureChannels(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        if (app == null) {
            return;
        }
        try {
            NotificationManager manager =
                    (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            // minSdk 28 > 26：渠道 API 无条件可用，这里不需要 Build.VERSION 分支
            NotificationChannel work = new NotificationChannel(
                    CHANNEL_WORK, CHANNEL_WORK_NAME, NotificationManager.IMPORTANCE_LOW);
            work.setDescription(CHANNEL_WORK_DESCRIPTION);
            // LOW 本身就不响；再显式关掉声音/振动/灯，防止某些 ROM 把默认值改成响铃
            work.setSound(null, null);
            work.enableVibration(false);
            work.enableLights(false);
            work.setShowBadge(false);
            work.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(work);

            NotificationChannel alert = new NotificationChannel(
                    CHANNEL_ALERT, CHANNEL_ALERT_NAME, NotificationManager.IMPORTANCE_HIGH);
            alert.setDescription(CHANNEL_ALERT_DESCRIPTION);
            // 刻意**不**调 setSound(null)/enableVibration(false)：这一档就是要响一声。
            // IMPORTANCE_HIGH 在 8.0+ 才会弹横幅（HEADS UP），DEFAULT 只响不弹。
            alert.setShowBadge(true);
            alert.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(alert);

            // 保活前台服务那条通知的渠道也一起确保（它的重要性是 LOW，由服务自己建过；
            // 这里只补一次「万一服务还没起来、页面就先读权限快照」的顺序问题）
            RemoteKeepAliveService.ensureResidentChannel(app);
        } catch (RuntimeException broken) {
            // 渠道被 ROM 删除 / NotificationManager 被禁：不能把调用方打崩，记一笔就够
            Log.w(TAG, "建通知渠道失败", broken);
        }
    }

    /**
     * 某个渠道的现状，给诊断接口和权限中心共用。
     *
     * <p>{@code blocked} 的口径与 {@link KeepAliveHandler} 的通知判定一致：<b>渠道不存在</b>
     * 或 {@code importance == IMPORTANCE_NONE} 都算「看不见」。
     *
     * @return 永远不为 null（读失败时给一个 blocked=true 的兜底对象）
     */
    static JSONObject channelJson(Context context, String channelId) {
        JSONObject json = new JSONObject();
        try {
            json.put("id", channelId);
            Context app = context == null ? null : context.getApplicationContext();
            NotificationManager manager = app == null ? null
                    : (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                json.put("blocked", true);
                json.put("reason", "no_manager");
                return json;
            }
            NotificationChannel channel = manager.getNotificationChannel(channelId);
            if (channel == null) {
                // 不存在 = 发出去也不会显示（8.0 的静默丢弃），按「不可见」报，别粉饰
                json.put("blocked", true);
                json.put("exists", false);
                return json;
            }
            int importance = channel.getImportance();
            json.put("exists", true);
            json.put("name", channel.getName() == null ? "" : channel.getName().toString());
            json.put("importance", importance);
            json.put("blocked", importance == NotificationManager.IMPORTANCE_NONE);
            return json;
        } catch (JSONException impossible) {
            // 键名都是字面量，走不到这里；兜一层免得 JSONException 冒到路由层
            Log.w(TAG, "组装渠道 JSON 失败", impossible);
            return new JSONObject();
        } catch (RuntimeException broken) {
            Log.d(TAG, "读渠道状态失败：" + channelId, broken);
            try {
                json.put("blocked", true);
            } catch (JSONException ignored) {
                // 同上，不会发生
            }
            return json;
        }
    }

    // ---------------------------------------------------------------- 路由

    /**
     * 与其它 handler 保持同一个签名与返回值约定。
     *
     * @return true 表示这条连接必须关闭
     */
    boolean handle(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws IOException {
        try {
            return route(method, path, headers, in, out, keepAlive);
        } catch (HttpError refused) {
            // 请求体可能没读完：一律关连接，残留字节会被当成下一个请求
            Log.w(TAG, path + " -> " + refused.status + " " + refused.getMessage());
            HttpUtil.sendJson(out, refused.status, false, errorJson(refused.getMessage()));
            return true;
        } catch (IOException writeFailed) {
            // 写响应失败（页面已经走了），交给 LocalServer 收尾
            throw writeFailed;
        } catch (Exception failure) {
            // 通知/JSON 的异常都不能冒泡到 LocalServer 把连接打死
            Log.w(TAG, "通知接口失败：" + path, failure);
            HttpUtil.sendJson(out, 500, false, errorJson(describe(failure)));
            return true;
        }
    }

    private boolean route(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws Exception {
        if (PATH_STATE.equals(path) || PATH_STATE_PROBE.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, stateJson().toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_OPEN.equals(path) || PATH_OPEN_PROBE.equals(path)) {
            // 只读语义：这条 GET 会**消费**掉一次投递（读后清空），所以必须挡住 POST 之类的重放
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, openJson().toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_WORK.equals(path)) {
            requirePost(method);
            JSONObject result = applyWork(readBody(in, headers));
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_CLEAR.equals(path)) {
            requirePost(method);
            JSONObject result = clearNotifications(readBody(in, headers));
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }

        // 未知子路径给 404：旧 APK 上这些是 200 HTML（SPA 回落），新 APK 上打错路径要能立刻看出来
        throw new HttpError(404, "not_found");
    }

    // ---------------------------------------------------------------- 动作：推快照

    /**
     * 按页面推来的快照对齐通知栏。
     *
     * <p>语义是「**当前态**」而不是「增量」：页面每次把进行中的全部会话 + 最近完成/待审批的事件
     * 一起推来，原生据此重画。所以空数组等于「没有进行中的任务」，汇总通知会被撤掉。
     */
    private JSONObject applyWork(String rawBody) throws JSONException {
        Context app = requireApplication();
        JSONObject body = parseJsonObject(rawBody);
        if (!body.has("items")) {
            // 明确要求 items：缺字段时「清空全部」这种猜测太危险（一个拼错的键就静默清屏）
            throw new HttpError(400, "bad_body");
        }
        JSONArray array = body.optJSONArray("items");
        if (array == null) {
            throw new HttpError(400, "bad_items");
        }

        String requestedActive = readString(body, "activeSessionId");
        int ignored = 0;
        List<Item> items = new ArrayList<Item>();
        int limit = array.length() > MAX_ITEMS ? MAX_ITEMS : array.length();
        for (int index = 0; index < limit; index++) {
            Item item = Item.parse(array.optJSONObject(index));
            if (item == null) {
                ignored++;
                continue;
            }
            items.add(item);
        }
        if (array.length() > MAX_ITEMS) {
            ignored += array.length() - MAX_ITEMS;
        }

        List<Item> running = new ArrayList<Item>();
        List<Item> events = new ArrayList<Item>();
        for (int index = 0; index < items.size(); index++) {
            Item item = items.get(index);
            if (STATE_RUNNING.equals(item.state)) {
                running.add(item);
            } else {
                events.add(item);
            }
        }

        // 刷新渠道：页面真的在推快照了，说明用户就要看到通知，任何一次渠道丢失都要在这里补回来
        ensureChannels(app);

        List<Integer> posted = new ArrayList<Integer>();
        int alerts = 0;
        List<Integer> cleared = new ArrayList<Integer>();
        synchronized (LOCK) {
            activeSessionId = requestedActive;
            if (running.isEmpty()) {
                // 一条进行中都没有：汇总通知必须撤掉（不然它会一直挂在通知栏上）
                cancel(cleared, ID_SUMMARY);
            } else {
                Notification summary = buildSummary(running);
                if (summary != null) {
                    notify(posted, ID_SUMMARY, summary,
                            "汇总 · " + running.size() + " 个任务进行中",
                            "summary|" + running.size() + "|" + running.get(0).line());
                }
            }
            Set<String> stillWaiting = new HashSet<String>();
            for (int index = 0; index < events.size(); index++) {
                Item item = events.get(index);
                Notification event = buildEvent(item);
                if (event == null) {
                    continue;
                }
                int id = idFor(item);
                // 摘要里同时带 ts 与正文：内容变了才算「新事件」，否则只刷新、不重新响铃
                if (notify(posted, id, event, item.state + " · " + item.title,
                        item.sessionId + "|" + item.digest())) {
                    alerts++;
                }
                if (STATE_APPROVAL.equals(item.state)) {
                    stillWaiting.add(item.sessionId);
                }
            }
            // 快照对账：上次在等审批、这次不等了 → 那条 ongoing 通知必须撤掉（否则滑不掉）
            if (!APPROVAL_SESSIONS.isEmpty()) {
                List<String> finished = new ArrayList<String>();
                for (String sessionId : APPROVAL_SESSIONS) {
                    if (!stillWaiting.contains(sessionId)) {
                        finished.add(sessionId);
                    }
                }
                for (int index = 0; index < finished.size(); index++) {
                    String sessionId = finished.get(index);
                    cancel(cleared, approvalId(sessionId));
                    APPROVAL_SESSIONS.remove(sessionId);
                }
            }
            APPROVAL_SESSIONS.addAll(stillWaiting);
            runningCount = running.size();
        }

        // 常驻通知的文案要跟着变（「正在保持远程连接 · N 个任务」）
        RemoteKeepAliveService.setActiveWorkCount(app, running.size());

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("granted", KeepAliveHandler.isNotificationVisible(app));
        result.put("channelBlocked", KeepAliveHandler.isNotificationChannelBlocked(app));
        result.put("running", running.size());
        result.put("alerts", alerts);
        result.put("ignored", ignored);
        result.put("posted", toArray(posted));
        result.put("cleared", toArray(cleared));
        result.put("groupKey", GROUP_KEY);
        return result;
    }

    // ---------------------------------------------------------------- 动作：清通知

    /**
     * 清通知：带 {@code sessionId} 只清这个会话，不带就清掉全部工作通知。
     *
     * <p>绝不碰 {@link RemoteKeepAliveService#NOTIFICATION_ID}（前台服务那条常驻通知）：
     * 撤掉它等于让服务失去前台地位，后台存活时间会从小时级掉回秒级。
     */
    private JSONObject clearNotifications(String rawBody) throws JSONException {
        Context app = requireApplication();
        String sessionId = "";
        JSONObject body = parseOptionalJsonObject(rawBody);
        if (body != null) {
            String value = readString(body, "sessionId");
            if (value != null) {
                sessionId = value;
            }
        }

        List<Integer> cleared = new ArrayList<Integer>();
        synchronized (LOCK) {
            if (sessionId.isEmpty()) {
                cancel(cleared, ID_SUMMARY);
                // 记账表里的每个 id 都要撤；cancel 会自己从 POSTED 里删，所以先拷贝一份 key
                List<Integer> known = new ArrayList<Integer>(POSTED.keySet());
                for (int index = 0; index < known.size(); index++) {
                    Integer id = known.get(index);
                    if (id == null || id.intValue() == ID_SUMMARY) {
                        continue;
                    }
                    cancel(cleared, id.intValue());
                }
                POSTED.clear();
                DIGESTS.clear();
                APPROVAL_SESSIONS.clear();
                runningCount = 0;
                activeSessionId = null;
            } else {
                // 固定 id 算法：进程重启后也能算出同样的 id，不依赖进程内记账
                cancel(cleared, eventId(sessionId));
                cancel(cleared, approvalId(sessionId));
                APPROVAL_SESSIONS.remove(sessionId);
            }
        }
        RemoteKeepAliveService.setActiveWorkCount(app, runningCount);

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("cleared", toArray(cleared));
        result.put("running", runningCount);
        return result;
    }

    // ---------------------------------------------------------------- 通知构建

    /**
     * 进行中汇总：一条通知装下所有会话。
     *
     * <p>样式选择：{@link Notification.InboxStyle}（API 16+）＋ {@code setNumber}。
     * 超过 {@link #MAX_RUNNING_LINES} 条只列前 3 条，末尾一行「等 N 个」——
     * 通知栏高度有限，列满会撑成一张卡片，反而看不清重点。
     */
    private Notification buildSummary(List<Item> running) {
        if (running.isEmpty()) {
            return null;
        }
        Context app = application;
        if (app == null) {
            return null;
        }
        int total = running.size();
        String title = "Chat Pad · " + total + " 个任务进行中";
        String first = running.get(0).line();
        try {
            Notification.Builder builder = newBuilder(CHANNEL_WORK);
            builder.setContentTitle(title);
            builder.setContentText(first);
            Notification.InboxStyle style = new Notification.InboxStyle();
            style.setBigContentTitle(title);
            int shown = total > MAX_RUNNING_LINES ? MAX_RUNNING_LINES : total;
            for (int index = 0; index < shown; index++) {
                style.addLine(running.get(index).line());
            }
            if (total > shown) {
                style.addLine("等 " + total + " 个任务");
                style.setSummaryText("等 " + total + " 个");
            }
            builder.setStyle(style);
            // 数字角标：8.0+ 由渠道的 badge 控制，桌面图标上的数字仍能显示
            builder.setNumber(total);
            builder.setGroup(GROUP_KEY);
            // 只响一次：汇总一直在更新（换工具/加任务），每次都响就没法用了
            builder.setOnlyAlertOnce(true);
            // 刻意**不**给汇总设 setOngoing(true)：
            //  · 用户要的「常驻」由保活前台服务那条通知承载（它带「· N 个任务」，系统也不许它消失）；
            //  · 汇总只是详情，允许滑掉 —— 否则应用被杀之后会留下一条谁都清不掉的「N 个任务进行中」，
            //    而且 ongoing 通知连用户自己都没法处理。滑掉后下一次快照会自动画回来。
            builder.setShowWhen(false);
            builder.setCategory(Notification.CATEGORY_PROGRESS);
            builder.setVisibility(Notification.VISIBILITY_PRIVATE);
            builder.setContentIntent(contentIntent(activeSessionId));
            return builder.build();
        } catch (RuntimeException broken) {
            // 渠道被删 / targetSdk 34 的权限 / ROM 魔改：通知发不出去也不能让 HTTP 线程崩
            Log.w(TAG, "构建汇总通知失败", broken);
            return null;
        }
    }

    /** 完成 / 出错 / 待审批：每个会话一条独立通知，点一下回到 App。 */
    private Notification buildEvent(Item item) {
        Context app = application;
        if (app == null) {
            return null;
        }
        String channel = STATE_RUNNING.equals(item.state) ? CHANNEL_WORK : CHANNEL_ALERT;
        try {
            Notification.Builder builder = newBuilder(channel);
            String stateText = describeState(item.state);
            builder.setContentTitle(item.title + " · " + stateText);
            builder.setContentText(item.detailText());
            builder.setGroup(GROUP_KEY);
            builder.setContentIntent(contentIntent(item.sessionId));
            builder.setVisibility(Notification.VISIBILITY_PRIVATE);
            if (STATE_APPROVAL.equals(item.state)) {
                // 待审批：要用户真的看见。setOngoing 让它可以横在通知栏里等着被处理，
                // 但**不**用 fullScreenIntent —— 那会在锁屏上直接盖一个全屏页，太侵略
                builder.setOngoing(true);
                builder.setCategory(Notification.CATEGORY_REMINDER);
                // 7.1 及以下看这一行；8.0+ 由 chatpad.alert 的 importance 决定（同样是高）
                builder.setPriority(Notification.PRIORITY_HIGH);
            } else {
                // 完成 / 出错：点一下就消失
                builder.setAutoCancel(true);
                builder.setCategory(Notification.CATEGORY_MESSAGE);
                builder.setPriority(Notification.PRIORITY_DEFAULT);
            }
            return builder.build();
        } catch (RuntimeException broken) {
            Log.w(TAG, "构建事件通知失败", broken);
            return null;
        }
    }

    /** 所有通知共用的底座：小图标、渠道、代理跳转。 */
    private Notification.Builder newBuilder(String channelId) {
        Notification.Builder builder = new Notification.Builder(application, channelId);
        // 工程里没有专门的单色通知图标，复用启动图标（通知栏渲染成白色剪影，可接受）
        builder.setSmallIcon(R.mipmap.ic_launcher);
        // 点通知的兜底 intent：具体通知会再覆盖一次（带 sessionId）
        builder.setContentIntent(contentIntent(null));
        return builder;
    }

    /**
     * 点通知回到 MainActivity，并把会话 id 塞进 extra。
     *
     * <p>requestCode 按 sessionId 区分：同一 requestCode 配 {@code FLAG_UPDATE_CURRENT} 会复用
     * 同一个 PendingIntent，结果是「点哪条都打开最后一次那个会话」——这是 Android 上很常见的坑。
     */
    private PendingIntent contentIntent(String sessionId) {
        Context app = application;
        Intent open = new Intent(app, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String value = sessionId == null ? "" : sessionId;
        if (!value.isEmpty()) {
            open.putExtra(EXTRA_SESSION_ID, value);
        }
        // FLAG_IMMUTABLE：API 23+，targetSdk 31+ 强制；minSdk 28 不需要版本分支
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        int request = REQUEST_OPEN_BASE + (value.isEmpty() ? 0 : (hash(value) & ID_SLOT_MASK));
        try {
            return PendingIntent.getActivity(app, request, open, flags);
        } catch (RuntimeException broken) {
            // 极少数 ROM 在包被停用时抛；退化成「只回 App、不带会话」
            Log.w(TAG, "构建 PendingIntent 失败", broken);
            Intent fallback = new Intent(app, MainActivity.class);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            return PendingIntent.getActivity(app, 0, fallback, flags);
        }
    }

    // ---------------------------------------------------------------- 幂等的发送 / 撤销

    /**
     * 发一条通知并记账。
     *
     * <p>去重在这里：同 id 的「内容摘要」没变就只更新、不重新响铃。返回 false 表示这次只是
     * 刷新（没有新事件），调用方据此统计「这次真的发了几条」。
     */
    private boolean notify(List<Integer> posted, int id, Notification notification, String label,
            String digest) {
        NotificationManager manager = manager();
        if (manager == null) {
            return false;
        }
        String key = String.valueOf(id);
        String previous = DIGESTS.get(key);
        try {
            manager.notify(id, notification);
        } catch (RuntimeException broken) {
            // 渠道被删 / 权限被撤 / NotificationManager 被禁：静默丢弃，别打断 HTTP
            Log.w(TAG, "发送通知失败：" + label, broken);
            return false;
        }
        POSTED.put(Integer.valueOf(id), label);
        posted.add(Integer.valueOf(id));
        boolean changed = digest == null || !digest.equals(previous);
        if (changed && digest != null) {
            DIGESTS.put(key, digest);
        }
        // 只刷新的那一次也记进 posted，但不算新事件（不重新响铃）
        return changed;
    }

    /** 撤一条；真的撤掉了（之前记过账）才写进 cleared。 */
    private boolean cancel(List<Integer> cleared, int id) {
        NotificationManager manager = manager();
        if (manager == null) {
            return false;
        }
        try {
            manager.cancel(id);
        } catch (RuntimeException broken) {
            Log.d(TAG, "撤销通知失败：" + id, broken);
            return false;
        }
        DIGESTS.remove(String.valueOf(id));
        boolean known = POSTED.remove(Integer.valueOf(id)) != null;
        if (known) {
            cleared.add(Integer.valueOf(id));
        }
        return known;
    }

    private NotificationManager manager() {
        Context app = application;
        if (app == null) {
            return null;
        }
        return (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    // ---------------------------------------------------------------- 动作：点通知直达

    /**
     * 取走一次「点通知要打开的会话」。
     *
     * <p>三个字段各有用途：
     * <ul>
     *   <li>{@code pendingSessionId}：会话 id，空串 = 这次没有（页面不用判 null）；</li>
     *   <li>{@code hasPending}：与上面同义，但留一个布尔是给「页面只想探测能力、不想消费」
     *       之类将来可能的用法留位（现在页面两个都用，自己判断）；</li>
     *   <li>{@code rev}：累计投递次数（页面的排障日志里带上它，就能区分「同一条读了两次」
     *       和「又来了一条新的」）。</li>
     * </ul>
     *
     * <p><b>消费语义</b>：这个 GET 一执行，MainActivity 里的信箱就被清空了。所以它不是
     * 幂等查询 —— 同一份状态读两次，第二次一定是空串。这正是要的：点一次通知只开一次会话。
     */
    private static JSONObject openJson() throws JSONException {
        JSONObject json = new JSONObject();
        String pending = MainActivity.consumePendingSessionId();
        json.put("ok", true);
        json.put("pendingSessionId", pending);
        json.put("hasPending", !pending.isEmpty());
        json.put("rev", MainActivity.pendingSessionRev());
        return json;
    }

    // ---------------------------------------------------------------- 诊断

    private JSONObject stateJson() throws JSONException {
        Context app = application;
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("sdkInt", Build.VERSION.SDK_INT);
        json.put("granted", app != null && KeepAliveHandler.isNotificationVisible(app));
        json.put("permissionGranted", app != null && KeepAliveHandler.isNotificationPermissionGranted(app));
        json.put("channelBlocked", app != null && KeepAliveHandler.isNotificationChannelBlocked(app));
        json.put("canRequest", app != null && KeepAliveHandler.canRequestNotifications(app));
        json.put("groupKey", GROUP_KEY);
        json.put("channelId", CHANNEL_WORK);
        json.put("alertChannelId", CHANNEL_ALERT);
        json.put("channels", channelsJson(app));
        json.put("running", runningCount);
        json.put("activeSessionId", activeSessionId == null ? "" : activeSessionId);
        synchronized (LOCK) {
            List<Integer> ids = new ArrayList<Integer>(POSTED.keySet());
            json.put("posted", toArray(ids));
            json.put("postedCount", ids.size());
            // 当前还在等审批的会话数（这些通知是 ongoing，页面处理完要推一次快照或 /clear）
            json.put("approvals", APPROVAL_SESSIONS.size());
        }
        return json;
    }

    private static JSONArray channelsJson(Context app) {
        ensureChannels(app);
        JSONArray array = new JSONArray();
        array.put(channelJson(app, CHANNEL_WORK));
        array.put(channelJson(app, CHANNEL_ALERT));
        array.put(channelJson(app, RemoteKeepAliveService.CHANNEL_ID));
        return array;
    }

    private static JSONArray toArray(List<Integer> values) {
        JSONArray array = new JSONArray();
        if (values == null) {
            return array;
        }
        for (int index = 0; index < values.size(); index++) {
            Integer value = values.get(index);
            if (value != null) {
                array.put(value.intValue());
            }
        }
        return array;
    }

    // ---------------------------------------------------------------- id / 去重键

    /** 完成或出错：一个会话一个 id（状态变化就地替换，不会堆两条）。 */
    private static int eventId(String sessionId) {
        return ID_EVENT_BASE + (hash(sessionId) & ID_SLOT_MASK);
    }

    /** 待审批：与上面分开，所以同一会话可以「已发待审批」+「上一条已完成」同时存在。 */
    private static int approvalId(String sessionId) {
        return ID_APPROVAL_BASE + (hash(sessionId) & ID_SLOT_MASK);
    }

    private static int idFor(Item item) {
        return STATE_APPROVAL.equals(item.state) ? approvalId(item.sessionId) : eventId(item.sessionId);
    }

    /** 稳定的哈希（不用 String.hashCode 是为了跨版本一致；本处其实只需要进程内一致）。 */
    private static int hash(String value) {
        if (value == null || value.isEmpty()) {
            return 0;
        }
        int result = 17;
        for (int index = 0; index < value.length(); index++) {
            result = result * 31 + value.charAt(index);
        }
        return result < 0 ? -result : result;
    }

    // ---------------------------------------------------------------- 数据模型

    /** 页面推来的一条任务。字段全部在 parse 里校验/截断，后面用的时候不用再判空。 */
    private static final class Item {

        final String sessionId;
        final String title;
        final String state;
        final String tool;
        final String detail;
        final long ts;

        private Item(String sessionId, String title, String state, String tool, String detail,
                long ts) {
            this.sessionId = sessionId;
            this.title = title;
            this.state = state;
            this.tool = tool;
            this.detail = detail;
            this.ts = ts;
        }

        /**
         * @return 解析出来的条目；sessionId 缺失、state 不在白名单里都返回 null
         *         （调用方计入 ignored，绝不猜）
         */
        static Item parse(JSONObject raw) {
            if (raw == null) {
                return null;
            }
            String sessionId = readString(raw, "sessionId");
            if (sessionId == null || sessionId.isEmpty()) {
                return null;
            }
            String state = normalizeState(readString(raw, "state"));
            if (state == null) {
                return null;
            }
            String title = clip(readString(raw, "title"), MAX_TITLE_CHARS);
            if (title.isEmpty()) {
                title = "会话";
            }
            String tool = clip(readString(raw, "tool"), MAX_TOOL_CHARS);
            String detail = clip(readString(raw, "detail"), MAX_DETAIL_CHARS);
            long ts = 0L;
            try {
                ts = raw.optLong("ts", 0L);
            } catch (RuntimeException broken) {
                ts = 0L;
            }
            return new Item(sessionId, title, state, tool, detail, ts);
        }

        /** InboxStyle 的一行：会话名 + 当前工具（没有工具就写「进行中」）。 */
        String line() {
            if (!tool.isEmpty()) {
                return title + " · 正在调用 " + tool;
            }
            return title + " · 进行中";
        }

        /** 事件通知的正文：优先 detail（最后一条摘要），没有就给一句默认话。 */
        String detailText() {
            if (!detail.isEmpty()) {
                return detail;
            }
            if (STATE_APPROVAL.equals(state)) {
                return "有一个操作需要你确认";
            }
            if (STATE_ERROR.equals(state)) {
                return "任务出错了，点一下查看";
            }
            return "任务已完成，点一下查看";
        }

        /** 去重摘要：状态/时间戳/正文任一变化都算新事件。 */
        String digest() {
            return state + "|" + ts + "|" + tool + "|" + detail;
        }
    }

    // ---------------------------------------------------------------- 请求体

    private Context requireApplication() {
        Context app = application;
        if (app == null) {
            throw new HttpError(500, "no_context");
        }
        return app;
    }

    /**
     * 读请求体（上限 {@link #MAX_BODY_BYTES}）；超限/分块一律 4xx。
     *
     * <p>与 {@link KeepAliveHandler} 同一套写法：先把 Content-Length 声明的字节读干净再回包，
     * 不读就关连接会让内核发 RST，Chromium 可能把已经写出去的响应当成失败。
     */
    private static String readBody(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared <= 0L) {
            return "";
        }
        if (declared > MAX_BODY_BYTES) {
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

    /** {@code /clear} 允许空体（= 清全部），所以这里空体返回 null 而不是 400。 */
    private static JSONObject parseOptionalJsonObject(String raw) {
        if (raw == null) {
            return null;
        }
        String text = raw.trim();
        if (text.isEmpty()) {
            return null;
        }
        try {
            return new JSONObject(text);
        } catch (JSONException malformed) {
            throw new HttpError(400, "bad_body");
        }
    }

    /** 读字符串字段：缺失/类型不对回 null，前后空白去掉。 */
    private static String readString(JSONObject body, String key) {
        if (body == null) {
            return null;
        }
        try {
            String value = body.optString(key, null);
            if (value == null) {
                return null;
            }
            return value.trim();
        } catch (RuntimeException broken) {
            return null;
        }
    }

    /** state 白名单：只认这三种事件的字面量，别的一律丢弃（拼错的 state 不该发一条空通知）。 */
    private static String normalizeState(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.trim().toLowerCase(Locale.US);
        if (STATE_RUNNING.equals(value) || STATE_DONE.equals(value) || STATE_ERROR.equals(value)
                || STATE_APPROVAL.equals(value)) {
            return value;
        }
        // 页面可能用 'waiting' / 'confirm' 之类的同义词：都归到 approval
        if ("waiting".equals(value) || "confirm".equals(value) || "approve".equals(value)) {
            return STATE_APPROVAL;
        }
        if ("success".equals(value) || "finished".equals(value) || "complete".equals(value)) {
            return STATE_DONE;
        }
        if ("failed".equals(value) || "fail".equals(value)) {
            return STATE_ERROR;
        }
        return null;
    }

    private static String describeState(String state) {
        if (STATE_ERROR.equals(state)) {
            return "出错";
        }
        if (STATE_APPROVAL.equals(state)) {
            return "等待你审核";
        }
        if (STATE_RUNNING.equals(state)) {
            return "进行中";
        }
        return "已完成";
    }

    /** 截断（按字符，不按字节：中文一个字也是 1，通知栏按字符算宽度更接近实际）。 */
    private static String clip(String value, int max) {
        if (value == null) {
            return "";
        }
        String text = value.replace('\n', ' ').replace('\r', ' ').trim();
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max - 1) + "…";
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
