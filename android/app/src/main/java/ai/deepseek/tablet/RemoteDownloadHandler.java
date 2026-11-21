package ai.deepseek.tablet;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 「保存到系统下载目录」（{@code /__ds_download/*}）。
 *
 * <p>网页里的图片 / 文本预览原来只能看，要留到本地只能长按截图。这个模块给页面一条
 * **真正写进「下载」目录**的通道，两条系统分支：
 *
 * <ul>
 *   <li><b>Android 10+（API 29）</b>：走 {@link MediaStore.Downloads} + {@code RELATIVE_PATH}。
 *       这是分区存储下唯一「不申请任何存储权限、也能让文件出现在『下载』里」的写法；
 *       写入期间 {@code IS_PENDING=1}，写完再清掉，避免文件管理器里出现半截文件。</li>
 *   <li><b>Android 9（API 28，本应用 minSdk）</b>：{@link MediaStore.Downloads} 还不存在，
 *       只能直接往 {@link Environment#getExternalStoragePublicDirectory} 里写文件，
 *       这需要 {@code WRITE_EXTERNAL_STORAGE} 运行时权限（清单里带 maxSdkVersion=28），
 *       写完再用 {@link MediaScannerConnection#scanFile} 让图库 / 文件管理器立刻看到。</li>
 * </ul>
 *
 * <p><b>为什么请求体不走 {@code new JSONObject(String)}</b>：单文件上限 32 MiB，base64 之后
 * 光 JSON 文本就 ~44 MB，先读成 {@code String} 再解析等于同时留两份 UTF-16 副本（~90 MB），
 * 平板上的 OOM 风险完全是自找的。这里对 {@code byte[]} 做字段定位，base64 直接按字节
 * {@link Base64#decode(byte[], int, int, int)}，只有 {@code name} / {@code mime} 这两个
 * 小字段才走字符串解码。
 *
 * <p>失败一律给可读错误码（页面据此出人话）：
 * {@code bad_body} / {@code bad_name} / {@code too_large} / {@code permission_denied} / {@code io_error}。
 *
 * <p>挂载位置见 {@link LocalServer#dispatch}：必须排在静态资源之前，否则会被
 * {@link AssetHandler} 当成页面路径去 assets 里找（旧 APK 上还会 SPA 回落成 index.html 200）。
 * 所以页面探测能力请用带点的 {@code /__ds_download/state.json}。
 */
final class RemoteDownloadHandler {

    private static final String TAG = "DsDownload";

    static final String PATH_PREFIX = "/__ds_download/";
    /** 保存一个文件（POST JSON：{@code {name, mime, dataBase64}}）。 */
    static final String PATH_SAVE = "/__ds_download/save";
    /** 能力 + 状态（GET）。 */
    static final String PATH_STATE = "/__ds_download/state";
    /** 探测别名：带扩展名，旧 APK 上是真 404（不会 SPA 回落成 index.html）。 */
    static final String PATH_STATE_PROBE = "/__ds_download/state.json";
    /** Android 9 上申请存储写权限（POST）。 */
    static final String PATH_PERMISSION = "/__ds_download/permission";

    /** 单文件上限：32 MiB（页面侧读远端文件时也已经按这个数封顶）。 */
    static final int MAX_FILE_BYTES = 32 * 1024 * 1024;
    /**
     * 请求体上限：base64 膨胀 4/3 + JSON 外壳，32 MiB 的文件约 44.7 MB，这里留到 48 MiB。
     * 超过就直接 413（不读完，靠断连接收尾）。
     */
    static final int MAX_BODY_BYTES = 48 * 1024 * 1024;
    /** 申请 WRITE_EXTERNAL_STORAGE 的 requestCode（4711/4712/4713 已被占用）。 */
    static final int REQ_WRITE_STORAGE = 4714;

    private static final String DEFAULT_MIME = "application/octet-stream";
    private static final String FALLBACK_NAME = "download.bin";
    private static final int MAX_NAME_CHARS = 96;
    /** 「下载」目录在 MediaStore / 文件系统里的相对路径（响应里回给页面显示）。 */
    private static final String DOWNLOAD_RELATIVE_PATH = Environment.DIRECTORY_DOWNLOADS;

    private final Context application;
    private final ActivityTracker tracker;
    /** 本次进程是否已经弹过存储权限框：避免用户每点一次下载就弹一次 */
    private final AtomicBoolean permissionAsked = new AtomicBoolean(false);

    RemoteDownloadHandler(Context context) {
        Context resolved = context.getApplicationContext();
        this.application = resolved != null ? resolved : context;
        this.tracker = new ActivityTracker();
        if (this.application instanceof Application) {
            ((Application) this.application).registerActivityLifecycleCallbacks(tracker);
        }
    }

    /**
     * @return true 表示必须关闭连接（与其它 handler 的约定一致）
     */
    boolean handle(String method, String path, HttpUtil.Headers headers, InputStream in,
            OutputStream out, boolean keepAlive) throws IOException {
        try {
            return route(method, path, headers, in, out, keepAlive);
        } catch (HttpError refused) {
            Log.w(TAG, path + " -> " + refused.status + " " + refused.getMessage());
            HttpUtil.sendJson(out, refused.status, false, errorJson(refused.getMessage()));
            return true;
        } catch (IOException writeFailed) {
            throw writeFailed;
        } catch (Exception failure) {
            Log.w(TAG, "下载接口失败：" + path, failure);
            HttpUtil.sendJson(out, 500, false, errorJson("io_error"));
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
        if (PATH_SAVE.equals(path)) {
            requirePost(method);
            JSONObject result = save(in, headers);
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }
        if (PATH_PERMISSION.equals(path)) {
            requirePost(method);
            // 请求体可能是 {}，读干净再动手（否则残留字节会被当成下一个请求）
            readBodyBytes(in, headers);
            boolean granted = requestWritePermission();
            JSONObject result = stateObject();
            result.put("ok", true);
            result.put("granted", granted);
            result.put("requested", !granted && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    && permissionAsked.get());
            HttpUtil.sendJson(out, 200, keepAlive, result.toString(), "HEAD".equals(method));
            return !keepAlive;
        }
        // 旧 APK 的 SPA 回落会把未知路径回成 index.html，所以这里给真 404 才不会被误判成「支持」
        throw new HttpError(404, "not_found");
    }

    // ---------------------------------------------------------------- 保存

    /**
     * 保存一个文件到「下载」目录。
     *
     * <p>顺序讲究：<b>先校验</b>（名字 / 大小 / 权限），**最后**才碰存储 —— 失败时不留下
     * 半截文件或空的 MediaStore 行。
     */
    private JSONObject save(InputStream in, HttpUtil.Headers headers) throws IOException, JSONException {
        byte[] body = readBodyBytes(in, headers);
        String rawName = decodeStringField(body, "name");
        String name = sanitizeName(rawName);
        if (name == null) {
            throw new HttpError(400, "bad_name");
        }
        String mime = normalizeMime(decodeStringField(body, "mime"), name);

        byte[] data = decodeDataField(body);
        if (data.length == 0) {
            throw new HttpError(400, "bad_body");
        }
        if (data.length > MAX_FILE_BYTES) {
            throw new HttpError(413, "too_large");
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveViaMediaStore(name, mime, data);
        }
        return saveViaPublicDirectory(name, mime, data);
    }

    /** Android 10+：MediaStore.Downloads（不需要任何存储权限）。 */
    private JSONObject saveViaMediaStore(String name, String mime, byte[] data)
            throws JSONException {
        ContentResolver resolver = application.getContentResolver();
        if (resolver == null) {
            throw new HttpError(500, "io_error");
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, DOWNLOAD_RELATIVE_PATH);
        // 写入期间标记为 pending：文件管理器里不会出现半截文件
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = null;
        try {
            uri = resolver.insert(collection, values);
            if (uri == null) {
                throw new HttpError(500, "io_error");
            }
            OutputStream stream = resolver.openOutputStream(uri, "w");
            if (stream == null) {
                throw new HttpError(500, "io_error");
            }
            try {
                stream.write(data);
                stream.flush();
            } finally {
                closeQuietly(stream);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        } catch (IOException writeFailed) {
            Log.w(TAG, "写 MediaStore 失败", writeFailed);
            deleteQuietly(resolver, uri);
            throw new HttpError(500, "io_error");
        } catch (RuntimeException broken) {
            Log.w(TAG, "MediaStore 抛异常", broken);
            deleteQuietly(resolver, uri);
            throw new HttpError(500, "io_error");
        }
        String displayName = queryDisplayName(resolver, uri, name);
        return success(uri.toString(), displayName);
    }

    /** Android 9：直接写公共「下载」目录，需要 WRITE_EXTERNAL_STORAGE。 */
    private JSONObject saveViaPublicDirectory(String name, String mime, byte[] data)
            throws JSONException {
        if (!hasWritePermission()) {
            // 前端收到 permission_denied 后会拉起 /permission 并自动重试一次
            throw new HttpError(403, "permission_denied");
        }
        File dir = Environment.getExternalStoragePublicDirectory(DOWNLOAD_RELATIVE_PATH);
        if (dir == null) {
            throw new HttpError(500, "io_error");
        }
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "下载目录建不出来：" + dir);
            throw new HttpError(500, "io_error");
        }
        File target = uniqueFile(dir, name);
        try {
            FileOutputStream stream = new FileOutputStream(target);
            try {
                stream.write(data);
                stream.flush();
            } finally {
                closeQuietly(stream);
            }
        } catch (IOException writeFailed) {
            Log.w(TAG, "写下载目录失败", writeFailed);
            // 失败要收尸：别留一个 0 字节同名文件，下次同名下载会变成 "xxx (1)"
            if (target.isFile() && !target.delete()) {
                Log.w(TAG, "清理半截文件失败：" + target);
            }
            throw new HttpError(500, "io_error");
        }
        // 让图库 / 文件管理器立刻看到（不扫的话要等下次开机媒体扫描）
        try {
            MediaScannerConnection.scanFile(application,
                    new String[] {target.getAbsolutePath()}, new String[] {mime}, null);
        } catch (RuntimeException ignored) {
            Log.w(TAG, "媒体扫描没跑起来，文件仍然在下载目录里");
        }
        return success(Uri.fromFile(target).toString(), target.getName());
    }

    /**
     * 同名文件不覆盖：`a.png` → `a (1).png`。
     *
     * <p>为什么不用 {@code " (n)"} 去猜而是一个个 stat：目标目录里可能已经有
     * `a (1).png`、`a (3).png`，猜 n 反而会撞。<b>只加后缀，不动主名</b>，
     * 扩展名留在最后，用户的「下载」里仍然按类型分组。
     */
    private static File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) {
            return candidate;
        }
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int index = 1; index < 1000; index++) {
            File next = new File(dir, base + " (" + index + ")" + extension);
            if (!next.exists()) {
                return next;
            }
        }
        // 极端情况：同名的已经有一千个，用一个带时间戳的名字兜底（仍然不覆盖）
        return new File(dir, base + " (" + System.currentTimeMillis() + ")" + extension);
    }

    private static String queryDisplayName(ContentResolver resolver, Uri uri, String fallback) {
        Cursor cursor = null;
        try {
            cursor = resolver.query(uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME},
                    null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String value = cursor.getString(index);
                    if (value != null && value.length() > 0) {
                        return value;
                    }
                }
            }
        } catch (RuntimeException ignored) {
            Log.w(TAG, "读回 displayName 失败，沿用请求里的名字");
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (RuntimeException ignored) {
                    // 关不掉就算了
                }
            }
        }
        return fallback;
    }

    private static void deleteQuietly(ContentResolver resolver, Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            resolver.delete(uri, null, null);
        } catch (RuntimeException ignored) {
            Log.w(TAG, "清理 MediaStore 行失败");
        }
    }

    private static JSONObject success(String uri, String displayName) throws JSONException {
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("uri", uri);
        result.put("displayName", displayName);
        result.put("relativePath", DOWNLOAD_RELATIVE_PATH + "/");
        return result;
    }

    // ---------------------------------------------------------------- 状态 / 权限

    private String stateJson() throws JSONException {
        return stateObject().toString();
    }

    private JSONObject stateObject() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("canWrite", canWrite());
        json.put("dir", downloadDirLabel());
        json.put("sdkInt", Build.VERSION.SDK_INT);
        json.put("relativePath", DOWNLOAD_RELATIVE_PATH + "/");
        json.put("needsPermission", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q);
        return json;
    }

    /** 28 上表示运行时权限是否已授予；29+ 恒 true（MediaStore.Downloads 不需要权限）。 */
    private boolean canWrite() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return true;
        }
        return hasWritePermission();
    }

    private boolean hasWritePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return true;
        }
        try {
            return application.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException broken) {
            Log.w(TAG, "查存储权限失败", broken);
            return false;
        }
    }

    /** 「下载」目录的绝对路径（29+ 也是这个路径，只是写入方式变成 MediaStore）。 */
    private String downloadDirLabel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return Environment.DIRECTORY_DOWNLOADS;
        }
        File dir = Environment.getExternalStoragePublicDirectory(DOWNLOAD_RELATIVE_PATH);
        return dir == null ? Environment.DIRECTORY_DOWNLOADS : dir.getAbsolutePath();
    }

    /**
     * 申请 Android 9 的存储写权限。
     *
     * <p>三条闸门，与通知权限那次是同一套取舍：
     * <ol>
     *   <li>29+ 不需要这个权限 → 直接算已授予</li>
     *   <li>已经授予 → 不问</li>
     *   <li>没有 resumed 的 Activity → 问不了（系统禁止后台弹权限框），返回 false 让页面出人话</li>
     * </ol>
     *
     * @return true 表示此刻已经能写（不表示用户的这次点击一定弹了框）
     */
    boolean requestWritePermission() {
        if (canWrite()) {
            return true;
        }
        Activity activity = tracker.resumedActivity();
        if (activity == null) {
            Log.i(TAG, "没有前台的 Activity，存储权限只能等用户回到应用时再要");
            return false;
        }
        if (permissionAsked.compareAndSet(false, true)) {
            final Activity target = activity;
            // 工作线程不能直接 requestPermissions：丢回主线程
            target.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        target.requestPermissions(
                                new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE},
                                REQ_WRITE_STORAGE);
                        Log.i(TAG, "已发出 WRITE_EXTERNAL_STORAGE 申请");
                    } catch (RuntimeException failed) {
                        Log.w(TAG, "requestPermissions 失败", failed);
                    }
                }
            });
            return false;
        }
        // 本次进程已经问过：用户拒绝后不再反复弹（页面会显示「去设置里允许」）
        return false;
    }

    // ---------------------------------------------------------------- 请求体

    /**
     * 把请求体读成 byte[]（上限 {@link #MAX_BODY_BYTES}）。
     *
     * <p>刻意不读成 String：body 里 90% 是 base64，转 String 等于多留一份 UTF-16。
     */
    private static byte[] readBodyBytes(InputStream in, HttpUtil.Headers headers) throws IOException {
        if (isChunked(headers)) {
            throw new HttpError(400, "chunked_body_unsupported");
        }
        long declared = parseContentLength(headers.get("Content-Length"));
        if (declared <= 0L) {
            throw new HttpError(400, "bad_body");
        }
        if (declared > MAX_BODY_BYTES) {
            // 不读完就回包：HTTP 允许发完响应后关连接，handle() 会走「必须关连接」的分支
            throw new HttpError(413, "too_large");
        }
        byte[] body = new byte[(int) declared];
        int filled = 0;
        while (filled < body.length) {
            int read = in.read(body, filled, body.length - filled);
            if (read == -1) {
                throw new HttpError(400, "bad_body");
            }
            filled += read;
        }
        return body;
    }

    /**
     * 定位一个 JSON 字符串字段的**内容字节区间**（不含引号）。
     *
     * <p>只认 {@code "key" : "..."} 这种形状：base64 字母表里没有引号和冒号，
     * 所以不会把数据里的偶然子串当成字段。
     *
     * @return 长度为 2 的数组 {start, end}；找不到回 null
     */
    private static int[] findStringField(byte[] body, String key) {
        byte[] needle = ("\"" + key + "\"").getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i + needle.length <= body.length; i++) {
            if (body[i] != needle[0]) {
                continue;
            }
            boolean match = true;
            for (int j = 1; j < needle.length; j++) {
                if (body[i + j] != needle[j]) {
                    match = false;
                    break;
                }
            }
            if (!match) {
                continue;
            }
            int cursor = i + needle.length;
            cursor = skipWhitespace(body, cursor);
            if (cursor >= body.length || body[cursor] != ':') {
                continue;
            }
            cursor = skipWhitespace(body, cursor + 1);
            if (cursor >= body.length || body[cursor] != '"') {
                continue;
            }
            int start = cursor + 1;
            int end = start;
            while (end < body.length) {
                byte current = body[end];
                if (current == '\\') {
                    // 跳过被转义的字节（引号 / 反斜杠 / 斜杠 / unicode 转义 …）
                    end += 2;
                    continue;
                }
                if (current == '"') {
                    return new int[] {start, end};
                }
                end++;
            }
            return null;
        }
        return null;
    }

    private static int skipWhitespace(byte[] body, int from) {
        int cursor = from;
        while (cursor < body.length) {
            byte current = body[cursor];
            if (current == ' ' || current == '\t' || current == '\r' || current == '\n') {
                cursor++;
                continue;
            }
            break;
        }
        return cursor;
    }

    /** 取一个小字符串字段（name / mime），做 JSON 反转义；缺失回 null。 */
    private static String decodeStringField(byte[] body, String key) {
        int[] range = findStringField(body, key);
        if (range == null) {
            return null;
        }
        String raw = new String(body, range[0], range[1] - range[0], StandardCharsets.UTF_8);
        return unescapeJson(raw);
    }

    /** 取 base64 正文；字段缺失 / 非法一律 400（页面发错比自己猜更不容易出事故）。 */
    private static byte[] decodeDataField(byte[] body) {
        int[] range = findStringField(body, "dataBase64");
        if (range == null) {
            throw new HttpError(400, "bad_body");
        }
        int length = range[1] - range[0];
        if (length == 0) {
            throw new HttpError(400, "bad_body");
        }
        try {
            boolean escaped = false;
            for (int index = range[0]; index < range[1]; index++) {
                if (body[index] == '\\') {
                    escaped = true;
                    break;
                }
            }
            if (escaped) {
                // 少数编码器会把 '/' 转成 "\/"：先反转义再按字符串解
                String raw = new String(body, range[0], length, StandardCharsets.UTF_8);
                return Base64.decode(unescapeJson(raw), Base64.DEFAULT);
            }
            return Base64.decode(body, range[0], length, Base64.DEFAULT);
        } catch (IllegalArgumentException broken) {
            throw new HttpError(400, "bad_body");
        }
    }

    /** JSON 字符串反转义（够用即可：MT/页面那边不会发离谱的东西，但别把 \" 当正文）。 */
    private static String unescapeJson(String raw) {
        if (raw.indexOf('\\') < 0) {
            return raw;
        }
        StringBuilder out = new StringBuilder(raw.length());
        int index = 0;
        while (index < raw.length()) {
            char current = raw.charAt(index);
            if (current != '\\' || index + 1 >= raw.length()) {
                out.append(current);
                index++;
                continue;
            }
            char next = raw.charAt(index + 1);
            switch (next) {
                case 'n':
                    out.append('\n');
                    index += 2;
                    break;
                case 'r':
                    out.append('\r');
                    index += 2;
                    break;
                case 't':
                    out.append('\t');
                    index += 2;
                    break;
                case 'b':
                    out.append('\b');
                    index += 2;
                    break;
                case 'f':
                    out.append('\f');
                    index += 2;
                    break;
                case 'u':
                    if (index + 6 <= raw.length()) {
                        try {
                            out.append((char) Integer.parseInt(raw.substring(index + 2, index + 6), 16));
                            index += 6;
                        } catch (NumberFormatException broken) {
                            out.append(next);
                            index += 2;
                        }
                    } else {
                        out.append(next);
                        index += 2;
                    }
                    break;
                default:
                    // \" \\ \/ 以及未知转义：都按字面量收下
                    out.append(next);
                    index += 2;
                    break;
            }
        }
        return out.toString();
    }

    // ---------------------------------------------------------------- 名字 / MIME

    /**
     * 净化文件名：**去路径分隔符与 `..`**、去控制字符、替换文件名非法字符、限长保留扩展名。
     *
     * @return 合法名字；完全不可用时回 null（调用方回 400 bad_name）
     */
    static String sanitizeName(String raw) {
        if (raw == null) {
            return null;
        }
        String name = raw;
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        StringBuilder cleaned = new StringBuilder(name.length());
        for (int index = 0; index < name.length(); index++) {
            char current = name.charAt(index);
            if (current < 0x20 || current == 0x7F) {
                continue;
            }
            switch (current) {
                case ':':
                case '*':
                case '?':
                case '"':
                case '<':
                case '>':
                case '|':
                    cleaned.append('_');
                    break;
                default:
                    cleaned.append(current);
                    break;
            }
        }
        name = cleaned.toString();
        // 去 ".."：`../../etc/passwd` 已经被去路径截成 `passwd`，但 `a..b` / `..` 这种还要挡
        while (name.contains("..")) {
            name = name.replace("..", ".");
        }
        name = trimEnds(name);
        if (name.length() == 0 || ".".equals(name)) {
            return null;
        }
        if (name.length() > MAX_NAME_CHARS) {
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 ? name.substring(dot) : "";
            if (extension.length() > MAX_NAME_CHARS / 2) {
                extension = "";
            }
            int keep = Math.max(1, MAX_NAME_CHARS - extension.length());
            name = trimEnds(name.substring(0, keep)) + extension;
            if (name.length() == 0) {
                return FALLBACK_NAME;
            }
        }
        return name;
    }

    private static String trimEnds(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && isBlank(value.charAt(start))) {
            start++;
        }
        // 结尾的 '.' 与空格在 Windows / 部分 ROM 上会被静默吃掉，一起剪掉
        while (end > start && (isBlank(value.charAt(end - 1)) || value.charAt(end - 1) == '.')) {
            end--;
        }
        return value.substring(start, end);
    }

    private static boolean isBlank(char value) {
        return value == ' ' || value == '\t';
    }

    /** MIME 兜底：空 / 非法形状都按扩展名推，再不行 application/octet-stream。 */
    static String normalizeMime(String raw, String name) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.US);
        if (isMimeShaped(value)) {
            return value;
        }
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String extension = name.substring(dot + 1).toLowerCase(Locale.US);
            String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (guessed != null && isMimeShaped(guessed)) {
                return guessed;
            }
        }
        return DEFAULT_MIME;
    }

    private static boolean isMimeShaped(String value) {
        if (value.length() == 0 || value.length() > 127) {
            return false;
        }
        int slash = value.indexOf('/');
        if (slash <= 0 || slash == value.length() - 1) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            boolean legal = (current >= 'a' && current <= 'z')
                    || (current >= '0' && current <= '9')
                    || current == '/' || current == '+' || current == '-' || current == '.';
            if (!legal) {
                return false;
            }
        }
        return true;
    }

    // ---------------------------------------------------------------- 小工具

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

    private static void closeQuietly(OutputStream stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException ignored) {
            // 关流失败没什么能做的
        }
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

    private static String errorJson(String error) {
        try {
            JSONObject json = new JSONObject();
            json.put("ok", false);
            json.put("error", error);
            return json.toString();
        } catch (JSONException broken) {
            return "{\"ok\":false,\"error\":\"io_error\"}";
        }
    }

    /** 只带状态码与错误码的轻量异常（与 KeepAliveHandler / DbHandler 的写法一致）。 */
    private static final class HttpError extends RuntimeException {

        private static final long serialVersionUID = 1L;

        final int status;

        HttpError(int status, String code) {
            super(code);
            this.status = status;
        }
    }

    /**
     * 只跟踪「当前 resumed 的 Activity」。
     *
     * <p>{@code LocalServer} 拿到的是 Application context，而 {@code requestPermissions}
     * 必须有 Activity。与 {@code KeepAliveHandler.ActivityTracker} / {@code RemoteAuthHandler}
     * 内部那个是同一套取舍（那份是 private 内部类，本批改动范围不允许动那两个文件，
     * 所以各留一份很短的实现；都只读 resumed 快照，互不干扰）。
     */
    private static final class ActivityTracker implements Application.ActivityLifecycleCallbacks {

        private final AtomicReference<Activity> resumed = new AtomicReference<Activity>();

        Activity resumedActivity() {
            Activity current = resumed.get();
            if (current == null || current.isFinishing()) {
                return null;
            }
            return current;
        }

        @Override
        public void onActivityCreated(Activity activity, Bundle savedInstanceState) {
            // 不需要
        }

        @Override
        public void onActivityStarted(Activity activity) {
            // 不需要
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
            // 不需要
        }

        @Override
        public void onActivitySaveInstanceState(Activity activity, Bundle outState) {
            // 不需要
        }

        @Override
        public void onActivityDestroyed(Activity activity) {
            resumed.compareAndSet(activity, null);
        }
    }
}
