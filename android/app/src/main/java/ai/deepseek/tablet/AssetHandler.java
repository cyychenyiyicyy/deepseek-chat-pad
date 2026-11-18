package ai.deepseek.tablet;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 静态站点服务：优先用下载的网页包（{@code filesDir/web}），没有就回退 APK 内置的 assets/www/。
 *
 * <ul>
 *   <li>/ → index.html</li>
 *   <li>/foo/ → foo/index.html</li>
 *   <li>静态资源带 hash（static/ 下）给一年 immutable 缓存，html 给 no-cache</li>
 * </ul>
 *
 * 两套来源共用同一套路径规范化与越权校验（{@link #normalizePath}），
 * 文件来源额外做一次真实路径包含判断，读不到就 404。
 */
final class AssetHandler {

    private static final String TAG = "DsAssets";
    private static final String ROOT = "www/";
    private static final String INDEX = "index.html";
    private static final int BUFFER_BYTES = 16 * 1024;

    private final AssetManager assets;
    private final WebBundle webBundle;

    AssetHandler(Context context, WebBundle webBundle) {
        Context application = context.getApplicationContext();
        this.assets = (application != null ? application : context).getAssets();
        this.webBundle = webBundle;
    }

    /**
     * @return true 表示这条连接必须关闭（响应体没发完整等异常情况）
     */
    boolean handle(String rawPath, boolean headOnly, OutputStream out, boolean keepAlive)
            throws IOException {
        String path = normalizePath(rawPath);
        if (path == null) {
            Log.w(TAG, "rejected suspicious path: " + rawPath);
            return notFound(out, keepAlive);
        }

        String relativePath = toAssetPath(path);

        // 下载过网页包就优先用它：apply-web 换完目录后刷新页面即生效
        File installedRoot = webBundle.installedRoot();
        if (installedRoot != null) {
            return serveFromFiles(installedRoot, relativePath, headOnly, out, keepAlive);
        }
        return serveFromAssets(relativePath, headOnly, out, keepAlive);
    }

    /** 从下载的网页包里读；路径已由 normalizePath 校验过。 */
    private boolean serveFromFiles(File root, String relativePath, boolean headOnly,
            OutputStream out, boolean keepAlive) throws IOException {
        File file = resolveInside(root, relativePath);
        if (file == null || !file.isFile()) {
            String fallback = spaFallback(relativePath);
            file = fallback == null ? null : resolveInside(root, fallback);
            if (file == null || !file.isFile()) {
                Log.d(TAG, "404 (web bundle) /" + relativePath);
                return notFound(out, keepAlive);
            }
            relativePath = fallback;
        }
        InputStream stream = new BufferedInputStream(new FileInputStream(file), BUFFER_BYTES);
        try {
            writeResource(relativePath, stream, file.length(), headOnly, out, keepAlive);
        } finally {
            HttpUtil.closeQuietly(stream);
        }
        return !keepAlive;
    }

    /**
     * 把包内相对路径落成真实文件，并确认没跑出根目录。
     *
     * <p>normalizePath 已经挡掉 ".." 与反斜杠，这里再做一次真实路径包含判断，
     * 防止符号链接之类的绕过。
     */
    private static File resolveInside(File root, String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) {
            return null;
        }
        try {
            String rootPath = root.getCanonicalPath();
            File candidate = new File(root, relativePath);
            String candidatePath = candidate.getCanonicalPath();
            if (!candidatePath.equals(rootPath)
                    && !candidatePath.startsWith(rootPath + File.separator)) {
                Log.w(TAG, "rejected path outside web bundle: " + relativePath);
                return null;
            }
            return candidate;
        } catch (IOException brokenPath) {
            return null;
        }
    }

    /** 回退来源：APK 内置的 assets/www/。 */
    private boolean serveFromAssets(String assetPath, boolean headOnly, OutputStream out,
            boolean keepAlive) throws IOException {
        InputStream stream = null;
        AssetFileDescriptor descriptor = null;
        long knownLength = -1L;
        try {
            // 1) 优先用 openFd：未压缩资源能拿到精确长度，可以发 Content-Length
            try {
                descriptor = assets.openFd(ROOT + assetPath);
                long length = descriptor.getLength();
                if (length > 0L) {
                    stream = descriptor.createInputStream();
                    knownLength = length;
                }
            } catch (IOException compressedOrMissing) {
                // 压缩进 APK 的资源无法拿到 fd，下面的 assets.open() 兜底
                HttpUtil.closeQuietly(descriptor);
                descriptor = null;
            }

            // 2) 回退到普通流式读取（此时长度未知，用 chunked 输出）
            if (stream == null) {
                try {
                    stream = assets.open(ROOT + assetPath, AssetManager.ACCESS_STREAMING);
                    knownLength = -1L;
                } catch (FileNotFoundException missing) {
                    String fallback = spaFallback(assetPath);
                    if (fallback == null) {
                        Log.d(TAG, "404 /" + assetPath);
                        return notFound(out, keepAlive);
                    }
                    try {
                        stream = assets.open(ROOT + fallback, AssetManager.ACCESS_STREAMING);
                    } catch (FileNotFoundException missingFallback) {
                        // 连 index.html 都没有（CI 没拷前端产物），老实回 404 而不是断连接
                        Log.d(TAG, "404 /" + assetPath + " (missing " + fallback + ")");
                        return notFound(out, keepAlive);
                    }
                    assetPath = fallback;
                    knownLength = -1L;
                }
            }

            writeResource(assetPath, stream, knownLength, headOnly, out, keepAlive);
            return !keepAlive;
        } finally {
            HttpUtil.closeQuietly(stream);
            HttpUtil.closeQuietly(descriptor);
        }
    }

    private static boolean notFound(OutputStream out, boolean keepAlive) throws IOException {
        HttpUtil.sendJson(out, 404, keepAlive, "{\"ok\":false,\"error\":\"not_found\"}");
        return !keepAlive;
    }

    /** 两套来源共用的响应写出：MIME / 缓存策略 / 定长与 chunked 二选一。 */
    private void writeResource(String assetPath, InputStream stream, long knownLength,
            boolean headOnly, OutputStream out, boolean keepAlive) throws IOException {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", mimeType(assetPath));
        headers.put("Cache-Control", cacheControl(assetPath));
        headers.put("Connection", keepAlive ? "keep-alive" : "close");

        // 长度已知就直接给 Content-Length；未知（压缩资源）只能 chunked
        boolean chunked = !headOnly && knownLength < 0L;
        if (knownLength >= 0L) {
            headers.put("Content-Length", String.valueOf(knownLength));
        } else if (headOnly) {
            headers.put("Content-Length", "0");
        }
        if (chunked) {
            headers.put("Transfer-Encoding", "chunked");
        }

        HttpUtil.writeHead(out, 200, null, headers);
        if (headOnly) {
            out.flush();
            return;
        }

        byte[] buffer = new byte[BUFFER_BYTES];
        int read;
        if (chunked) {
            while ((read = stream.read(buffer)) != -1) {
                HttpUtil.writeChunk(out, buffer, 0, read);
            }
            HttpUtil.writeLastChunk(out);
        } else {
            while ((read = stream.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
        out.flush();
    }

    private static String toAssetPath(String path) {
        if (path.isEmpty()) {
            return INDEX;
        }
        if (path.endsWith("/")) {
            return path + INDEX;
        }
        return path;
    }

    /**
     * 前端是单页应用：找不到文件、且最后一段没有扩展名时，回落到 index.html（路由刷新不 404）。
     * 带扩展名的一律 404，避免把缺失的 js/css 悄悄换成 html。
     */
    private static String spaFallback(String assetPath) {
        if (INDEX.equals(assetPath)) {
            return null;
        }
        int slash = assetPath.lastIndexOf('/');
        String lastSegment = slash >= 0 ? assetPath.substring(slash + 1) : assetPath;
        if (lastSegment.isEmpty() || lastSegment.indexOf('.') >= 0) {
            return null;
        }
        return INDEX;
    }

    /** URL 路径 → assets 相对路径；含越权尝试时返回 null。 */
    private static String normalizePath(String rawPath) {
        if (rawPath == null) {
            return null;
        }
        String raw = rawPath;
        int query = raw.indexOf('?');
        if (query >= 0) {
            raw = raw.substring(0, query);
        }
        int fragment = raw.indexOf('#');
        if (fragment >= 0) {
            raw = raw.substring(0, fragment);
        }
        if (raw.isEmpty()) {
            raw = "/";
        }

        String decoded;
        try {
            // 路径里的 '+' 是字面量，不能被解成空格
            decoded = URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException brokenEncoding) {
            return null;
        }
        if (decoded.indexOf('\0') >= 0 || decoded.indexOf('\\') >= 0) {
            return null;
        }

        StringBuilder normalized = new StringBuilder(decoded.length());
        for (String segment : decoded.split("/")) {
            if (segment.isEmpty() || ".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                return null;
            }
            if (normalized.length() > 0) {
                normalized.append('/');
            }
            normalized.append(segment);
        }
        // split 会吃掉结尾斜杠，这里补回来，toAssetPath 才能识别出目录
        if (decoded.endsWith("/") && normalized.length() > 0) {
            normalized.append('/');
        }
        return normalized.toString();
    }

    private static String cacheControl(String assetPath) {
        if (assetPath.startsWith("static/")) {
            // 文件名带 contenthash，可以放心长缓存
            return "public, max-age=31536000, immutable";
        }
        return "no-cache";
    }

    private static String mimeType(String assetPath) {
        int dot = assetPath.lastIndexOf('.');
        if (dot < 0 || dot == assetPath.length() - 1) {
            return "application/octet-stream";
        }
        String extension = assetPath.substring(dot + 1).toLowerCase(Locale.US);
        switch (extension) {
            case "html":
            case "htm":
                return "text/html; charset=utf-8";
            case "js":
            case "mjs":
                return "text/javascript; charset=utf-8";
            case "css":
                return "text/css; charset=utf-8";
            case "json":
            case "map":
                return "application/json; charset=utf-8";
            case "txt":
            case "md":
                return "text/plain; charset=utf-8";
            case "xml":
                return "application/xml; charset=utf-8";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "gif":
                return "image/gif";
            case "webp":
                return "image/webp";
            case "avif":
                return "image/avif";
            case "ico":
                return "image/x-icon";
            case "woff":
                return "font/woff";
            case "woff2":
                return "font/woff2";
            case "ttf":
                return "font/ttf";
            case "otf":
                return "font/otf";
            case "eot":
                return "application/vnd.ms-fontobject";
            case "wasm":
                return "application/wasm";
            case "mp4":
                return "video/mp4";
            case "webm":
                return "video/webm";
            case "mp3":
                return "audio/mpeg";
            case "wav":
                return "audio/wav";
            case "ogg":
                return "audio/ogg";
            case "pdf":
                return "application/pdf";
            case "webmanifest":
                return "application/manifest+json; charset=utf-8";
            default:
                return "application/octet-stream";
        }
    }
}
