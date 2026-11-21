package ai.deepseek.tablet;

import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * /__ds_remote/* 的实现：给页面一条「原生 WebSocket 隧道桥」。
 *
 * <p>为什么要有它（四道锁，见 work/2026-11-21-chatpad接入DSH远程/result-方案-ChatPad接入DSH远程.md §4.2）：
 * 页面 origin 是 {@code http://127.0.0.1:18888}，而远端网关把 Origin 硬绑在服务端域名上，
 * 且浏览器的 WebSocket API 根本不允许带 Authorization 头。原生侧可以任意设头，所以把
 * 「握手 + 头部注入 + 字节透传」放在这边，业务（Noise / RPC / 帧语义）全留在 JS。
 *
 * <p>页面侧的用法（S2 消费，契约 §2）：
 * <pre>
 * const ws = new WebSocket('ws://127.0.0.1:18888/__ds_remote/ws')
 * ws.binaryType = 'arraybuffer'
 * ws.onopen = () =&gt; ws.send(JSON.stringify({
 *   type: 'connect',
 *   url: 'wss://dsh.r2049.cn/api/v1/control',
 *   headers: { Authorization: 'Bearer …', Origin: 'https://dsh.r2049.cn' },
 * }))
 * // 之后：收到 {"type":"open"} 表示上游已连通；
 * //      收到 {"type":"error",code,message} 表示失败并会被关掉；
 * //      二进制帧 = 上游二进制原样（Noise 密文），文本帧 = 上游文本原样；
 * //      收到 {"type":"close",code,reason} 表示上游已关闭。
 * </pre>
 *
 * <p>实现要点：
 * <ul>
 *   <li>手写 RFC 6455：101 握手、Accept 计算、帧编解码（客户端帧必须带掩码，服务端帧不加掩码）</li>
 *   <li>支持 text / binary / continuation / ping / pong / close；单帧与重组后单条消息上限 1 MiB，
 *       超限回 close(1009) 并断开（与协议 MAX_RELAY_FRAME_BYTES 对齐）</li>
 *   <li>上游用**独立**的 OkHttpClient（<b>不能</b>复用 MainActivity.ensureHttpClient() 那个带
 *       HTTPS_ONLY_INTERCEPTOR 的实例，也绝不装任何拦截器）</li>
 *   <li>线程模型：页面→上游的读循环跑在 LocalServer 的工作线程；上游→页面跑在 OkHttp 的回调线程。
 *       两边对同一个 socket 的写全部走 {@link Tunnel#writeFrame} 里的锁，不会交错</li>
 *   <li>所有异常都在本类内收敛成 JSON 500 / close 帧，绝不让异常冒到 LocalServer 把连接线程打死</li>
 * </ul>
 */
final class RemoteWsHandler {

    private static final String TAG = "DsRemoteWs";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_remote/";

    /** 页面真正连的那条路径 */
    private static final String WS_PATH = "/__ds_remote/ws";

    /**
     * 能力探测：GET /__ds_remote/health。
     *
     * <p>网页包与 APK 是两条独立的版本线，页面必须能判断「这个壳有没有远程桥」，否则新网页 +
     * 旧 APK 会去连一条不存在的路径（照 transport.ts 的 detectShell 写法）。契约 §2 没要求，
     * 属于纯增量的探测口子，不影响 /ws 的行为。
     */
    private static final String HEALTH_PATH = "/__ds_remote/health";

    // ---------------------------------------------------------------- 协议常量

    /** RFC 6455 §1.3 的固定 GUID，Accept = base64(sha1(key + 它)) */
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    /** 只支持 RFC 6455 的版本 13（浏览器只会发 13） */
    private static final String WS_VERSION = "13";

    /** 单帧上限；与协议 MAX_RELAY_FRAME_BYTES（1 MiB）一致 */
    private static final int MAX_FRAME_BYTES = 1024 * 1024;
    /** 分片重组后单条消息的上限，同样 1 MiB */
    private static final int MAX_MESSAGE_BYTES = 1024 * 1024;
    /** 控制帧（close/ping/pong）payload 硬上限，RFC 6455 §5.5 */
    private static final int MAX_CONTROL_PAYLOAD = 125;

    /** 等页面第一条 connect 控制帧的超时 */
    private static final long CONNECT_TIMEOUT_MS = 20_000L;
    /** 等上游 wss 握手完成的超时 */
    private static final long UPSTREAM_OPEN_TIMEOUT_MS = 20_000L;

    /**
     * 调试开关：只有它为 true，才允许 connect 帧用 {@code ws://} 明文上游（且必须带
     * {@code allowInsecure:true}）。正式包必须保持 false —— 明文上游等于把 Token 摊在网上。
     */
    private static final boolean DEBUG = false;

    /** 文本帧里可能夹着页面的控制帧，只有这么短的才尝试当 JSON 解析 */
    private static final int MAX_CONTROL_FRAME_PARSE_BYTES = 4 * 1024;

    // ---------------------------------------------------------------- 帧操作码

    private static final int OP_CONTINUATION = 0x0;
    private static final int OP_TEXT = 0x1;
    private static final int OP_BINARY = 0x2;
    private static final int OP_CLOSE = 0x8;
    private static final int OP_PING = 0x9;
    private static final int OP_PONG = 0xA;

    // ---------------------------------------------------------------- close 码表（RFC 6455 §7.4.1）

    /** 正常关闭 */
    private static final int CLOSE_NORMAL = 1000;
    /** 端点离开（服务端停止时用） */
    private static final int CLOSE_GOING_AWAY = 1001;
    /** 协议错误：帧格式/掩码/分片不合法 */
    private static final int CLOSE_PROTOCOL_ERROR = 1002;
    /** 连接被异常断开（**不能**发给对端，只能写进 {"type":"close","code"} 里） */
    private static final int CLOSE_ABNORMAL = 1006;
    /** payload 不是合法数据（比如 JSON 坏了） */
    private static final int CLOSE_INVALID_PAYLOAD = 1007;
    /** 违反策略（比如 URL 不是 wss:// 或首帧不是 connect） */
    private static final int CLOSE_POLICY_VIOLATION = 1008;
    /** 消息太大 */
    private static final int CLOSE_MESSAGE_TOO_BIG = 1009;
    /** 原生侧内部错误 */
    private static final int CLOSE_INTERNAL_ERROR = 1011;

    /**
     * 不允许出现在上游请求里的头：握手由 OkHttp 自己算，其余是逐跳头。
     * 页面传什么都不该覆盖它们。
     */
    private static final Set<String> BLOCKED_UPSTREAM_HEADERS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "host", "connection", "upgrade", "keep-alive", "proxy-connection",
                    "sec-websocket-key", "sec-websocket-version", "sec-websocket-accept",
                    "sec-websocket-extensions", "sec-websocket-protocol",
                    "content-length", "transfer-encoding", "te", "trailer", "expect")));

    private final OkHttpClient client;
    private final Set<Tunnel> active =
            Collections.newSetFromMap(new ConcurrentHashMap<Tunnel, Boolean>());

    RemoteWsHandler() {
        // 必须独立：MainActivity 的共享实例挂着 HTTPS_ONLY_INTERCEPTOR，而且它的超时策略
        // 是为 SSE 调的；这里要一个干净的长连接客户端。不装任何拦截器。
        this.client = new OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                // 0 = 不超时：WebSocket 是长连接，空闲是常态（心跳由协议层负责）
                .readTimeout(0, TimeUnit.SECONDS)
                .writeTimeout(0, TimeUnit.SECONDS)
                .callTimeout(0, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    /** 服务停止时调用：拆掉所有在途隧道（上游连接一起取消）。 */
    void cancelAll() {
        for (Tunnel tunnel : active) {
            try {
                tunnel.abort();
            } catch (RuntimeException ignored) {
                // 已经断掉的隧道拆失败没关系
            }
        }
        active.clear();
        Log.i(TAG, "all remote ws tunnels closed");
    }

    /**
     * @return true 表示这条连接必须关闭。WebSocket 隧道跑完（或握手失败）后一律返回 true：
     *         Upgrade 之后这条 socket 上不可能再承载普通 HTTP 请求。
     */
    boolean handle(String method, String path, HttpUtil.Headers headers, InputStream in, OutputStream out,
            boolean keepAlive) throws IOException {
        // 带 Upgrade 的请求不能复用连接，任何非 101 响应都直接关闭，免得残留字节被当成下一个请求
        boolean reuse = keepAlive && !requestsUpgrade(headers);

        if (HEALTH_PATH.equals(path)) {
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                HttpUtil.sendJson(out, 405, reuse, httpErrorJson("method_not_allowed"));
                return !reuse;
            }
            HttpUtil.sendJson(out, 200, reuse, healthJson(), "HEAD".equals(method));
            return !reuse;
        }

        if (!WS_PATH.equals(path)) {
            HttpUtil.sendJson(out, 404, reuse, httpErrorJson("not_found"));
            return !reuse;
        }

        String acceptKey;
        try {
            acceptKey = validateUpgrade(method, headers);
        } catch (HttpError refused) {
            // 握手失败的响应一律 Connection: close（见本方法开头）
            if (refused.status == 426) {
                sendVersionRejected(out);
            } else {
                Log.w(TAG, "handshake rejected: " + refused.status + " " + refused.getMessage());
                HttpUtil.sendJson(out, refused.status, false, httpErrorJson(refused.getMessage()));
            }
            return true;
        }

        Map<String, String> responseHeaders = new LinkedHashMap<>();
        responseHeaders.put("Upgrade", "websocket");
        responseHeaders.put("Connection", "Upgrade");
        responseHeaders.put("Sec-WebSocket-Accept", acceptKey);
        // 注意：101 不能带 Content-Length，也不协商 permessage-deflate（页面那边没请求压缩）
        HttpUtil.writeHead(out, 101, "Switching Protocols", responseHeaders);

        Tunnel tunnel = new Tunnel(in, out);
        active.add(tunnel);
        try {
            runTunnel(tunnel);
        } catch (RuntimeException unexpected) {
            // 兜底：任何漏出来的运行时异常都收敛成 close 帧，绝不冒到 LocalServer 的连接线程
            Log.w(TAG, "tunnel crashed", unexpected);
            tunnel.writeFrame(OP_CLOSE, true, closePayload(CLOSE_INTERNAL_ERROR, "internal_error"));
        } finally {
            active.remove(tunnel);
            tunnel.shutdown();
        }
        return true;
    }

    // ---------------------------------------------------------------- 握手

    private static boolean requestsUpgrade(HttpUtil.Headers headers) {
        String upgrade = headers.get("Upgrade");
        return upgrade != null && !upgrade.trim().isEmpty();
    }

    /**
     * 校验 RFC 6455 §4.2.1 的握手必需项。
     *
     * @return Sec-WebSocket-Accept 的值
     */
    private static String validateUpgrade(String method, HttpUtil.Headers headers) {
        if (!"GET".equals(method)) {
            throw new HttpError(405, "method_not_allowed");
        }
        String connection = headers.get("Connection");
        String upgrade = headers.get("Upgrade");
        if (connection == null || !connection.toLowerCase(Locale.US).contains("upgrade")
                || upgrade == null || !upgrade.trim().toLowerCase(Locale.US).contains("websocket")) {
            throw new HttpError(400, "upgrade_required");
        }
        String version = headers.get("Sec-WebSocket-Version");
        if (version == null || !WS_VERSION.equals(version.trim())) {
            throw new HttpError(426, "unsupported_ws_version");
        }
        String key = headers.get("Sec-WebSocket-Key");
        if (key == null || key.trim().isEmpty()) {
            throw new HttpError(400, "missing_sec_websocket_key");
        }
        String accept = computeAccept(key.trim());
        if (accept == null) {
            throw new HttpError(500, "sha1_unavailable");
        }
        return accept;
    }

    /** Accept = base64(sha1(key + GUID))；key 是浏览器给的 base64（纯 ASCII）。 */
    private static String computeAccept(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + WS_GUID).getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(digest, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException missingSha1) {
            return null;
        }
    }

    /** 426 必须带上自己支持的版本号，客户端才知道该重试什么。 */
    private static void sendVersionRejected(OutputStream out) throws IOException {
        byte[] body = httpErrorJson("unsupported_ws_version").getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Content-Length", String.valueOf(body.length));
        headers.put("Sec-WebSocket-Version", WS_VERSION);
        headers.put("Cache-Control", "no-store");
        headers.put("Connection", "close");
        HttpUtil.writeHead(out, 426, "Upgrade Required", headers);
        out.write(body);
        out.flush();
    }

    private static String healthJson() {
        return "{\"ok\":true,\"bridge\":\"remote-ws.v1\",\"path\":" + JSONObject.quote(WS_PATH)
                + ",\"maxFrameBytes\":" + MAX_FRAME_BYTES
                + ",\"insecureWs\":" + DEBUG + "}";
    }

    // ---------------------------------------------------------------- 隧道主体

    /**
     * 整条隧道的生命周期：connect 控制帧 → 建上游 → 回 open → 双向透传。
     *
     * <p>本方法不声明 checked 异常：所有 IO/协议错误都在内部转成 close 帧或日志。
     */
    private void runTunnel(Tunnel tunnel) {
        WebSocket upstream = null;
        try {
            upstream = establishUpstream(tunnel);
            if (upstream == null) {
                // establishUpstream 已经给页面写过 error + close
                return;
            }
            if (!tunnel.writeText("{\"type\":\"open\"}")) {
                return;
            }
            pumpPageToUpstream(tunnel);
        } catch (WsProtocolException protocol) {
            Log.d(TAG, "protocol error: " + protocol.getMessage());
            if (protocol.code == CLOSE_MESSAGE_TOO_BIG) {
                // 契约 §2：超限要「关连接报 FRAME_TOO_LARGE」——先给页面一条可读的错误再关
                tunnel.writeText("{\"type\":\"error\",\"code\":\"FRAME_TOO_LARGE\",\"message\":"
                        + JSONObject.quote("单帧/单条消息超过 1 MiB（" + protocol.getMessage() + "）") + "}");
            }
            tunnel.writeFrame(OP_CLOSE, true, closePayload(protocol.code, protocol.getMessage()));
        } catch (IOException closed) {
            // 页面断开（EOF）或隧道被 stop() 拆掉，都是正常收尾
            Log.d(TAG, "tunnel closed: " + describe(closed));
        } catch (RuntimeException unexpected) {
            Log.w(TAG, "tunnel failed", unexpected);
            tunnel.writeFrame(OP_CLOSE, true, closePayload(CLOSE_INTERNAL_ERROR, "internal_error"));
        } finally {
            closeUpstream(upstream);
        }
    }

    /**
     * 读第一帧（必须是 connect）+ 连接上游。
     *
     * @return 已连通的上游；失败时返回 null（错误已经写给页面）
     */
    private WebSocket establishUpstream(Tunnel tunnel) throws IOException {
        Frame first;
        try {
            first = readFrame(tunnel, System.currentTimeMillis() + CONNECT_TIMEOUT_MS);
        } catch (TunnelTimeoutException timeout) {
            writeErrorAndClose(tunnel, "CONNECT_TIMEOUT", "等待 connect 控制帧超时", CLOSE_POLICY_VIOLATION);
            return null;
        }
        if (first.opcode != OP_TEXT || !first.fin) {
            writeErrorAndClose(tunnel, "BAD_CONTROL_FRAME", "第一帧必须是完整的文本控制帧", CLOSE_PROTOCOL_ERROR);
            return null;
        }

        JSONObject control;
        try {
            control = new JSONObject(new String(first.payload, StandardCharsets.UTF_8));
        } catch (JSONException broken) {
            writeErrorAndClose(tunnel, "BAD_CONTROL_FRAME", "第一帧不是合法 JSON", CLOSE_INVALID_PAYLOAD);
            return null;
        }

        if (!"connect".equals(control.optString("type", ""))) {
            writeErrorAndClose(tunnel, "CONNECT_REQUIRED", "第一帧必须是 {\"type\":\"connect\",...}",
                    CLOSE_POLICY_VIOLATION);
            return null;
        }

        String url = control.optString("url", "").trim();
        boolean allowInsecure = control.optBoolean("allowInsecure", false);
        if (url.isEmpty()) {
            writeErrorAndClose(tunnel, "URL_REQUIRED", "connect 帧缺少 url", CLOSE_POLICY_VIOLATION);
            return null;
        }
        String lower = url.toLowerCase(Locale.US);
        boolean secure = lower.startsWith("wss://");
        boolean insecure = lower.startsWith("ws://");
        if (!secure && !(insecure && DEBUG && allowInsecure)) {
            // 明文上游会把 Bearer Token 摊在网络上，正式包直接拒绝
            String code = insecure ? "INSECURE_WS_REJECTED" : "WSS_REQUIRED";
            String message = insecure
                    ? "正式包不接受 ws:// 上游（只有 DEBUG 构建 + allowInsecure:true 才放行）"
                    : "上游 url 必须是 wss://";
            writeErrorAndClose(tunnel, code, message, CLOSE_POLICY_VIOLATION);
            return null;
        }

        Map<String, String> upstreamHeaders = sanitizeUpstreamHeaders(control.optJSONObject("headers"));
        Request request;
        try {
            Request.Builder builder = new Request.Builder().url(url);
            for (Map.Entry<String, String> entry : upstreamHeaders.entrySet()) {
                builder.header(entry.getKey(), entry.getValue());
            }
            if (!hasHeaderIgnoreCase(upstreamHeaders, "Origin")) {
                // 服务端把 Origin 硬绑在公开域名上（gateway.ts:151），页面忘了带就替它补一个，
                // 否则握手必然被拒。Token 只在 Authorization 里，绝不进 URL。
                String origin = defaultOrigin(url);
                if (origin != null) {
                    builder.header("Origin", origin);
                }
            }
            request = builder.build();
        } catch (IllegalArgumentException | IllegalStateException badRequest) {
            writeErrorAndClose(tunnel, "BAD_URL", describe(badRequest), CLOSE_POLICY_VIOLATION);
            return null;
        }

        Log.i(TAG, "tunnel connect -> " + safeUrlForLog(url));

        UpstreamListener listener = new UpstreamListener(tunnel);
        WebSocket socket;
        try {
            socket = client.newWebSocket(request, listener);
        } catch (RuntimeException refused) {
            writeErrorAndClose(tunnel, "UPSTREAM_FAILED", describe(refused), CLOSE_GOING_AWAY);
            return null;
        }
        tunnel.upstream = socket;

        if (!listener.awaitOpen(UPSTREAM_OPEN_TIMEOUT_MS)) {
            String code = listener.failureCode == null ? "UPSTREAM_TIMEOUT" : listener.failureCode;
            String message = listener.failureMessage == null
                    ? "上游 wss 握手超时" : listener.failureMessage;
            cancelQuietly(socket);
            tunnel.upstream = null;
            writeErrorAndClose(tunnel, code, message, CLOSE_GOING_AWAY);
            return null;
        }
        return socket;
    }

    /**
     * 页面 → 上游：读一帧转一帧，直到页面关闭 / 隧道被拆。
     *
     * <p>上游 → 页面的方向由 {@link UpstreamListener} 在 OkHttp 线程写，两个方向都走
     * {@link Tunnel#writeFrame} 的锁，所以同一时刻只有一个线程写这个 socket。
     */
    private void pumpPageToUpstream(Tunnel tunnel) throws IOException {
        ByteArrayOutputStream fragments = null;
        int fragmentOpcode = 0;
        while (!tunnel.terminated) {
            Frame frame = readFrame(tunnel, 0L);

            if (frame.opcode == OP_CLOSE) {
                // 页面主动关闭：把同样的码转给上游，回一个 close 帧就可以走
                int code = parseCloseCode(frame.payload);
                String reason = parseCloseReason(frame.payload);
                int sendable = isSendableCloseCode(code) ? code : CLOSE_NORMAL;
                WebSocket upstream = tunnel.upstream;
                if (upstream != null) {
                    try {
                        upstream.close(sendable, reason);
                    } catch (RuntimeException ignored) {
                        // 上游已经没了，无所谓
                    }
                }
                tunnel.writeFrame(OP_CLOSE, true, closePayload(sendable, ""));
                return;
            }

            if (frame.opcode == OP_PING) {
                // 浏览器 JS 发不出 ping，但别把这条路堵死
                tunnel.writeFrame(OP_PONG, true, frame.payload);
                continue;
            }
            if (frame.opcode == OP_PONG) {
                continue;
            }

            if (frame.opcode == OP_TEXT && frame.fin && isLocalCloseFrame(frame.payload)) {
                // 契约 §2：页面 → 原生的 {"type":"close"} 是「主动断开」的控制帧，不往上游发
                WebSocket upstream = tunnel.upstream;
                if (upstream != null) {
                    try {
                        upstream.close(CLOSE_NORMAL, "bye");
                    } catch (RuntimeException ignored) {
                        // 上游已经没了
                    }
                }
                tunnel.writeFrame(OP_CLOSE, true, closePayload(CLOSE_NORMAL, "bye"));
                return;
            }

            if (frame.opcode == OP_TEXT || frame.opcode == OP_BINARY) {
                if (fragments != null) {
                    throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "overlapping_fragments");
                }
                if (frame.fin) {
                    deliverToUpstream(tunnel, frame.opcode, frame.payload);
                } else {
                    // 分片：OkHttp 的 send 只吃整条消息，必须先重组
                    fragments = new ByteArrayOutputStream(Math.max(frame.payload.length, 256));
                    fragmentOpcode = frame.opcode;
                    fragments.write(frame.payload, 0, frame.payload.length);
                }
                continue;
            }

            if (frame.opcode == OP_CONTINUATION) {
                if (fragments == null) {
                    throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "unexpected_continuation");
                }
                if (fragments.size() + frame.payload.length > MAX_MESSAGE_BYTES) {
                    throw new WsProtocolException(CLOSE_MESSAGE_TOO_BIG, "message_too_large");
                }
                fragments.write(frame.payload, 0, frame.payload.length);
                if (frame.fin) {
                    byte[] whole = fragments.toByteArray();
                    int opcode = fragmentOpcode;
                    fragments = null;
                    deliverToUpstream(tunnel, opcode, whole);
                }
                continue;
            }

            throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "unknown_opcode");
        }
    }

    /** 把一条完整消息发给上游。上游队列满（send 返回 false）按内部错误关掉。 */
    private static void deliverToUpstream(Tunnel tunnel, int opcode, byte[] payload) throws IOException {
        WebSocket upstream = tunnel.upstream;
        if (upstream == null) {
            throw new WsProtocolException(CLOSE_GOING_AWAY, "upstream_gone");
        }
        boolean sent;
        if (opcode == OP_TEXT) {
            // 文本帧原样透传；非法 UTF-8 会被替换成 U+FFFD（与浏览器行为一致，不额外判 1007）
            sent = upstream.send(new String(payload, StandardCharsets.UTF_8));
        } else {
            sent = upstream.send(ByteString.of(payload, 0, payload.length));
        }
        if (!sent) {
            throw new WsProtocolException(CLOSE_INTERNAL_ERROR, "upstream_send_failed");
        }
    }

    // ---------------------------------------------------------------- 帧编解码

    /**
     * 读一个完整的帧（含分片帧），脱掉客户端掩码。
     *
     * @param deadline {@code <= 0} 表示没有截止时间（连上之后的常态）；否则超过就抛
     *                 {@link TunnelTimeoutException}
     */
    private static Frame readFrame(Tunnel tunnel, long deadline) throws IOException {
        int first = readByte(tunnel, deadline);
        boolean fin = (first & 0x80) != 0;
        int opcode = first & 0x0F;
        // RSV1..3：没协商任何扩展，必须全 0
        if ((first & 0x70) != 0) {
            throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "rsv_not_supported");
        }

        int second = readByte(tunnel, deadline);
        boolean masked = (second & 0x80) != 0;
        // RFC 6455 §5.1：客户端发来的帧必须带掩码，否则立即断开
        if (!masked) {
            throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "unmasked_client_frame");
        }
        long length = second & 0x7F;
        if (length == 126L) {
            length = ((long) (readByte(tunnel, deadline) & 0xFF) << 8) | (readByte(tunnel, deadline) & 0xFF);
        } else if (length == 127L) {
            length = 0L;
            for (int index = 0; index < 8; index++) {
                length = (length << 8) | (readByte(tunnel, deadline) & 0xFF);
            }
        }
        // 最高位被当成有符号数时 length 会变负，顺带挡住
        if (length < 0L || length > MAX_FRAME_BYTES) {
            throw new WsProtocolException(CLOSE_MESSAGE_TOO_BIG, "frame_too_large");
        }
        if (opcode >= 0x8) {
            // 控制帧不能分片、payload 不能超过 125
            if (!fin) {
                throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "fragmented_control_frame");
            }
            if (length > MAX_CONTROL_PAYLOAD) {
                throw new WsProtocolException(CLOSE_PROTOCOL_ERROR, "control_frame_too_large");
            }
        }

        byte[] mask = new byte[4];
        readFully(tunnel, mask, 0, mask.length, deadline);
        byte[] payload = new byte[(int) length];
        readFully(tunnel, payload, 0, payload.length, deadline);
        for (int index = 0; index < payload.length; index++) {
            payload[index] ^= mask[index & 3];
        }
        return new Frame(fin, opcode, payload);
    }

    /** 服务端帧一律不加掩码（RFC 6455 §5.1）。 */
    private static byte[] encodeServerFrame(int opcode, boolean fin, byte[] payload) {
        int length = payload.length;
        int headerLength;
        if (length <= MAX_CONTROL_PAYLOAD) {
            headerLength = 2;
        } else if (length <= 0xFFFF) {
            headerLength = 4;
        } else {
            headerLength = 10;
        }
        byte[] frame = new byte[headerLength + length];
        frame[0] = (byte) ((fin ? 0x80 : 0x00) | (opcode & 0x0F));
        if (headerLength == 2) {
            frame[1] = (byte) length;
        } else if (headerLength == 4) {
            frame[1] = 126;
            frame[2] = (byte) ((length >>> 8) & 0xFF);
            frame[3] = (byte) (length & 0xFF);
        } else {
            frame[1] = 127;
            long wide = length;
            for (int index = 0; index < 8; index++) {
                frame[2 + index] = (byte) ((wide >>> (8 * (7 - index))) & 0xFF);
            }
        }
        System.arraycopy(payload, 0, frame, headerLength, length);
        return frame;
    }

    private static int readByte(Tunnel tunnel, long deadline) throws IOException {
        while (true) {
            if (tunnel.terminated) {
                throw new EOFException("tunnel terminated");
            }
            if (deadline > 0L && System.currentTimeMillis() > deadline) {
                throw new TunnelTimeoutException("deadline exceeded");
            }
            try {
                int value = tunnel.in.read();
                if (value == -1) {
                    throw new EOFException("peer closed");
                }
                return value;
            } catch (SocketTimeoutException idle) {
                // LocalServer.handleConnection 给回环 socket 设了 15s 的 SO_TIMEOUT
                // （IDLE_TIMEOUT_MS，那是给 keep-alive 空闲连接用的）。
                // 长连接隧道里这只是一次「没有新帧」的空转，不是错误：继续等就行。
                // 重新判断 terminated / deadline 就在下一轮循环开头。
                continue;
            }
        }
    }

    private static void readFully(Tunnel tunnel, byte[] buffer, int offset, int length, long deadline)
            throws IOException {
        int done = 0;
        while (done < length) {
            if (tunnel.terminated) {
                throw new EOFException("tunnel terminated");
            }
            if (deadline > 0L && System.currentTimeMillis() > deadline) {
                throw new TunnelTimeoutException("deadline exceeded");
            }
            try {
                int read = tunnel.in.read(buffer, offset + done, length - done);
                if (read == -1) {
                    throw new EOFException("peer closed");
                }
                done += read;
            } catch (SocketTimeoutException idle) {
                // 同上：已读到的 done 字节还在 buffer 里，继续读剩下的即可，不会丢数据
                continue;
            }
        }
    }

    // ---------------------------------------------------------------- close 帧与 JSON 控制帧

    /** close 帧 payload = 2 字节大端码 + UTF-8 原因（原因必须短，控制帧总长 ≤ 125）。 */
    private static byte[] closePayload(int code, String reason) {
        byte[] reasonBytes = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
        int maxReason = MAX_CONTROL_PAYLOAD - 2;
        if (reasonBytes.length > maxReason) {
            // 只在 ASCII 边界上截断：多字节字符被切一半会变成非法 UTF-8，对端会判 1007
            int cut = maxReason;
            while (cut > 0 && (reasonBytes[cut] & 0xC0) == 0x80) {
                cut--;
            }
            byte[] trimmed = new byte[cut];
            System.arraycopy(reasonBytes, 0, trimmed, 0, cut);
            reasonBytes = trimmed;
        }
        byte[] payload = new byte[2 + reasonBytes.length];
        payload[0] = (byte) ((code >>> 8) & 0xFF);
        payload[1] = (byte) (code & 0xFF);
        System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
        return payload;
    }

    private static int parseCloseCode(byte[] payload) {
        if (payload == null || payload.length < 2) {
            // 没带码：按 RFC 当 1005（no status received），这里用 0 表示「未提供」
            return 0;
        }
        return ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
    }

    private static String parseCloseReason(byte[] payload) {
        if (payload == null || payload.length <= 2) {
            return "";
        }
        return new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8);
    }

    /**
     * 能不能把某个码写进 close 帧。
     *
     * <p>1004/1005/1006/1015 与 1012-1014 之外的非注册码都不合法；OkHttp 自己也会校验，
     * 不合法时它直接抛 IllegalArgumentException，所以这里先挡住。
     */
    private static boolean isSendableCloseCode(int code) {
        if (code >= 1000 && code <= 1003) {
            return true;
        }
        if (code >= 1007 && code <= 1011) {
            return true;
        }
        return code >= 3000 && code <= 4999;
    }

    /** 页面的 {"type":"close"} 控制帧（只认短文本里的 JSON 对象，不做全量解析开销）。 */
    private static boolean isLocalCloseFrame(byte[] payload) {
        if (payload.length == 0 || payload.length > MAX_CONTROL_FRAME_PARSE_BYTES) {
            return false;
        }
        int start = 0;
        while (start < payload.length && isJsonSpace(payload[start])) {
            start++;
        }
        if (start >= payload.length || payload[start] != '{') {
            return false;
        }
        try {
            JSONObject json = new JSONObject(new String(payload, start, payload.length - start,
                    StandardCharsets.UTF_8));
            return "close".equals(json.optString("type", ""));
        } catch (JSONException notJson) {
            return false;
        }
    }

    private static boolean isJsonSpace(byte value) {
        return value == ' ' || value == '\t' || value == '\r' || value == '\n';
    }

    private void writeErrorAndClose(Tunnel tunnel, String code, String message, int closeCode) {
        tunnel.writeText("{\"type\":\"error\",\"code\":" + JSONObject.quote(code)
                + ",\"message\":" + JSONObject.quote(message) + "}");
        tunnel.writeFrame(OP_CLOSE, true, closePayload(closeCode, "error"));
    }

    // ---------------------------------------------------------------- 上游头部 / URL

    /**
     * 过滤页面传来的上游请求头：逐跳头与握手头一律不许覆盖，含换行的值直接丢掉（头注入）。
     */
    private static Map<String, String> sanitizeUpstreamHeaders(JSONObject raw) {
        Map<String, String> result = new LinkedHashMap<>();
        if (raw == null) {
            return result;
        }
        Iterator<String> keys = raw.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            if (name == null) {
                continue;
            }
            String trimmed = name.trim();
            if (trimmed.isEmpty() || BLOCKED_UPSTREAM_HEADERS.contains(trimmed.toLowerCase(Locale.US))) {
                continue;
            }
            String value = raw.optString(name, "");
            if (value.isEmpty() || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
                continue;
            }
            result.put(trimmed, value);
        }
        return result;
    }

    /** 上游头容器是大小写敏感的 Map，但 HTTP 语义不是：查 Origin 必须忽略大小写。 */
    private static boolean hasHeaderIgnoreCase(Map<String, String> headers, String name) {
        for (String key : headers.keySet()) {
            if (name.equalsIgnoreCase(key)) {
                return true;
            }
        }
        return false;
    }

    /**
     * {@code wss://host:port/path} → {@code https://host:port}；页面没带 Origin 时用它兜底。
     *
     * <p>纯字符串处理，不走 HttpUrl：这样行为可逐行验证，也不会被 URL 规范化的边界坑到。
     */
    private static String defaultOrigin(String url) {
        int schemeEnd = url.indexOf("://");
        if (schemeEnd <= 0) {
            return null;
        }
        int hostStart = schemeEnd + 3;
        int authorityEnd = url.length();
        for (int index = hostStart; index < url.length(); index++) {
            char ch = url.charAt(index);
            if (ch == '/' || ch == '?' || ch == '#') {
                authorityEnd = index;
                break;
            }
        }
        String authority = url.substring(hostStart, authorityEnd);
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            // 去掉 userinfo：Origin 里不该有凭证
            authority = authority.substring(at + 1);
        }
        if (authority.isEmpty()) {
            return null;
        }
        String scheme = url.substring(0, schemeEnd).toLowerCase(Locale.US);
        String originScheme = "wss".equals(scheme) ? "https" : "http";
        return originScheme + "://" + authority;
    }

    /** 日志里只留 scheme+host+path：query 里可能带一次性参数，不能进日志。 */
    private static String safeUrlForLog(String url) {
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

    // ---------------------------------------------------------------- 小工具

    private static String httpErrorJson(String error) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(error) + "}";
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

    private static void cancelQuietly(WebSocket socket) {
        if (socket == null) {
            return;
        }
        try {
            socket.cancel();
        } catch (RuntimeException ignored) {
            // 已经断开的连接取消失败没关系
        }
    }

    private static void closeUpstream(WebSocket upstream) {
        if (upstream == null) {
            return;
        }
        try {
            upstream.close(CLOSE_NORMAL, "bye");
        } catch (RuntimeException ignored) {
            // 已经关掉的连接再关一次会抛，忽略
        }
    }

    // ---------------------------------------------------------------- 内部类型

    /** 一个已升级成 WebSocket 的回环连接：读流、写流、上游句柄、写锁。 */
    private static final class Tunnel {

        private final InputStream in;
        private final OutputStream out;
        /** 页面→上游 与 上游→页面 两个方向都要写这个 socket，必须串行化 */
        private final Object writeLock = new Object();

        private volatile WebSocket upstream;
        private volatile boolean terminated;

        Tunnel(InputStream in, OutputStream out) {
            this.in = in;
            this.out = out;
        }

        /**
         * 写一帧（服务端帧不加掩码）并立刻 flush。
         *
         * @return false 表示页面那一端已经断了，调用方应尽快收尾
         */
        boolean writeFrame(int opcode, boolean fin, byte[] payload) {
            byte[] frame = encodeServerFrame(opcode, fin, payload);
            synchronized (writeLock) {
                try {
                    out.write(frame);
                    // 必须立刻 flush：BufferedOutputStream 攒着的话页面会「什么都没收到」
                    out.flush();
                    return true;
                } catch (IOException closed) {
                    terminated = true;
                    return false;
                } catch (RuntimeException broken) {
                    terminated = true;
                    Log.w(TAG, "write frame failed", broken);
                    return false;
                }
            }
        }

        boolean writeText(String text) {
            return writeFrame(OP_TEXT, true, text.getBytes(StandardCharsets.UTF_8));
        }

        boolean writeBinary(byte[] payload) {
            return writeFrame(OP_BINARY, true, payload);
        }

        /**
         * 上游关闭（正常关、对端关闭、连接失败）时调用。
         *
         * <p>先给页面发 {"type":"close",code,reason}，再发 close 帧，然后主动把读循环叫醒
         * ——否则那边的 in.read() 会一直挂着。onClosing/onClosed/onFailure 可能重复进来，
         * 用 terminated 保证只处理一次。
         */
        void finishFromUpstream(int code, String reason) {
            int reported = code <= 0 ? CLOSE_ABNORMAL : code;
            synchronized (writeLock) {
                if (terminated) {
                    return;
                }
                terminated = true;
            }
            writeText("{\"type\":\"close\",\"code\":" + reported
                    + ",\"reason\":" + JSONObject.quote(reason == null ? "" : reason) + "}");
            // 1006 只写进 JSON，绝不能出现在 close 帧里（RFC 6455 §7.4.1）
            int frameCode = (reported == CLOSE_NORMAL || reported == CLOSE_GOING_AWAY)
                    ? CLOSE_NORMAL : CLOSE_INTERNAL_ERROR;
            writeFrame(OP_CLOSE, true, closePayload(frameCode, "upstream_closed"));
            // 关掉回环 socket 的输入流 = 关掉底层 fd，让阻塞在 read 上的工作线程立刻退出
            HttpUtil.closeQuietly(in);
        }

        /** 服务停止时硬拆：不发 close 握手，直接掐断。 */
        void abort() {
            terminated = true;
            WebSocket socket = upstream;
            upstream = null;
            cancelQuietly(socket);
            HttpUtil.closeQuietly(in);
        }

        /** 收尾资源（幂等）：关上游、关回环 socket 的输入流。 */
        void shutdown() {
            terminated = true;
            WebSocket socket = upstream;
            upstream = null;
            closeUpstream(socket);
            HttpUtil.closeQuietly(in);
        }
    }

    /** OkHttp 回调：上游 → 页面。跑在 OkHttp 自己的线程上。 */
    private static final class UpstreamListener extends WebSocketListener {

        private final Tunnel tunnel;
        private final CountDownLatch openSignal = new CountDownLatch(1);

        private volatile boolean open;
        private volatile String failureCode;
        private volatile String failureMessage;

        UpstreamListener(Tunnel tunnel) {
            this.tunnel = tunnel;
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            open = true;
            tunnel.upstream = webSocket;
            openSignal.countDown();
            // OkHttp 默认不会主动投递消息：先申请 1 条，之后每处理完一条再申请
            webSocket.request(1);
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            tunnel.writeText(text);
            webSocket.request(1);
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            tunnel.writeBinary(bytes.toByteArray());
            webSocket.request(1);
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            tunnel.finishFromUpstream(code, reason);
            try {
                webSocket.close(CLOSE_NORMAL, null);
            } catch (RuntimeException ignored) {
                // 关闭握手已经开始，这里只是回礼
            }
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            tunnel.finishFromUpstream(code, reason);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
            if (!open) {
                // 还没 open 就失败：把原因交给 establishUpstream，由它给页面回 error 帧
                failureCode = "UPSTREAM_FAILED";
                failureMessage = describe(failure);
                openSignal.countDown();
                return;
            }
            // 已连上后掉线：没有 close 帧，按 1006（异常断开）告诉页面
            tunnel.finishFromUpstream(CLOSE_ABNORMAL, describe(failure));
        }

        /**
         * @return true 表示上游确实连上了；false = 失败或超时
         */
        boolean awaitOpen(long timeoutMs) {
            try {
                return openSignal.await(timeoutMs, TimeUnit.MILLISECONDS) && open;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    /** 一个 WebSocket 帧。 */
    private static final class Frame {

        private final boolean fin;
        private final int opcode;
        private final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    /** 帧层协议错误：带着要回给对端的 close 码。 */
    private static final class WsProtocolException extends IOException {

        private final int code;

        WsProtocolException(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** 等 connect 控制帧超时（与「空转的 SO_TIMEOUT」区分开）。 */
    private static final class TunnelTimeoutException extends IOException {

        TunnelTimeoutException(String message) {
            super(message);
        }
    }

    /** 握手阶段的处理失败；在 handle 里统一转成 JSON。 */
    private static final class HttpError extends RuntimeException {

        private final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
