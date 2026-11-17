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
 *   <li>端口由系统分配（new ServerSocket(0, ...)），拿到实际端口再交给 WebView</li>
 *   <li>静态资源走 {@link AssetHandler}，/__ds_proxy 走 {@link ProxyHandler}</li>
 *   <li>每个连接一个小循环支持 keep-alive，最多 256 个请求</li>
 *   <li>工作线程全部是 daemon，Activity 退出时不会把进程挂住</li>
 * </ul>
 */
public final class LocalServer {

    private static final String TAG = "DsLocalServer";
    private static final String HOST = "127.0.0.1";
    private static final int BACKLOG = 64;
    /** 空闲 keep-alive 连接的读超时；也是读请求行的超时。 */
    private static final int IDLE_TIMEOUT_MS = 15_000;
    private static final int MAX_REQUESTS_PER_CONNECTION = 256;
    private static final String HEALTH_PATH = "/__ds_health";
    private static final String PROXY_PATH = "/__ds_proxy";

    private final AssetHandler assetHandler;
    private final ProxyHandler proxyHandler;
    private final ExecutorService workers;
    private final AtomicInteger threadCounter = new AtomicInteger();
    private final AtomicBoolean running = new AtomicBoolean(false);

    private volatile ServerSocket serverSocket;
    private volatile int port = -1;
    private Thread acceptThread;

    public LocalServer(Context context, OkHttpClient httpClient) {
        Context appContext = context.getApplicationContext();
        this.assetHandler = new AssetHandler(appContext != null ? appContext : context);
        this.proxyHandler = new ProxyHandler(httpClient);
        this.workers = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "ds-http-" + threadCounter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * 绑定回环地址并开始 accept。
     *
     * @return 系统实际分配到的端口
     */
    public synchronized int start() throws IOException {
        if (running.get() && serverSocket != null) {
            return port;
        }
        // 端口 0 = 交给系统挑一个空闲端口；第三个参数保证只监听回环
        ServerSocket socket = new ServerSocket(0, BACKLOG, InetAddress.getByName(HOST));
        serverSocket = socket;
        port = socket.getLocalPort();
        running.set(true);
        int assignedPort = port;
        acceptThread = new Thread(() -> acceptLoop(socket), "ds-http-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        Log.i(TAG, "listening on " + HOST + ":" + assignedPort);
        return assignedPort;
    }

    public int getPort() {
        return port;
    }

    /** 关闭监听 socket，取消在途代理请求，停掉线程池（不阻塞调用线程）。 */
    public synchronized void stop() {
        if (!running.getAndSet(false)) {
            return;
        }
        Log.i(TAG, "stopping local server");
        ServerSocket socket = serverSocket;
        serverSocket = null;
        HttpUtil.closeQuietly(socket);
        proxyHandler.cancelAll();
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
