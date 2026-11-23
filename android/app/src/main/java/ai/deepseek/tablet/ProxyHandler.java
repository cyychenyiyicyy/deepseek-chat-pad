package ai.deepseek.tablet;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;

/**
 * POST /__ds_proxy 的透传实现。
 *
 * <p>协议（Web 端已固定，不可改动）：
 * <pre>
 * X-DS-Target  : base64url(完整目标 URL)，必须是 https://
 * X-DS-Method  : 真实方法，默认 POST
 * X-DS-Headers : base64url(JSON 对象)，可选
 * 请求体       : 原始字节，原样转发
 * </pre>
 *
 * <p>响应边下载边以 chunked 块回写，每收到一块就 flush，因此 SSE / 逐 token 流式输出
 * 不会被缓冲成"等全部完成再返回"。
 */
final class ProxyHandler {

    private static final String TAG = "DsProxy";

    /** 单块读取上限。16KB 足够小，token 级别的 SSE 也能立刻出去。 */
    private static final int STREAM_BUFFER_BYTES = 16 * 1024;

    /** 从客户端 socket 读请求体时的块大小。 */
    private static final int UPLOAD_BUFFER_BYTES = 8 * 1024;

    private static final String DEFAULT_METHOD = "POST";

    private static final Set<String> ALLOWED_METHODS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")));

    /**
     * 不往上游转发的头：逐跳头、由 OkHttp 重新计算的头，以及本协议自己的 X-DS-*。
     *
     * <p>accept-encoding 也挡掉——让 OkHttp 自己加 gzip 并透明解压，
     * 我们回给 WebView 的永远是非压缩字节，省得 Content-Encoding 与 chunked 打架。
     * origin/referer 指向的是本机回环地址，对上游没有意义。
     */
    private static final Set<String> BLOCKED_REQUEST_HEADERS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "host", "content-length", "transfer-encoding", "connection", "keep-alive",
                    "proxy-connection", "te", "trailer", "upgrade", "expect", "accept-encoding",
                    "origin", "referer", "x-ds-target", "x-ds-method", "x-ds-headers")));

    private static final RequestBody EMPTY_BODY = new RequestBody() {
        @Override
        public MediaType contentType() {
            return null;
        }

        @Override
        public long contentLength() {
            return 0L;
        }

        @Override
        public void writeTo(BufferedSink sink) {
            // 空体，什么都不写
        }
    };

    private final OkHttpClient client;
    private final OkHttpClient noRedirectClient;
    private final Set<Call> activeCalls =
            Collections.newSetFromMap(new ConcurrentHashMap<Call, Boolean>());

    ProxyHandler(OkHttpClient client) {
        this.client = client;
        this.noRedirectClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build();
    }

    /** 服务停止时调用，取消所有还在流的请求。 */
    void cancelAll() {
        for (Call call : activeCalls) {
            try {
                call.cancel();
            } catch (RuntimeException ignored) {
                // 已经结束的调用取消失败没关系
            }
        }
        activeCalls.clear();
    }

    /**
     * @return true 表示这条连接必须关闭（例如请求体没读完、响应体中途失败）
     */
    boolean handle(HttpUtil.Headers requestHeaders, InputStream bodyIn, OutputStream out,
            boolean keepAlive) throws IOException {
        long declaredLength = parseContentLength(requestHeaders.get("Content-Length"));
        boolean chunkedRequest = isChunked(requestHeaders);
        boolean bodyPending = chunkedRequest || declaredLength > 0L;
        // 请求体还没消费时，错误响应之后没法复用连接（残留字节会被当成下一个请求）
        boolean canKeepAlive = keepAlive && !bodyPending;

        String encodedTarget = requestHeaders.get("X-DS-Target");
        if (encodedTarget == null || encodedTarget.trim().isEmpty()) {
            return fail(out, canKeepAlive, 400, "missing_target", "缺少 X-DS-Target 请求头");
        }
        String target = HttpUtil.base64UrlToText(encodedTarget);
        if (target == null) {
            return fail(out, canKeepAlive, 400, "bad_target_encoding", "X-DS-Target 不是合法的 base64url");
        }
        target = target.trim();
        if (!target.toLowerCase(Locale.US).startsWith("https://")) {
            // 安全边界：只允许 https 出站，避免被页面拿去探测本机/内网 http 服务
            return fail(out, canKeepAlive, 400, "https_required", "只允许代理 https:// 目标");
        }
        HttpUrl url;
        try {
            url = HttpUrl.get(target);
        } catch (IllegalArgumentException badUrl) {
            return fail(out, canKeepAlive, 400, "bad_target_url", "目标 URL 无法解析");
        }
        if (url == null || !"https".equals(url.scheme())) {
            return fail(out, canKeepAlive, 400, "https_required", "只允许代理 https:// 目标");
        }

        String method = normalizeMethod(requestHeaders.get("X-DS-Method"));
        if (method == null) {
            return fail(out, canKeepAlive, 400, "bad_method", "X-DS-Method 不在允许范围内");
        }

        Map<String, String> forwardedHeaders;
        try {
            forwardedHeaders = parseHeaderJson(requestHeaders.get("X-DS-Headers"));
        } catch (JSONException brokenJson) {
            return fail(out, canKeepAlive, 400, "bad_headers_json", "X-DS-Headers 不是合法的 JSON 对象");
        }

        boolean bodyless = "GET".equals(method) || "HEAD".equals(method);
        RequestBody requestBody = null;
        if (!bodyless) {
            if (chunkedRequest) {
                requestBody = new ChunkedRequestBody(bodyIn);
            } else if (declaredLength > 0L) {
                requestBody = new StreamingRequestBody(bodyIn, declaredLength);
            }
        }

        Request.Builder builder = new Request.Builder().url(url);
        if (bodyless) {
            builder.method(method, null);
        } else if (requestBody != null) {
            builder.method(method, requestBody);
        } else if (requiresBody(method)) {
            builder.method(method, EMPTY_BODY);
        } else {
            builder.method(method, null);
        }

        boolean contentTypeProvided = false;
        for (Map.Entry<String, String> entry : forwardedHeaders.entrySet()) {
            String name = entry.getKey();
            String value = entry.getValue();
            if (name == null || value == null) {
                continue;
            }
            String trimmedName = name.trim();
            if (trimmedName.isEmpty()) {
                continue;
            }
            if (BLOCKED_REQUEST_HEADERS.contains(trimmedName.toLowerCase(Locale.US))) {
                continue;
            }
            if ("content-type".equalsIgnoreCase(trimmedName)) {
                contentTypeProvided = true;
            }
            try {
                builder.header(trimmedName, value);
            } catch (IllegalArgumentException invalidHeader) {
                Log.w(TAG, "skip invalid header: " + trimmedName);
            }
        }
        // Web 端如果没在 X-DS-Headers 里给 Content-Type，就沿用请求本身的
        String fallbackContentType = requestHeaders.get("Content-Type");
        if (!contentTypeProvided && requestBody != null && fallbackContentType != null
                && !fallbackContentType.trim().isEmpty()) {
            try {
                builder.header("Content-Type", fallbackContentType.trim());
            } catch (IllegalArgumentException ignored) {
                // 非法值直接丢弃
            }
        }

        boolean pairingRequest = url.encodedPath().startsWith("/api/v1/device-pairing/");
        boolean shareRequest = "go.dshtui.com".equals(url.host())
                && ("/api/v1/c".equals(url.encodedPath()) || url.encodedPath().startsWith("/api/v1/c/"));
        Call call = (pairingRequest || shareRequest ? noRedirectClient : client).newCall(builder.build());
        activeCalls.add(call);
        Response response;
        try {
            response = call.execute();
        } catch (IOException | RuntimeException upstreamFailed) {
            activeCalls.remove(call);
            Log.w(TAG, "upstream request failed: " + url + " -> " + upstreamFailed);
            // 请求体可能已被消费了一部分，连接状态不可知，直接关掉
            return fail(out, false, 502, "upstream_failed", describe(upstreamFailed));
        }

        try {
            return forward(response, out, canKeepAlive);
        } finally {
            activeCalls.remove(call);
            try {
                response.close();
            } catch (RuntimeException ignored) {
                // 关闭响应体失败无需处理
            }
        }
    }

    /** 把上游响应逐块转发出去；这是"真正流式"的关键函数。 */
    private boolean forward(Response response, OutputStream out, boolean keepAlive)
            throws IOException {
        int status = response.code();
        ResponseBody body = response.body();
        String contentType = response.header("Content-Type");
        String normalizedType = contentType == null ? "" : contentType.toLowerCase(Locale.US);
        boolean serverSentEvents = normalizedType.contains("text/event-stream");

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type",
                contentType == null || contentType.trim().isEmpty()
                        ? "application/octet-stream" : contentType);
        headers.put("Cache-Control", serverSentEvents
                ? "no-cache, no-transform"
                : cacheControlOrDefault(response.header("Cache-Control")));
        putIfPresent(headers, "Retry-After", response.header("Retry-After"));
        putIfPresent(headers, "X-Request-Id", response.header("X-Request-Id"));
        // OkHttp 自动解 gzip 后这个头已经没了；万一上游硬塞了别的编码，原样透传给 WebView 解码
        putIfPresent(headers, "Content-Encoding", response.header("Content-Encoding"));
        // 307/308 遇到一次性请求体时 OkHttp 不会跟着跳，把 Location 交给页面自己决定
        putIfPresent(headers, "Location", response.header("Location"));
        if (serverSentEvents) {
            // 顺便关掉中间层可能的缓冲（这里只有自己的回环连接，留着无副作用）
            headers.put("X-Accel-Buffering", "no");
        }

        if (!bodyAllowed(status)) {
            // 204/304/1xx 不能带 body，也不能用 chunked framing
            headers.put("Content-Length", "0");
            headers.put("Connection", keepAlive ? "keep-alive" : "close");
            HttpUtil.writeHead(out, status, response.message(), headers);
            out.flush();
            return !keepAlive;
        }

        headers.put("Transfer-Encoding", "chunked");
        headers.put("Connection", keepAlive ? "keep-alive" : "close");
        HttpUtil.writeHead(out, status, response.message(), headers);
        out.flush();

        if (body != null) {
            InputStream upstream = body.byteStream();
            byte[] buffer = new byte[STREAM_BUFFER_BYTES];
            int read;
            while ((read = upstream.read(buffer)) != -1) {
                // 收到一块写一块，并立刻 flush：字节不等整个响应结束就到 WebView
                HttpUtil.writeChunk(out, buffer, 0, read);
                out.flush();
            }
        }
        HttpUtil.writeLastChunk(out);
        out.flush();
        return !keepAlive;
    }

    private boolean fail(OutputStream out, boolean keepAlive, int status, String error, String message)
            throws IOException {
        String json = "{\"ok\":false,\"error\":" + JSONObject.quote(error)
                + ",\"message\":" + JSONObject.quote(message) + "}";
        HttpUtil.sendJson(out, status, keepAlive, json);
        return !keepAlive;
    }

    private static void putIfPresent(Map<String, String> headers, String name, String value) {
        if (value != null && !value.trim().isEmpty()) {
            headers.put(name, value);
        }
    }

    private static String cacheControlOrDefault(String upstream) {
        if (upstream != null && !upstream.trim().isEmpty()) {
            return upstream.trim();
        }
        return "no-store";
    }

    private static boolean bodyAllowed(int status) {
        if (status >= 100 && status < 200) {
            return false;
        }
        return status != 204 && status != 304;
    }

    private static boolean requiresBody(String method) {
        return "POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method);
    }

    /**
     * 解析 X-DS-Method。正常是明文（GET/POST…），为了容错也接受 base64url 编码过的写法。
     */
    private static String normalizeMethod(String raw) {
        String candidate = raw == null ? "" : raw.trim().toUpperCase(Locale.US);
        if (ALLOWED_METHODS.contains(candidate)) {
            return candidate;
        }
        if (candidate.isEmpty()) {
            return DEFAULT_METHOD;
        }
        String decoded = HttpUtil.base64UrlToText(candidate);
        if (decoded != null) {
            String normalized = decoded.trim().toUpperCase(Locale.US);
            if (ALLOWED_METHODS.contains(normalized)) {
                return normalized;
            }
        }
        return null;
    }

    private static Map<String, String> parseHeaderJson(String encoded) throws JSONException {
        Map<String, String> result = new LinkedHashMap<>();
        if (encoded == null || encoded.trim().isEmpty()) {
            return result;
        }
        String json = HttpUtil.base64UrlToText(encoded);
        if (json == null) {
            throw new JSONException("X-DS-Headers 不是合法的 base64url");
        }
        json = json.trim();
        if (json.isEmpty()) {
            return result;
        }
        JSONObject object = new JSONObject(json);
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = object.opt(key);
            if (value == null || value == JSONObject.NULL) {
                continue;
            }
            if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                StringBuilder joined = new StringBuilder();
                for (int index = 0; index < array.length(); index++) {
                    String item = array.optString(index, "");
                    if (item.isEmpty()) {
                        continue;
                    }
                    if (joined.length() > 0) {
                        joined.append(", ");
                    }
                    joined.append(item);
                }
                if (joined.length() > 0) {
                    result.put(key, joined.toString());
                }
            } else {
                result.put(key, String.valueOf(value));
            }
        }
        return result;
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

    private static String describe(Throwable error) {
        String message = error.getMessage();
        String type = error.getClass().getSimpleName();
        return message == null || message.isEmpty() ? type : type + ": " + message;
    }

    /** 定长请求体：边读客户端 socket 边写向上游，不在内存里攒。 */
    private static final class StreamingRequestBody extends RequestBody {

        private final InputStream source;
        private final long length;

        StreamingRequestBody(InputStream source, long length) {
            this.source = source;
            this.length = length;
        }

        @Override
        public MediaType contentType() {
            return null;
        }

        @Override
        public long contentLength() {
            return length;
        }

        @Override
        public boolean isOneShot() {
            // socket 流只能写一次，禁止 OkHttp 自动重试
            return true;
        }

        @Override
        public void writeTo(BufferedSink sink) throws IOException {
            byte[] buffer = new byte[UPLOAD_BUFFER_BYTES];
            long remaining = length;
            while (remaining > 0L) {
                int want = (int) Math.min(buffer.length, remaining);
                int read = source.read(buffer, 0, want);
                if (read == -1) {
                    throw new IOException("请求体提前结束，还差 " + remaining + " 字节");
                }
                sink.write(buffer, 0, read);
                remaining -= read;
            }
        }
    }

    /** chunked 请求体：解出每个分块后转发，上游请求同样用 chunked。 */
    private static final class ChunkedRequestBody extends RequestBody {

        private final InputStream source;

        ChunkedRequestBody(InputStream source) {
            this.source = source;
        }

        @Override
        public MediaType contentType() {
            return null;
        }

        @Override
        public long contentLength() {
            return -1L;
        }

        @Override
        public boolean isOneShot() {
            return true;
        }

        @Override
        public void writeTo(BufferedSink sink) throws IOException {
            byte[] buffer = new byte[UPLOAD_BUFFER_BYTES];
            while (true) {
                String sizeLine = HttpUtil.readLine(source);
                if (sizeLine == null) {
                    throw new IOException("chunked 请求体提前结束");
                }
                int semicolon = sizeLine.indexOf(';');
                String hex = (semicolon >= 0 ? sizeLine.substring(0, semicolon) : sizeLine).trim();
                if (hex.isEmpty()) {
                    continue;
                }
                long size;
                try {
                    size = Long.parseLong(hex, 16);
                } catch (NumberFormatException brokenChunk) {
                    throw new IOException("非法的 chunk 长度: " + hex);
                }
                if (size == 0L) {
                    // 末尾可能跟 trailer，读到空行为止
                    String trailer;
                    while ((trailer = HttpUtil.readLine(source)) != null && !trailer.isEmpty()) {
                        Log.d(TAG, "ignore trailer: " + trailer);
                    }
                    break;
                }
                long remaining = size;
                while (remaining > 0L) {
                    int want = (int) Math.min(buffer.length, remaining);
                    int read = source.read(buffer, 0, want);
                    if (read == -1) {
                        throw new IOException("chunk 数据提前结束");
                    }
                    sink.write(buffer, 0, read);
                    remaining -= read;
                }
                if (!HttpUtil.consumeCrlf(source)) {
                    throw new IOException("chunk 数据块后缺少 CRLF");
                }
            }
        }
    }
}
