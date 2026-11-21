package ai.deepseek.tablet;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;

/**
 * 只监听 127.0.0.1 的极简 HTTP/1.1 服务器。
 *
 * <ul>
 *   <li>端口固定为 {@link #PREFERRED_PORT}，保证页面 origin 稳定（localStorage / IndexedDB 按 origin 隔离），
 *       只有端口被占用时才退回系统分配</li>
 *   <li>静态资源走 {@link AssetHandler}，/__ds_proxy 走 {@link ProxyHandler}，
 *       /__ds_update/* 走 {@link UpdateHandler}（分体式更新），
 *       /__ds_db/* 走 {@link DbHandler}（会话存储的原生 SQLite），
 *       /__ds_remote/* 走 {@link RemoteWsHandler}（远程 DSH 的原生 WebSocket 隧道桥），
 *       /__ds_auth/* 走 {@link RemoteAuthHandler}（应用内授权容器：全屏 Dialog + WebView，或交给
 *       系统浏览器；第三方登录在窗口里完成，登录结果由页面按 qrId 轮询服务端拿），
 *       /__ds_keepalive/* 走 {@link KeepAliveHandler}（后台保活前台服务 + 通用设置的权限中心：
 *       通知 / 省电 / 自启动 / 精确闹钟 / 悬浮窗 / 应用详情 / 流量 的状态与跳转）</li>
 *   <li>每个连接一个小循环支持 keep-alive，最多 256 个请求；/__ds_remote/ws 升级成 WebSocket 后
 *       整条连接交给 RemoteWsHandler 独占，隧道结束即关闭</li>
 *   <li>工作线程全部是 daemon，Activity 退出时不会把进程挂住</li>
 * </ul>
 */
public final class LocalServer {

    private static final String TAG = "DsLocalServer";
    private static final String HOST = "127.0.0.1";
    private static final int BACKLOG = 64;
    /** 固定端口：变一个号，WebView 的本地存储就换了一套，等于清空历史 */
    private static final int PREFERRED_PORT = 18888;
    /** 空闲 keep-alive 连接的读超时；也是读请求行的超时。 */
    private static final int IDLE_TIMEOUT_MS = 15_000;
    private static final int MAX_REQUESTS_PER_CONNECTION = 256;
    private static final String HEALTH_PATH = "/__ds_health";
    private static final String PROXY_PATH = "/__ds_proxy";

    private final AssetHandler assetHandler;
    private final ProxyHandler proxyHandler;
    private final WebBundle webBundle;
    private final UpdateHandler updateHandler;
    private final DbHandler dbHandler;
    private final RemoteWsHandler remoteWsHandler;
    private final RemoteAuthHandler remoteAuthHandler;
    private final KeepAliveHandler keepAliveHandler;
    /** Application context：停服务（RemoteKeepAliveService.stop）也要用它 */
    private final Context appContext;
    private final ExecutorService workers;
    private final AtomicInteger threadCounter = new AtomicInteger();
    private final AtomicBoolean running = new AtomicBoolean(false);

    private volatile ServerSocket serverSocket;
    private volatile int port = -1;
    private Thread acceptThread;

    public LocalServer(Context context, OkHttpClient httpClient) {
        Context resolved = context.getApplicationContext();
        Context base = resolved != null ? resolved : context;
        // 停服务时要用它（退出应用 = 后台保活也该停）
        this.appContext = base;
        // 网页包状态只有一份：静态资源与更新接口都读它
        this.webBundle = new WebBundle(base);
        this.assetHandler = new AssetHandler(base, webBundle);
        this.proxyHandler = new ProxyHandler(httpClient);
        this.updateHandler = new UpdateHandler(context, httpClient, webBundle, new ApkUpdater(base));
        // 会话存储用同一个 Application context：SQLiteOpenHelper 会一直持有它
        this.dbHandler = new DbHandler(base);
        // 远程桥自己建独立的 OkHttpClient（不能复用传入的那个：它挂着 HTTPS_ONLY_INTERCEPTOR）
        this.remoteWsHandler = new RemoteWsHandler();
        // 应用内授权容器（/__ds_auth/*）不需要 HTTP 客户端（网页由 WebView 自己加载），但要能拿到
        // Activity：MainActivity 传进来的是 Application context，所以它内部自己注册
        // ActivityLifecycleCallbacks 跟踪当前 resumed 的 Activity 来弹全屏 Dialog
        this.remoteAuthHandler = new RemoteAuthHandler(base);
        // 后台保活 + 权限中心（/__ds_keepalive/*）：同样靠 ActivityLifecycleCallbacks 定位当前
        // Activity（要弹通知权限框、要拉系统权限设置页），所以也传 Application context
        this.keepAliveHandler = new KeepAliveHandler(base);
        this.workers = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "ds-http-" + threadCounter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * 绑定回环地址并开始 accept。
     *
     * <p>端口优先用固定值：WebView 的 localStorage 和 IndexedDB 按 origin（含端口）隔离，
     * 端口一变历史对话就全丢了。所以先抢固定端口，抢不到（极少数端口占用）才退回系统分配，
     * 那种情况下本次会话数据仍在，只是下次启动读不到。
     *
     * @return 实际使用的端口
     */
    public synchronized int start() throws IOException {
        if (running.get() && serverSocket != null) {
            return port;
        }
        ServerSocket socket = null;
        try {
            socket = new ServerSocket(PREFERRED_PORT, BACKLOG, InetAddress.getByName(HOST));
        } catch (IOException preferredTaken) {
            Log.w(TAG, "port " + PREFERRED_PORT + " unavailable, falling back to an ephemeral port");
        }
        if (socket == null) {
            // 端口 0 = 交给系统挑一个空闲端口；第三个参数保证只监听回环
            socket = new ServerSocket(0, BACKLOG, InetAddress.getByName(HOST));
        }
        serverSocket = socket;
        port = socket.getLocalPort();
        running.set(true);
        int assignedPort = port;
        // lambda 只能捕获 effectively final，这里固定一份
        final ServerSocket bound = socket;
        acceptThread = new Thread(() -> acceptLoop(bound), "ds-http-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        Log.i(TAG, "listening on " + HOST + ":" + assignedPort
                + " (web source: " + webBundle.source() + ")");
        return assignedPort;
    }

    public int getPort() {
        return port;
    }

    /** 关闭监听 socket，取消在途代理请求，停掉线程池（不阻塞调用线程）。 */
    public synchronized void stop() {
        // 这两件事放在「服务器是否曾启动」的判断之前：都要幂等、都要无条件执行。
        // 退出应用就该停掉后台保活前台服务，否则用户「关掉应用」之后还剩一条常驻通知，
        // 进程也会被系统按前台服务优先级养着。RemoteKeepAliveService.stop 内部吞异常，
        // 服务没跑也不会打断后面的清理。
        keepAliveHandler.cancelAll();
        RemoteKeepAliveService.stop(appContext);
        if (!running.getAndSet(false)) {
            return;
        }
        Log.i(TAG, "stopping local server");
        ServerSocket socket = serverSocket;
        serverSocket = null;
        HttpUtil.closeQuietly(socket);
        proxyHandler.cancelAll();
        // 更新下载也属于在途请求，退出时一起取消
        updateHandler.cancelAll();
        // WebSocket 隧道是长连接：不主动拆，读线程会一直挂在 socket 上
        remoteWsHandler.cancelAll();
        // 授权容器可能还开着一个全屏 Dialog：退出时一起关掉（内部走主线程 + 幂等）
        remoteAuthHandler.cancelAll();
        workers.shutdownNow();
        port = -1;
    }

    private void acceptLoop(ServerSocket socket) {
        while (running.get() && !socket.isClosed()) {
            Socket client;
            try {
                client = socket.accept();
            } catch (IOException acceptFailed) {
                if (!running.get() || socket.isClosed()) {
                    break;
                }
                Log.w(TAG, "accept failed: " + acceptFailed);
                sleepQuietly(50L);
                continue;
            } catch (RuntimeException unexpected) {
                if (!running.get()) {
                    break;
                }
                Log.w(TAG, "accept crashed", unexpected);
                sleepQuietly(50L);
                continue;
            }
            try {
                workers.execute(() -> handleConnection(client));
            } catch (RejectedExecutionException shuttingDown) {
                HttpUtil.closeQuietly(client);
            }
        }
        Log.i(TAG, "accept loop finished");
    }

    private void handleConnection(Socket socket) {
        try {
            socket.setSoTimeout(IDLE_TIMEOUT_MS);
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 8 * 1024);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 16 * 1024);
            int served = 0;
            while (running.get() && served < MAX_REQUESTS_PER_CONNECTION) {
                String requestLine;
                try {
                    requestLine = HttpUtil.readLine(in);
                } catch (SocketTimeoutException idle) {
                    break;
                }
                if (requestLine == null) {
                    break;
                }
                if (requestLine.isEmpty()) {
                    // 空行也要占配额，否则客户端狂发 CRLF 能把这个循环饿死在这里
                    served++;
                    continue;
                }
                served++;

                String[] parts = requestLine.split(" ");
                if (parts.length < 2) {
                    HttpUtil.sendJson(out, 400, false,
                            "{\"ok\":false,\"error\":\"bad_request_line\"}");
                    break;
                }
                String method = parts[0].toUpperCase(Locale.US);
                String target = parts[1];
                String version = parts.length >= 3 ? parts[2] : "HTTP/1.1";

                HttpUtil.Headers headers;
                try {
                    headers = HttpUtil.readHeaders(in);
                } catch (SocketTimeoutException idle) {
                    break;
                }

                boolean keepAlive = isKeepAlive(headers)
                        && !"HTTP/1.0".equalsIgnoreCase(version)
                        && served < MAX_REQUESTS_PER_CONNECTION;
                boolean mustClose = dispatch(method, target, headers, in, out, keepAlive);
                out.flush();
                if (mustClose || !keepAlive) {
                    break;
                }
            }
        } catch (IOException ioError) {
            Log.d(TAG, "connection closed: " + ioError.getMessage());
        } catch (RuntimeException unexpected) {
            Log.w(TAG, "connection failed", unexpected);
        } finally {
            HttpUtil.closeQuietly(socket);
        }
    }

    /**
     * @return true 表示必须关闭连接
     */
    private boolean dispatch(String method, String target, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws IOException {
        String path = target == null ? "/" : target;
        // 少数客户端会发 absolute-form（http://host/path），先把 scheme+authority 剥掉
        int schemeIndex = path.indexOf("://");
        if (schemeIndex > 0) {
            int slash = path.indexOf('/', schemeIndex + 3);
            path = slash >= 0 ? path.substring(slash) : "/";
        }
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        int fragment = path.indexOf('#');
        if (fragment >= 0) {
            path = path.substring(0, fragment);
        }
        if (path.isEmpty()) {
            path = "/";
        }

        if (HEALTH_PATH.equals(path)) {
            boolean headOnly = "HEAD".equals(method);
            if (!headOnly && !"GET".equals(method)) {
                HttpUtil.sendJson(out, 405, keepAlive,
                        "{\"ok\":false,\"error\":\"method_not_allowed\"}");
                return !keepAlive;
            }
            String body = "{\"ok\":true,\"version\":\"" + BuildConfig.VERSION_NAME + "\"}";
            HttpUtil.sendJson(out, 200, keepAlive, body, headOnly);
            return !keepAlive;
        }

        if (PROXY_PATH.equals(path)) {
            if (!"POST".equals(method)) {
                HttpUtil.sendJson(out, 405, keepAlive,
                        "{\"ok\":false,\"error\":\"method_not_allowed\"}");
                return !keepAlive;
            }
            return proxyHandler.handle(headers, in, out, keepAlive);
        }

        // 会话存储接口（/__ds_db/*）同样必须排在静态资源判断之前，否则会被当成页面路径去 assets 里找。
        // 这里要把 in 一起传进去：POST /session、/import 的 JSON 与 POST /file 的二进制都在请求体里
        if (path.startsWith(DbHandler.PATH_PREFIX)) {
            return dbHandler.handle(method, target, path, headers, in, out, keepAlive);
        }

        // 远程 DSH 的 WebSocket 隧道桥（/__ds_remote/*）。同样必须排在静态资源判断之前：
        // 它既不是静态文件，而且 101 之后整条连接归 RemoteWsHandler 独占，不会再回到这个循环。
        // 契约要求的位置：紧跟 /__ds_db、在 /__ds_update 与静态资源之前（顺序错了会被
        // AssetHandler 当成页面路径去 assets 里找，见下面的静态资源分支）。
        if (path.startsWith(RemoteWsHandler.PATH_PREFIX)) {
            return remoteWsHandler.handle(method, path, headers, in, out, keepAlive);
        }

        // 应用内 OAuth 授权容器（/__ds_auth/*）：同样必须排在静态资源判断之前。
        // 它不碰 socket 的字节流（响应是普通 JSON），但要读 POST 的 JSON 请求体（startUrl），
        // 所以 in 要一起传进去；挂载顺序与上面两个一致：紧跟 /__ds_remote、在 /__ds_update 与
        // 静态资源之前，否则 /__ds_auth/state 会被 AssetHandler 当成页面路径去 assets 里找。
        if (path.startsWith(RemoteAuthHandler.PATH_PREFIX)) {
            return remoteAuthHandler.handle(method, path, headers, in, out, keepAlive);
        }

        // 后台保活 + 权限中心（/__ds_keepalive/*）：同样必须排在静态资源判断之前。
        // 注意 AssetHandler 的 SPA 回落：无扩展名的未知路径会回 index.html（200 HTML），
        // 所以旧 APK 上这些请求不是 404 —— 页面探测能力请用带扩展名的那些别名
        // （/__ds_keepalive/state.json、/__ds_keepalive/permissions.json）：
        // 带点的路径不会触发回落，旧 APK 上是真 404，见 KeepAliveHandler 类注释。
        if (path.startsWith(KeepAliveHandler.PATH_PREFIX)) {
            return keepAliveHandler.handle(method, path, headers, in, out, keepAlive);
        }

        // 更新接口必须排在静态资源判断之前，否则会被当成页面路径去 assets 里找。
        // 这里传的是原始 target（带查询串），apply-web / download-apk 要从 ?url= 取地址
        if (path.startsWith(UpdateHandler.PATH_PREFIX)) {
            return updateHandler.handle(method, target, path, headers, out, keepAlive);
        }

        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            HttpUtil.sendJson(out, 405, keepAlive,
                    "{\"ok\":false,\"error\":\"method_not_allowed\"}");
            return !keepAlive;
        }
        return assetHandler.handle(path, "HEAD".equals(method), out, keepAlive);
    }

    private static boolean isKeepAlive(HttpUtil.Headers headers) {
        String connection = headers.get("Connection");
        if (connection == null) {
            return true;
        }
        return !connection.toLowerCase(Locale.US).contains("close");
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
