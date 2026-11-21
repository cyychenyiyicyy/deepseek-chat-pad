package ai.deepseek.tablet;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * 「远程连接保活」前台服务。
 *
 * <p>为什么需要它：用户一切到后台，本进程就是普通优先级，系统（尤其是国产 ROM）几秒内就把它
 * 回收掉，页面持有的 WebSocket 一断，远程会话就卡在那儿不动了 —— 这就是真机反馈的
 * 「稍微退到后台一下，后台就被杀掉了」。挂一个前台服务能把进程提到「前台服务」优先级，
 * 再配合系统「忽略电池优化」白名单，后台存活时间才会从秒级变成小时级。
 *
 * <p>本类只做四件事：
 * <ol>
 *   <li>建一条低打扰的通知渠道（{@code IMPORTANCE_LOW}、无声、无振动、无角标）——
 *       Android 8 起前台服务的通知必须挂在渠道上，否则 startForeground 直接抛异常</li>
 *   <li>{@link #onCreate()} 里立刻 {@code startForeground}。只要调用方用的是
 *       {@code startForegroundService()}，系统就要求 5 秒内把通知挂上，否则抛
 *       {@code RemoteServiceException}（现场表现是「应用无响应/闪一下挂了」）。
 *       放在 onCreate 是唯一不会漏的时机：onStartCommand 里一旦提前 return 就漏了</li>
 *   <li>{@link #START_STICKY}：被系统杀掉后由系统自己把服务拉回来（不重建页面，只恢复服务与通知）</li>
 *   <li>维护一个「页面希望保活」的持久标志（SharedPreferences）。进程被杀后重启、或 Activity 被
 *       重建时，{@code MainActivity.onResume} 据此自愈，页面不必等远程重连成功才想起来再要一次</li>
 * </ol>
 *
 * <p>刻意<b>不</b>做的事：
 * <ul>
 *   <li><b>不持 WakeLock</b>。常驻 CPU 锁非常费电，而且对「进程被系统回收」这件事几乎无帮助
 *       （回收优先级看的是进程状态，不是有没有锁）。清单里声明 {@code WAKE_LOCK} 只是让页面在
 *       必要时（例如长任务流式输出、屏幕熄灭后仍要收数据）自己临时申请，这里绝不开锁</li>
 *   <li>不绑定（{@link #onBind} 返回 null）：没有谁需要约束住它</li>
 *   <li>不碰 WebSocket / 网络：连接由页面持有，这里只负责让进程活着</li>
 *   <li>不搞任何「重启 Activity / 拉起界面」的动作：后台被清理时把界面拉回前台，用户体验是
 *       「应用自己跳出来了」，比被杀更糟</li>
 * </ul>
 *
 * <p>版本分支（minSdk 28 / targetSdk 34，详见 input-K1-后台保活.md 的版本矩阵）：
 * <ul>
 *   <li>API 26+：{@link NotificationChannel} 与双参 {@code Notification.Builder} 恒可用，
 *       所以本文件不做 API 等级分支（minSdk 28 已经高于 26）</li>
 *   <li>API 29+：{@code startForeground(id, notif, type)} 三参重载可用，带上
 *       {@link ServiceInfo#FOREGROUND_SERVICE_TYPE_DATA_SYNC}；API 34 起这个类型是<b>强制</b>的，
 *       清单里也必须写同一个 {@code foregroundServiceType}</li>
 *   <li>API 28：还没有 foregroundServiceType 概念，只能走两参重载</li>
 * </ul>
 */
public final class RemoteKeepAliveService extends Service {

    private static final String TAG = "DsKeepAlive";

    /** 通知渠道 id：同名渠道重复 createNotificationChannel 是幂等的，不会报错 */
    static final String CHANNEL_ID = "ds_keepalive";
    private static final CharSequence CHANNEL_NAME = "远程连接保活";
    private static final String CHANNEL_DESCRIPTION = "远程会话在后台保持连接时常驻，退出应用后自动消失";

    /** 常驻通知的 id。固定值：重复 startForeground 只会刷新这一条，不会叠出一堆通知 */
    static final int NOTIFICATION_ID = 0x44530001;

    /** 点通知回到对话窗口用的 requestCode */
    private static final int REQUEST_OPEN_APP = 0x4453;

    static final String ACTION_START = "ai.deepseek.tablet.action.KEEPALIVE_START";
    static final String ACTION_STOP = "ai.deepseek.tablet.action.KEEPALIVE_STOP";
    /**
     * 页面/调试脚本可能直接把 action 传成 "start" / "stop"（Intent 的 action 只是字符串）。
     * 两种写法都认，省得前端为了拼常量去猜包名前缀。
     */
    private static final String ACTION_START_SHORT = "start";
    private static final String ACTION_STOP_SHORT = "stop";

    /** 「页面希望保活」标志的落盘位置。故意用独立 pref 文件，别和应用设置混在一起 */
    private static final String PREFS_NAME = "dsp.keepalive.v1";
    private static final String KEY_SHOULD_RUN = "should_run";

    private static final String TITLE = "Chat Pad 正在保持远程连接";
    private static final String CONTENT = "远程会话在后台继续；点一下回到对话，退出应用后自动停止";

    /**
     * 服务是否活着。只在本进程内有意义（进程被杀后静态变量自然没了），
     * 所以它回答的是「现在有没有一条前台服务在跑」，而不是「用户配过没有」。
     */
    private static volatile boolean running;

    // ---------------------------------------------------------------- 生命周期

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        // 这里**不**写「应当保活」标志：onCreate 也可能来自系统按 START_STICKY 的静默重建
        // （那时页面早就不在了），先写就把 onStartCommand 里「没人认领就退出」的判断废掉了。
        // 标志只由 start(Context) 与 ACTION_START 负责置真。
        try {
            createChannel();
            startForegroundCompat(buildNotification());
            Log.i(TAG, "保活前台服务已启动");
        } catch (RuntimeException failed) {
            // 极端情况：渠道被用户/ROM 删掉、通知权限被禁、厂商魔改 startForeground。
            // 绝不能留成「startForegroundService 进来但没 startForeground」的状态 ——
            // 系统会抛 RemoteServiceException，比服务起不来更难查。
            Log.w(TAG, "前台通知挂不上，服务直接退出", failed);
            running = false;
            markShouldRun(this, false);
            stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action) || ACTION_STOP_SHORT.equals(action)) {
            Log.i(TAG, "收到 stop：撤掉前台通知并退出");
            // 先清标志再退：这样即使被系统按粘性策略拉回来，也不会没有页面却抢着挂前台
            markShouldRun(this, false);
            running = false;
            dropForeground();
            stopSelf();
            return START_NOT_STICKY;
        }

        // intent 为 null = 系统按 START_STICKY 把服务重建起来了。
        // 如果页面早就不要保活了（标志 false），就别留一条「没人认领」的常驻通知。
        if (action == null && !shouldRun(this)) {
            Log.i(TAG, "系统重建服务但页面不再需要保活，直接退出");
            running = false;
            dropForeground();
            stopSelf();
            return START_NOT_STICKY;
        }

        // ACTION_START / 动作不明的重复启动 / 系统重建后页面仍需要：都按「要保活」处理。
        // 这里是幂等的：onCreate 已经挂过通知，再挂一次只是把通知刷新一遍。
        markShouldRun(this, true);
        running = true;
        try {
            startForegroundCompat(buildNotification());
        } catch (RuntimeException refreshFailed) {
            // 刷新失败不该把已经在跑的服务打掉：保持非前台形态继续（页面可从 /state 看到 running）
            Log.w(TAG, "刷新前台通知失败", refreshFailed);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "保活前台服务销毁");
        running = false;
        // 注意：这里**不**清「应当保活」标志。onDestroy 也可能是系统自己收的（换机型、
        // 低内存清理），保留标志才能让 onResume 自愈；真正不要了的路径是 stop()/ACTION_STOP，
        // 它们会先把标志清掉再进来。
        dropForeground();
        super.onDestroy();
    }

    /** 不提供绑定：没有谁需要约束住这个服务（绑定还会让它更难被回收，反而是隐患）。 */
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------------------------------------------------------------- 对外静态入口

    /**
     * 页面要求保活：起前台服务（幂等，重复调用只是刷新通知）。
     *
     * @return false 表示系统拒绝或环境不可用；此时标志<b>故意不清</b>，
     *         等 {@code MainActivity.onResume} 在前台再补一次（前台几乎不会被拒）
     */
    static boolean start(Context context) {
        Context app = appContext(context);
        if (app == null) {
            Log.w(TAG, "没有可用的 Context，起不了前台服务");
            return false;
        }
        markShouldRun(app, true);
        Intent intent = new Intent(app, RemoteKeepAliveService.class);
        intent.setAction(ACTION_START);
        try {
            // minSdk 28 ≥ 26，Context.startForegroundService 恒可用，不需要 ContextCompat
            app.startForegroundService(intent);
            // 乐观置位：startForegroundService 是异步的，onCreate 要等主线程下一轮才跑，
            // 而此时 /start 的响应已经在拼 JSON 了。只要系统收下了这次调用，服务就会被创建
            // （除非进程立刻死掉），所以这里直接置 true，页面拿到的 running 才不会自相矛盾。
            // 真挂不上通知的情况下 onCreate 的 catch 会把它改回 false。
            running = true;
            return true;
        } catch (IllegalStateException deniedBySystem) {
            // Android 12+ 在后台禁止启动前台服务，抛 ForegroundServiceStartNotAllowedException
            // （它继承 IllegalStateException）。那个类 API 31 才有，这里只能 catch 父类。
            Log.w(TAG, "系统拒绝启动前台服务：" + deniedBySystem.getMessage());
            return false;
        } catch (RuntimeException failed) {
            Log.w(TAG, "前台服务启动失败", failed);
            return false;
        }
    }

    /** 页面/壳不再需要保活：停服务并清标志（这是唯一的「真停」入口）。 */
    static void stop(Context context) {
        Context app = appContext(context);
        if (app == null) {
            return;
        }
        markShouldRun(app, false);
        try {
            // 用 stopService 而不是发 ACTION_STOP 过去：API 26+ 在后台 startService() 会抛
            // IllegalStateException，而 stopService 任何时候都允许。
            // intent 里的 action 只是为了让日志/调试能看出来是谁停的。
            app.stopService(new Intent(app, RemoteKeepAliveService.class).setAction(ACTION_STOP));
        } catch (RuntimeException failed) {
            Log.w(TAG, "停止前台服务失败", failed);
        }
    }

    /** 服务此刻是否在跑（本进程视角）。 */
    static boolean isRunning() {
        return running;
    }

    /** 页面是否要求过保活。落盘的，跨进程重启仍然有效。 */
    static boolean shouldRun(Context context) {
        Context app = appContext(context);
        if (app == null) {
            return false;
        }
        try {
            return preferences(app).getBoolean(KEY_SHOULD_RUN, false);
        } catch (RuntimeException broken) {
            // SharedPreferences 读失败（极罕见的磁盘问题）按「没要求」处理
            return false;
        }
    }

    /**
     * 通知权限是否已授予。
     *
     * <p>{@code POST_NOTIFICATIONS} 是 Android 13 才有的运行时权限，13 以下恒可用。
     * 没授予时前台服务<b>照样能跑</b>，只是那条常驻通知不显示 —— 所以这不是硬前提，
     * 页面拿它来决定要不要提示用户「去开通知」。
     */
    static boolean isNotificationAllowed(Context context) {
        Context app = appContext(context);
        if (app == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        try {
            // 权限名是编译期字符串常量，API 33 以下也不会查表失败
            return app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException broken) {
            return false;
        }
    }

    /**
     * 是否已在系统「忽略电池优化」白名单里。
     *
     * <p>国产 ROM 里这一项比前台服务本身还关键：不在白名单里，前台服务也会被定时清理。
     * {@code isIgnoringBatteryOptimizations} 是 API 23 起就有的，minSdk 28 恒可用。
     */
    static boolean isBatteryExempt(Context context) {
        Context app = appContext(context);
        if (app == null) {
            return false;
        }
        PowerManager power = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        if (power == null) {
            return false;
        }
        try {
            return power.isIgnoringBatteryOptimizations(app.getPackageName());
        } catch (RuntimeException broken) {
            return false;
        }
    }

    // ---------------------------------------------------------------- 通知

    /** 建通知渠道：低打扰（无声、无振动、无角标、不亮屏），用户不会被打扰但看得到。 */
    private void createChannel() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        // minSdk 28 > 26：渠道 API 无条件可用，不需要 API 等级判断
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(CHANNEL_DESCRIPTION);
        // IMPORTANCE_LOW 本身就不响，这里再把声音/振动/灯显式关掉，防止 ROM 改过默认值
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.enableLights(false);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        // 点通知回到对话窗口：复用已有任务（CLEAR_TOP + SINGLE_TOP），不再叠一个壳出来
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // FLAG_IMMUTABLE 自 API 23 起可用（minSdk 28 恒有），而 targetSdk 31+ 又强制要求它，
        // 所以这里不需要任何版本分支；FLAG_UPDATE_CURRENT 让重复构建复用同一条 PendingIntent
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, REQUEST_OPEN_APP, open,
                pendingFlags);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
        // 工程里没有专门的单色通知图标，复用启动图标：通知栏上会渲染成白色剪影（可接受）。
        // 要更精致就得往 res/drawable 里加一张单色 icon，那超出本次改动范围。
        builder.setSmallIcon(R.mipmap.ic_launcher);
        builder.setContentTitle(TITLE);
        builder.setContentText(CONTENT);
        builder.setContentIntent(contentIntent);
        // 常驻：用户滑不掉，也保证它不会被当成「可清理」的通知
        builder.setOngoing(true);
        builder.setShowWhen(false);
        builder.setOnlyAlertOnce(true);
        builder.setVisibility(Notification.VISIBILITY_PUBLIC);
        builder.setCategory(Notification.CATEGORY_SERVICE);
        return builder.build();
    }

    /**
     * 挂前台通知。
     *
     * <p>API 29 起可以（也必须在 Android 14+ 上）带上服务类型；{@code dataSync} 表示
     * 「在后台同步数据」，正好对应「保持一条远程数据通道」。清单里的
     * {@code android:foregroundServiceType="dataSync"} 必须与这里一致，否则 API 34 抛
     * {@code MissingForegroundServiceTypeException}。
     */
    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 常量是 public static final int，编译期内联，API 28 上引用它也不会 NoSuchFieldError
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            // API 28 还没有 foregroundServiceType 概念，三参重载这时不存在，只能两参
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /** 撤掉前台通知（服务可能已经不在前台，所以吞掉异常）。 */
    private void dropForeground() {
        try {
            // API 24 起用整型常量；minSdk 28 恒可用，就不必碰 API 33 已废弃的 stopForeground(true)
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
            // 系统已经提前把我们从前台摘掉了：再收一次会抛 IllegalStateException，无所谓
        }
    }

    // ---------------------------------------------------------------- 小工具

    private static void markShouldRun(Context app, boolean value) {
        try {
            SharedPreferences prefs = preferences(app);
            boolean current = prefs.getBoolean(KEY_SHOULD_RUN, false);
            if (current == value) {
                // 值没变就不写盘：start() 在每次页面重连时都会被调，别做无谓 IO
                return;
            }
            prefs.edit().putBoolean(KEY_SHOULD_RUN, value).apply();
        } catch (RuntimeException failed) {
            Log.w(TAG, "保活标志写入失败", failed);
        }
    }

    private static SharedPreferences preferences(Context app) {
        return app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** LocalServer 拿到的是 Application context，这里统一兜一层，避免传 null 直接 NPE。 */
    private static Context appContext(Context context) {
        if (context == null) {
            return null;
        }
        Context app = context.getApplicationContext();
        return app != null ? app : context;
    }
}
