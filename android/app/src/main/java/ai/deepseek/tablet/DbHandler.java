package ai.deepseek.tablet;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * /__ds_db/* 的实现：会话存储的原生接口（详见 work/2026-11-17-deepseek-tablet/native-sqlite-design.md）。
 *
 * <p>接口一览（页面同源直接 fetch，不需要额外权限）：
 * <pre>
 * GET  /__ds_db/state                  {schemaVersion, sessions, messages, files, migrated}
 * GET  /__ds_db/summaries              {sessions: SessionSummary[]}
 * GET  /__ds_db/session?id=            {session} 或 404
 * POST /__ds_db/session                {session, fileIds}     同事务写 sessions + messages
 * POST /__ds_db/rename                 {id, title}
 * POST /__ds_db/delete                 {id}                  删会话 + 消息 + 无引用原件
 * POST /__ds_db/file?id=               原始字节（Content-Type: application/octet-stream）
 * GET  /__ds_db/file?id=               原始字节；没有则 404
 * POST /__ds_db/import                 {sessions, fileIdsById}   {ok, imported}
 * POST /__ds_db/reset                  {}                    仅迁移调试用
 * </pre>
 *
 * <p>约定：
 * <ul>
 *   <li>除 file 的二进制响应外一律 JSON，统一 {@code {"ok":true,...}} / {@code {"ok":false,"error":"..."}}</li>
 *   <li>POST 先按 Content-Length 读完整个请求体再解析；超过 {@link #MAX_BODY_BYTES} 回 413</li>
 *   <li>所有异常在这里兜住并转成 JSON（5xx），绝不让它冒到 LocalServer 把整条连接打死</li>
 * </ul>
 */
final class DbHandler {

    private static final String TAG = "DsDb";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_db/";

    private static final String PATH_STATE = "/__ds_db/state";
    private static final String PATH_SUMMARIES = "/__ds_db/summaries";
    private static final String PATH_SESSION = "/__ds_db/session";
    private static final String PATH_RENAME = "/__ds_db/rename";
    private static final String PATH_DELETE = "/__ds_db/delete";
    private static final String PATH_FILE = "/__ds_db/file";
    private static final String PATH_IMPORT = "/__ds_db/import";
    private static final String PATH_RESET = "/__ds_db/reset";

    private static final String PARAM_ID = "id";
    /** 附件真实 MIME 走这个头传：请求体本身必须是 application/octet-stream */
    private static final String HEADER_MIME = "X-DS-Mime";

    /** 单个请求体上限。最大的请求是导入批次（20 个会话的 JSON）与单张图片 */
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int READ_BUFFER_BYTES = 8 * 1024;

    private final ChatDatabase database;

    DbHandler(Context context) {
        this.database = new ChatDatabase(context);
    }

    /**
     * @param target 原始请求目标（含查询串，file 要从 ?id= 取附件 id）
     * @param path   已经剥掉查询串的路径
     * @return true 表示这条连接必须关闭
     */
    boolean handle(String method, String target, String path, HttpUtil.Headers headers,
            InputStream in, OutputStream out, boolean keepAlive) throws IOException {
        try {
            return route(method, target, path, headers, in, out, keepAlive);
        } catch (HttpError refused) {
            // 请求体可能还没读完，一律关连接：残留字节会被当成下一个请求
            Log.w(TAG, path + " -> " + refused.status + " " + refused.getMessage());
            HttpUtil.sendJson(out, refused.status, false, errorJson(refused.getMessage()));
            return true;
        } catch (IOException writeFailed) {
            // 写响应失败（页面已经走了），交给 LocalServer 收尾关连接
            throw writeFailed;
        } catch (Exception failure) {
            // 数据库/JSON 异常不能冒泡到 LocalServer，否则整条连接被直接打死，页面只看到网络错误
            Log.w(TAG, "db 接口失败：" + path, failure);
            HttpUtil.sendJson(out, 500, false, errorJson(describe(failure)));
            return true;
        }
    }

    private boolean route(String method, String target, String path, HttpUtil.Headers headers,
            InputStream in, OutputStream out, boolean keepAlive)
            throws IOException, JSONException {
        if (PATH_STATE.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, stateJson(database.counts()),
                    "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_SUMMARIES.equals(path)) {
            requireReadOnly(method);
            HttpUtil.sendJson(out, 200, keepAlive, summariesJson(database.summaries()),
                    "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_SESSION.equals(path)) {
            if ("POST".equals(method)) {
                JSONObject body = readJsonBody(in, headers);
                JSONObject session = body.optJSONObject("session");
                if (session == null) {
                    throw new HttpError(400, "session_required");
                }
                database.saveSession(session, body.optJSONArray("fileIds"));
                HttpUtil.sendJson(out, 200, keepAlive, OK_JSON);
                return !keepAlive;
            }
            requireReadOnly(method);
            String id = requireQueryParam(target);
            JSONObject session = database.loadSession(id);
            if (session == null) {
                throw new HttpError(404, "not_found");
            }
            HttpUtil.sendJson(out, 200, keepAlive, sessionJson(session), "HEAD".equals(method));
            return !keepAlive;
        }

        if (PATH_RENAME.equals(path)) {
            requirePost(method);
            JSONObject body = readJsonBody(in, headers);
            String id = requireField(body, "id");
            String title = body.optString("title", "");
            // 会话不存在时与 IndexedDB 版一致：静默无操作，不改名也不报错（重命名是幂等的）
            database.rename(id, title);
            HttpUtil.sendJson(out, 200, keepAlive, OK_JSON);
            return !keepAlive;
        }

        if (PATH_DELETE.equals(path)) {
            requirePost(method);
            JSONObject body = readJsonBody(in, headers);
            // 删不存在的会话不算错误：上层删除是幂等的
            database.delete(requireField(body, "id"));
            HttpUtil.sendJson(out, 200, keepAlive, OK_JSON);
            return !keepAlive;
        }

        if (PATH_FILE.equals(path)) {
            if ("POST".equals(method)) {
                storeFile(target, in, headers, out, keepAlive);
                return !keepAlive;
            }
            requireReadOnly(method);
            serveFile(target, method, out, keepAlive);
            return !keepAlive;
        }

        if (PATH_IMPORT.equals(path)) {
            requirePost(method);
            JSONObject body = readJsonBody(in, headers);
            JSONArray sessions = body.optJSONArray("sessions");
            if (sessions == null) {
                throw new HttpError(400, "sessions_required");
            }
            int imported = database.importSessions(sessions, body.optJSONObject("fileIdsById"));
            HttpUtil.sendJson(out, 200, keepAlive, importJson(imported));
            return !keepAlive;
        }

        if (PATH_RESET.equals(path)) {
            requirePost(method);
            database.reset();
            HttpUtil.sendJson(out, 200, keepAlive, OK_JSON);
            return !keepAlive;
        }

        throw new HttpError(404, "not_found");
    }

    // ---------------------------------------------------------------- 附件

    /** POST /__ds_db/file?id= ：请求体是原始字节，不进 JSON。 */
    private void storeFile(String target, InputStream in, HttpUtil.Headers headers, OutputStream out,
            boolean keepAlive) throws IOException {
        String id = requireQueryParam(target);
        String mime = headers.get(HEADER_MIME);
        if (mime == null || mime.trim().isEmpty()) {
            mime = headers.get("Content-Type");
        }
        byte[] data = readBody(in, headers);
        if (data.length == 0) {
            throw new HttpError(400, "empty_body");
        }
        database.putFile(id, mime == null ? "" : mime.trim(), data);
        HttpUtil.sendJson(out, 200, keepAlive, OK_JSON);
    }

    /**
     * GET /__ds_db/file?id= ：直接回二进制。
     *
     * <p>Content-Type 按契约固定 octet-stream，真实 MIME 走 X-DS-Mime 响应头带走，
     * 页面用它构造 Blob（否则缩略图的类型就丢了）。
     */
    private void serveFile(String target, String method, OutputStream out, boolean keepAlive)
            throws IOException {
        String id = requireQueryParam(target);
        byte[] data = database.getFile(id);
        if (data == null) {
            throw new HttpError(404, "not_found");
        }
        Map<String, String> responseHeaders = new LinkedHashMap<>();
        responseHeaders.put("Content-Type", "application/octet-stream");
        responseHeaders.put("Content-Length", String.valueOf(data.length));
        responseHeaders.put("Cache-Control", "no-store");
        responseHeaders.put("Connection", keepAlive ? "keep-alive" : "close");
        String mime = database.getFileMime(id);
        if (mime != null && !mime.trim().isEmpty()) {
            responseHeaders.put(HEADER_MIME, mime.trim());
        }
        HttpUtil.writeHead(out, 200, null, responseHeaders);
        if (!"HEAD".equals(method)) {
            out.write(data);
        }
        out.flush();
    }

    // ---------------------------------------------------------------- 请求体

    /** 按 Content-Length 读完整请求体；超限 413，短读 400。 */
    private static byte[] readBody(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            // 页面发的是定长请求（字符串 / Blob / Uint8Array），chunked 只可能来自异常客户端
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared > MAX_BODY_BYTES) {
            throw new HttpError(413, "payload_too_large");
        }
        if (declared <= 0L) {
            return new byte[0];
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.min(declared, 64 * 1024));
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

    // ---------------------------------------------------------------- 小工具

    private static String stateJson(JSONObject counts) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("schemaVersion", counts.optInt("schemaVersion", ChatDatabase.VERSION));
        json.put("sessions", counts.optLong("sessions", 0L));
        json.put("messages", counts.optLong("messages", 0L));
        json.put("files", counts.optLong("files", 0L));
        json.put("migrated", counts.optBoolean("migrated", false));
        return json.toString();
    }

    private static String summariesJson(JSONArray sessions) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("sessions", sessions);
        return json.toString();
    }

    private static String sessionJson(JSONObject session) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("session", session);
        return json.toString();
    }

    private static String importJson(int imported) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("imported", imported);
        return json.toString();
    }

    private static final String OK_JSON = "{\"ok\":true}";

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

    private static String requireQueryParam(String target) {
        String id = queryParam(target, PARAM_ID);
        if (id == null || id.isEmpty()) {
            throw new HttpError(400, "id_required");
        }
        return id;
    }

    private static String requireField(JSONObject body, String name) {
        String value = body.optString(name, "");
        if (value.isEmpty()) {
            throw new HttpError(400, name + "_required");
        }
        return value;
    }

    /** 从请求目标里取查询参数（已做 URL 解码）；没有该参数返回 null。 */
    private static String queryParam(String target, String name) {
        if (target == null) {
            return null;
        }
        int question = target.indexOf('?');
        if (question < 0) {
            return null;
        }
        String query = target.substring(question + 1);
        int fragment = query.indexOf('#');
        if (fragment >= 0) {
            query = query.substring(0, fragment);
        }
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int equals = pair.indexOf('=');
            String key = equals >= 0 ? pair.substring(0, equals) : pair;
            String decodedKey = decode(key);
            if (!name.equals(decodedKey)) {
                continue;
            }
            return equals >= 0 ? decode(pair.substring(equals + 1)) : "";
        }
        return null;
    }

    private static String decode(String raw) {
        try {
            return URLDecoder.decode(raw, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException brokenEncoding) {
            return null;
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
