package ai.deepseek.tablet;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 极简 HTTP/1.1 工具：读请求行 / 请求头、写状态行与响应头、写 chunked 分块。
 *
 * <p>全部基于 InputStream / OutputStream 的字节操作，不依赖 BufferedReader，
 * 因为请求体是二进制、必须原样转发，任何字符解码都会破坏内容。
 */
final class HttpUtil {

    private static final Charset LATIN_1 = StandardCharsets.ISO_8859_1;
    private static final Charset US_ASCII = StandardCharsets.US_ASCII;
    private static final Charset UTF_8 = StandardCharsets.UTF_8;

    private static final byte[] CRLF = new byte[] {(byte) '\r', (byte) '\n'};
    private static final byte[] LAST_CHUNK = new byte[] {'0', '\r', '\n', '\r', '\n'};

    /** 单行（请求行/请求头）最大字节数，防止畸形请求把内存撑爆。 */
    private static final int MAX_LINE_BYTES = 64 * 1024;

    private HttpUtil() {}

    /** 大小写不敏感的请求头容器；同名头按 HTTP 语义用 ", " 合并。 */
    static final class Headers {

        private final Map<String, String> values = new LinkedHashMap<>();

        void add(String name, String value) {
            if (name == null || value == null) {
                return;
            }
            String key = normalize(name);
            if (key.isEmpty()) {
                return;
            }
            String existing = values.get(key);
            values.put(key, existing == null ? value : existing + ", " + value);
        }

        String get(String name) {
            return values.get(normalize(name));
        }

        boolean isEmpty() {
            return values.isEmpty();
        }

        Map<String, String> asMap() {
            return Collections.unmodifiableMap(values);
        }

        private static String normalize(String name) {
            return name == null ? "" : name.trim().toLowerCase(Locale.US);
        }
    }

    /**
     * 读一行（以 LF 结尾，自动剥掉 CR）。
     *
     * @return 行内容；返回 null 表示对端在行首就关闭了连接
     */
    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(160);
        boolean sawAnyByte = false;
        int read;
        while (true) {
            read = in.read();
            if (read == -1) {
                if (!sawAnyByte) {
                    return null;
                }
                break;
            }
            sawAnyByte = true;
            if (read == '\n') {
                break;
            }
            if (read == '\r') {
                continue;
            }
            if (buffer.size() >= MAX_LINE_BYTES) {
                throw new IOException("header line too long");
            }
            buffer.write(read);
        }
        // 请求头只允许 ASCII/Latin-1；base64url 与 MIME 都在这个范围内
        return new String(buffer.toByteArray(), LATIN_1);
    }

    /** 读到空行为止，解析出全部请求头。 */
    static Headers readHeaders(InputStream in) throws IOException {
        Headers headers = new Headers();
        while (true) {
            String line = readLine(in);
            if (line == null || line.isEmpty()) {
                break;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            headers.add(line.substring(0, colon), line.substring(colon + 1).trim());
        }
        return headers;
    }

    /** 写状态行 + 响应头 + 空行，并立即 flush（后续写 body 时才能逐块到达 WebView）。 */
    static void writeHead(OutputStream out, int code, String reason, Map<String, String> headers)
            throws IOException {
        StringBuilder head = new StringBuilder(256);
        head.append("HTTP/1.1 ").append(code).append(' ').append(sanitizeReason(code, reason))
                .append("\r\n");
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String name = entry.getKey();
                String value = entry.getValue();
                if (name == null || value == null) {
                    continue;
                }
                head.append(name).append(": ").append(sanitizeHeaderValue(value)).append("\r\n");
            }
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(LATIN_1));
        out.flush();
    }

    /** 写一个 chunked 数据块（长度行 + 数据 + CRLF），调用方负责 flush。 */
    static void writeChunk(OutputStream out, byte[] data, int offset, int length) throws IOException {
        if (length <= 0) {
            return;
        }
        out.write(Integer.toHexString(length).getBytes(US_ASCII));
        out.write(CRLF);
        out.write(data, offset, length);
        out.write(CRLF);
    }

    /** 写 chunked 结束块 0\r\n\r\n。 */
    static void writeLastChunk(OutputStream out) throws IOException {
        out.write(LAST_CHUNK);
    }

    /** 直接回一个 JSON 响应（用于健康检查与错误）。 */
    static void sendJson(OutputStream out, int code, boolean keepAlive, String json)
            throws IOException {
        sendJson(out, code, keepAlive, json, false);
    }

    /**
     * @param headOnly 只发响应头、不发 body（HEAD 请求必须这样，否则残留字节会顶坏下一个响应）
     */
    static void sendJson(OutputStream out, int code, boolean keepAlive, String json,
            boolean headOnly) throws IOException {
        byte[] body = json == null ? new byte[0] : json.getBytes(UTF_8);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Content-Length", String.valueOf(body.length));
        headers.put("Cache-Control", "no-store");
        headers.put("Connection", keepAlive ? "keep-alive" : "close");
        writeHead(out, code, null, headers);
        if (!headOnly && body.length > 0) {
            out.write(body);
        }
        out.flush();
    }

    /** 消费 2 字节的 CRLF（宽容地接受单个 LF）。 */
    static boolean consumeCrlf(InputStream in) throws IOException {
        int first = in.read();
        if (first == -1) {
            return false;
        }
        if (first == '\r') {
            return in.read() == '\n';
        }
        return first == '\n';
    }

    /**
     * base64url（带不带 padding 都行）解码成 UTF-8 文本。
     *
     * @return 解码结果；输入不是合法 base64 时返回 null
     */
    static String base64UrlToText(String encoded) {
        if (encoded == null) {
            return null;
        }
        String value = encoded.trim();
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '=') {
            end--;
        }
        value = value.substring(0, end);
        if (value.isEmpty()) {
            return "";
        }
        try {
            byte[] bytes = Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            return new String(bytes, UTF_8);
        } catch (IllegalArgumentException urlSafeFailed) {
            // 少数实现会发标准 base64（含 + /），再试一次
            try {
                byte[] bytes = Base64.decode(value, Base64.NO_WRAP | Base64.NO_PADDING);
                return new String(bytes, UTF_8);
            } catch (IllegalArgumentException stdFailed) {
                return null;
            }
        }
    }

    static String statusText(int code) {
        switch (code) {
            case 200:
                return "OK";
            case 201:
                return "Created";
            case 202:
                return "Accepted";
            case 204:
                return "No Content";
            case 206:
                return "Partial Content";
            case 301:
                return "Moved Permanently";
            case 302:
                return "Found";
            case 304:
                return "Not Modified";
            case 307:
                return "Temporary Redirect";
            case 308:
                return "Permanent Redirect";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 408:
                return "Request Timeout";
            case 413:
                return "Payload Too Large";
            case 429:
                return "Too Many Requests";
            case 500:
                return "Internal Server Error";
            case 501:
                return "Not Implemented";
            case 502:
                return "Bad Gateway";
            case 503:
                return "Service Unavailable";
            case 504:
                return "Gateway Timeout";
            default:
                return "Status";
        }
    }

    static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException | RuntimeException ignored) {
            // 关闭失败没有补救手段，忽略
        }
    }

    private static String sanitizeReason(int code, String reason) {
        if (reason == null || reason.trim().isEmpty()) {
            return statusText(code);
        }
        return sanitizeHeaderValue(reason.trim());
    }

    private static String sanitizeHeaderValue(String value) {
        // 响应头值里不允许出现换行，防止头注入
        return value.replace('\r', ' ').replace('\n', ' ');
    }
}
