package ai.deepseek.tablet;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * /__ds_update/* 的实现：分体式更新（网页包可单独更新，APK 再更新）。
 *
 * <p>接口一览（与页面同源，直接 fetch 即可，不需要额外权限）：
 * <pre>
 * GET  /__ds_update/state                当前 APP 版本 / 网页包版本 / 资源来源
 * GET  /__ds_update/release              查 GitHub Release，从中挑出 apk 与 web-*.zip
 * POST /__ds_update/apply-web?url=...    下载并切换网页包（SSE 进度）
 * POST /__ds_update/download-apk?url=... 下载 APK（SSE 进度）
 * POST /__ds_update/install-apk          拉起系统安装器
 * </pre>
 *
 * <p>约定：
 * <ul>
 *   <li>全部网络与解压都在本地服务器的 worker 线程里跑，不碰 UI 线程</li>
 *   <li>SSE 每写一条事件就 flush，页面能实时看到百分比</li>
 *   <li>只接受 https:// 的下载地址，避免被页面拿去拉本机/内网明文资源</li>
 *   <li>同一个重活（apply-web / download-apk）同一时间只允许一个，第二个直接 409</li>
 * </ul>
 */
final class UpdateHandler {

    private static final String TAG = "DsUpdate";

    /** 路由前缀，LocalServer 用它把请求交给本类处理 */
    static final String PATH_PREFIX = "/__ds_update/";

    /** 网络状态：当前系统代理与是否走 VPN，用于排查「开了代理连不上」 */
    private static final String PATH_NET = "/__ds_update/net";

    private static final String PATH_STATE = "/__ds_update/state";
    private static final String PATH_RELEASE = "/__ds_update/release";
    private static final String PATH_APPLY_WEB = "/__ds_update/apply-web";
    private static final String PATH_DOWNLOAD_APK = "/__ds_update/download-apk";
    private static final String PATH_INSTALL_APK = "/__ds_update/install-apk";

    private static final String PARAM_URL = "url";

    /**
     * 更新源只有一个出处：换仓库时只改这一行。
     * 页面侧只认接口返回的 URL，不自己拼 GitHub 地址。
     */
    private static final String REPO_SLUG = "cyychenyiyicyy/deepseek-chat-pad";
    private static final String RELEASE_API =
            "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";

    /** GitHub 对没有 User-Agent 的请求直接回 403，这个头不能省 */
    private static final String USER_AGENT = "DeepSeekChatPad/" + BuildConfig.VERSION_NAME;
    private static final String ACCEPT_GITHUB = "application/vnd.github+json";
    private static final String GITHUB_API_VERSION = "2022-11-28";

    /**
     * 备用通道：release 里随包发布的 latest.json，走 github.com 的稳定别名
     * （/releases/latest/download/xxx 永远指向最新一版的资产）。
     *
     * 为什么需要它：api.github.com 按 IP 限 60 次/小时，开着 VPN 时出口是共享 IP，
     * 很容易被限流；一旦失败，旧逻辑会把「查不到」当成「没有新版本」。
     * 这个地址不限流、不需要认证，只是多一次请求。
     */
    private static final String RELEASE_FALLBACK =
            "https://github.com/" + REPO_SLUG + "/releases/latest/download/latest.json";

    /** release notes 只截前 500 字，整篇 body 可能有几千字 */
    private static final int NOTES_LIMIT = 500;

    /** 查 release 是轻请求，单独设个短超时（共享的 OkHttpClient 关掉了读超时） */
    private static final int API_TIMEOUT_SECONDS = 30;
    /** 大包下载给足时间；用户中断（关页面）时靠 activeCalls 取消 + 写失败退出 */
    private static final int DOWNLOAD_TIMEOUT_SECONDS = 30 * 60;

    private static final int DOWNLOAD_BUFFER_BYTES = 32 * 1024;

    private static final String EVENT_UNZIP = "{\"phase\":\"unzip\"}";

    private final OkHttpClient client;
    private final WebBundle webBundle;
    private final ApkUpdater apkUpdater;

    private final Set<Call> activeCalls =
            Collections.newSetFromMap(new ConcurrentHashMap<Call, Boolean>());

    /** 网页包安装与 APK 下载各自只允许一个在跑 */
    private final AtomicBoolean webInstallRunning = new AtomicBoolean(false);
    private final AtomicBoolean apkDownloadRunning = new AtomicBoolean(false);

    private final Context context;

    UpdateHandler(Context context, OkHttpClient client, WebBundle webBundle, ApkUpdater apkUpdater) {
        this.context = context.getApplicationContext() != null
                ? context.getApplicationContext() : context;
        this.client = client;
        this.webBundle = webBundle;
        this.apkUpdater = apkUpdater;
    }

    /** 服务停止时调用，取消还在下载的请求。 */
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
     * @param target 原始请求目标（含查询串，apply-web / download-apk 要从里面取 url）
     * @param path   已经剥掉查询串的路径
     * @return true 表示这条连接必须关闭（SSE 流与请求体未消费的情况）
     */
    boolean handle(String method, String target, String path, HttpUtil.Headers headers,
            OutputStream out, boolean keepAlive) throws IOException {
        // 请求体没消费掉就不能复用连接，否则残留字节会被当成下一个请求
        boolean canKeepAlive = keepAlive && !hasRequestBody(headers);

        if (PATH_NET.equals(path)) {
            if (!isReadOnly(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            serveNet("HEAD".equals(method), out, canKeepAlive);
            return !canKeepAlive;
        }

        if (PATH_STATE.equals(path)) {
            if (!isReadOnly(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            serveState("HEAD".equals(method), out, canKeepAlive);
            return !canKeepAlive;
        }

        if (PATH_RELEASE.equals(path)) {
            if (!isReadOnly(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            serveRelease("HEAD".equals(method), out, canKeepAlive);
            return !canKeepAlive;
        }

        if (PATH_APPLY_WEB.equals(path)) {
            if (!"POST".equals(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            return applyWeb(target, out, canKeepAlive);
        }

        if (PATH_DOWNLOAD_APK.equals(path)) {
            if (!"POST".equals(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            return downloadApk(target, out, canKeepAlive);
        }

        if (PATH_INSTALL_APK.equals(path)) {
            if (!"POST".equals(method)) {
                HttpUtil.sendJson(out, 405, canKeepAlive, errorJson("method_not_allowed"));
                return !canKeepAlive;
            }
            installApk(out, canKeepAlive);
            return !canKeepAlive;
        }

        HttpUtil.sendJson(out, 404, canKeepAlive, errorJson("not_found"));
        return !canKeepAlive;
    }

    // ---------------------------------------------------------------- 1. 状态

    /**
     * 网络状态。
     *
     * OkHttp 默认使用 {@link ProxySelector#getDefault()}，也就是「系统代理」——
     * 无论代理是 Wi-Fi 高级设置里配的，还是代理类应用写入的系统代理，都会自动生效；
     * VPN 的 TUN 模式更是整个网络层透明转发。这里把实际生效的结果报给页面，
     * 方便用户在「检查更新失败」时确认代理到底有没有被用上。
     */
    private void serveNet(boolean headOnly, OutputStream out, boolean keepAlive)
            throws IOException {
        String proxy = currentProxy();
        String json = "{\"ok\":true,\"proxy\":" + (proxy == null ? "null" : JSONObject.quote(proxy))
                + ",\"vpn\":" + isVpnActive() + "}";
        HttpUtil.sendJson(out, 200, keepAlive, json, headOnly);
    }

    /** 取当前生效的代理（形如 http://127.0.0.1:7890）；直连返回 null */
    private String currentProxy() {
        try {
            ProxySelector selector = ProxySelector.getDefault();
            if (selector == null) {
                return null;
            }
            List<Proxy> proxies = selector.select(new URI("https://api.github.com"));
            for (Proxy proxy : proxies) {
                if (proxy == null || proxy.type() == Proxy.Type.DIRECT) {
                    continue;
                }
                if (!(proxy.address() instanceof InetSocketAddress)) {
                    continue;
                }
                InetSocketAddress address = (InetSocketAddress) proxy.address();
                if (address.isUnresolved() && address.getHostString() == null) {
                    continue;
                }
                return proxy.type().name().toLowerCase(Locale.US) + "://"
                        + address.getHostString() + ":" + address.getPort();
            }
        } catch (Exception ignored) {
            // 取不到就当没有代理
        }
        return null;
    }

    /** 当前活动网络是不是 VPN（代理类应用的 TUN 模式走这个） */
    private boolean isVpnActive() {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) {
                return false;
            }
            NetworkCapabilities capabilities =
                    manager.getNetworkCapabilities(manager.getActiveNetwork());
            return capabilities != null
                    && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private void serveState(boolean headOnly, OutputStream out, boolean keepAlive)
            throws IOException {
        String webVersion = webBundle.currentVersion();
        String json = "{\"ok\":true,\"appVersion\":" + JSONObject.quote(BuildConfig.VERSION_NAME)
                + ",\"webVersion\":" + (webVersion == null ? "null" : JSONObject.quote(webVersion))
                + ",\"source\":" + JSONObject.quote(webBundle.source()) + "}";
        HttpUtil.sendJson(out, 200, keepAlive, json, headOnly);
    }

    // ---------------------------------------------------------------- 2. 查 release

    private void serveRelease(boolean headOnly, OutputStream out, boolean keepAlive)
            throws IOException {
        Release release = null;
        String failure = null;
        try {
            release = fetchRelease();
        } catch (IOException network) {
            failure = describe(network);
            Log.w(TAG, "查询 release 失败，尝试备用通道", network);
        }
        if (release == null) {
            // API 不可用（限流 / 被拦 / 网络问题）时改用 release 里的 latest.json
            try {
                release = fetchFallback();
                if (release != null) {
                    Log.i(TAG, "已通过 latest.json 取到版本 " + release.version);
                }
            } catch (IOException fallbackFailed) {
                if (failure == null) {
                    failure = describe(fallbackFailed);
                }
                Log.w(TAG, "备用通道也失败", fallbackFailed);
            }
        }
        if (release == null && failure != null) {
            // 两个通道都失败：如实说原因，不要伪装成「没有新版本」
            HttpUtil.sendJson(out, 502, keepAlive,
                    errorJson("无法访问 GitHub：" + failure), headOnly);
            return;
        }
        if (release == null) {
            // 仓库还没发过 release：不是错误，页面据此提示"暂时没有新版本"
            HttpUtil.sendJson(out, 200, keepAlive, errorJson("no_release"), headOnly);
            return;
        }
        String json = "{\"ok\":true,\"tag\":" + quoteOrNull(release.tag)
                + ",\"version\":" + quoteOrNull(release.version)
                + ",\"apkUrl\":" + quoteOrNull(release.apkUrl)
                + ",\"apkSize\":" + release.apkSize
                + ",\"webUrl\":" + quoteOrNull(release.webUrl)
                + ",\"webSize\":" + release.webSize
                + ",\"notes\":" + JSONObject.quote(release.notes) + "}";
        HttpUtil.sendJson(out, 200, keepAlive, json, headOnly);
    }

    /** @return 解析结果；仓库没有 release 时返回 null */
    private Release fetchRelease() throws IOException {
        Request request = new Request.Builder()
                .url(RELEASE_API)
                .header("User-Agent", USER_AGENT)
                .header("Accept", ACCEPT_GITHUB)
                .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
                .get()
                .build();
        Call call = client.newCall(request);
        // 共享的 OkHttpClient 是长连接配置，这里按调用单独设超时
        call.timeout().timeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activeCalls.add(call);
        try {
            Response response = call.execute();
            try {
                if (response.code() == 404) {
                    return null;
                }
                if (!response.isSuccessful()) {
                    throw new IOException("GitHub 返回 HTTP " + response.code());
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new IOException("GitHub 响应体为空");
                }
                try {
                    return parseRelease(new JSONObject(body.string()));
                } catch (JSONException brokenJson) {
                    throw new IOException("GitHub 返回的 JSON 无法解析", brokenJson);
                }
            } finally {
                response.close();
            }
        } catch (IOException failed) {
            Log.d(TAG, "release 请求中断: " + failed.getMessage());
            throw failed;
        } catch (RuntimeException unexpected) {
            throw new IOException("查询 release 出错：" + describe(unexpected), unexpected);
        } finally {
            activeCalls.remove(call);
        }
    }

    /** 备用通道：读 release 资产里的 latest.json */
    private Release fetchFallback() throws IOException {
        Request request = new Request.Builder()
                .url(RELEASE_FALLBACK)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .header("Cache-Control", "no-cache")
                .get()
                .build();
        Call call = client.newCall(request);
        call.timeout().timeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activeCalls.add(call);
        try {
            Response response = call.execute();
            try {
                if (response.code() == 404) {
                    return null;
                }
                if (!response.isSuccessful()) {
                    throw new IOException("latest.json 返回 HTTP " + response.code());
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new IOException("latest.json 响应体为空");
                }
                try {
                    return parseLatestJson(new JSONObject(body.string()));
                } catch (JSONException brokenJson) {
                    throw new IOException("latest.json 无法解析", brokenJson);
                }
            } finally {
                response.close();
            }
        } finally {
            activeCalls.remove(call);
        }
    }

    /** latest.json 的形状由 CI 生成：version / apkUrl / webUrl / notes 都是扁平字段 */
    private static Release parseLatestJson(JSONObject root) throws JSONException {
        Release release = new Release();
        release.version = root.optString("version", "").trim();
        release.tag = root.optString("tag", release.version.isEmpty() ? "" : "v" + release.version);
        if (release.version.isEmpty()) {
            return null;
        }
        String apk = root.optString("apkUrl", "").trim();
        if (!apk.isEmpty()) {
            release.apkUrl = apk;
            release.apkSize = root.optLong("apkSize", 0L);
        }
        String web = root.optString("webUrl", "").trim();
        if (!web.isEmpty()) {
            release.webUrl = web;
            release.webSize = root.optLong("webSize", 0L);
        }
        String notes = root.optString("notes", "");
        release.notes = notes.length() > NOTES_LIMIT ? notes.substring(0, NOTES_LIMIT) : notes;
        return release;
    }

    /** 从 release JSON 里挑出 apk 与 web-*.zip；两个都缺也算成功（只是没东西可更）。 */
    private static Release parseRelease(JSONObject root) throws JSONException {
        Release release = new Release();
        String tag = root.optString("tag_name", "").trim();
        if (!tag.isEmpty()) {
            release.tag = tag;
            release.version = stripTagPrefix(tag);
        }
        String notes = root.optString("body", "");
        release.notes = notes.length() > NOTES_LIMIT ? notes.substring(0, NOTES_LIMIT) : notes;

        JSONArray assets = root.optJSONArray("assets");
        if (assets != null) {
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.optJSONObject(index);
                if (asset == null) {
                    continue;
                }
                String url = asset.optString("browser_download_url", "").trim();
                if (url.isEmpty()) {
                    continue;
                }
                String name = asset.optString("name", "").trim().toLowerCase(Locale.US);
                long size = asset.optLong("size", 0L);
                if (release.apkUrl == null && name.endsWith(".apk")) {
                    release.apkUrl = url;
                    release.apkSize = size;
                } else if (release.webUrl == null && name.startsWith("web-")
                        && name.endsWith(".zip")) {
                    release.webUrl = url;
                    release.webSize = size;
                }
            }
        }
        return release;
    }

    /** v1.6.0 → 1.6.0；没有 v 前缀就原样返回 */
    private static String stripTagPrefix(String tag) {
        if (tag == null) {
            return null;
        }
        String value = tag.trim();
        if ((value.startsWith("v") || value.startsWith("V")) && value.length() > 1) {
            return value.substring(1);
        }
        return value;
    }

    // ---------------------------------------------------------------- 3. 更新网页包

    private boolean applyWeb(String rawTarget, OutputStream out, boolean canKeepAlive)
            throws IOException {
        if (!webInstallRunning.compareAndSet(false, true)) {
            HttpUtil.sendJson(out, 409, canKeepAlive,
                    errorJson("busy", "正在更新网页包，请稍候再试"));
            return !canKeepAlive;
        }
        try {
            HttpUrl url = parseDownloadUrl(queryParam(rawTarget, PARAM_URL));
            if (url == null) {
                HttpUtil.sendJson(out, 400, canKeepAlive,
                        errorJson("https_required", "只允许 https:// 的下载地址"));
                return !canKeepAlive;
            }
            // 校验通过才开始流式响应：之后的所有结果都用 SSE 事件汇报
            startEventStream(out);
            String phase = "下载";
            try {
                writeEvent(out, eventProgress(0));
                File zip = webBundle.updateZipFile();
                WebBundle.deleteRecursively(zip);
                long size = download(url, zip, percent -> writeEvent(out, eventProgress(percent)));
                if (size <= 0L) {
                    throw new IOException("下载到的更新包是空文件");
                }
                phase = "解压";
                writeEvent(out, EVENT_UNZIP);
                String version = webBundle.install(zip);
                WebBundle.deleteRecursively(zip);
                writeEvent(out, "{\"phase\":\"done\",\"webVersion\":" + quoteOrNull(version) + "}");
                return true;
            } catch (IOException failed) {
                Log.w(TAG, "网页包更新失败", failed);
                writeEvent(out, eventError(phase + "失败：" + describe(failed)));
                return true;
            } finally {
                endEventStream(out);
            }
        } finally {
            webInstallRunning.set(false);
        }
    }

    // ---------------------------------------------------------------- 4. 下载 APK

    private boolean downloadApk(String rawTarget, OutputStream out, boolean canKeepAlive)
            throws IOException {
        if (!apkDownloadRunning.compareAndSet(false, true)) {
            HttpUtil.sendJson(out, 409, canKeepAlive,
                    errorJson("busy", "正在下载安装包，请稍候再试"));
            return !canKeepAlive;
        }
        try {
            HttpUrl url = parseDownloadUrl(queryParam(rawTarget, PARAM_URL));
            if (url == null) {
                HttpUtil.sendJson(out, 400, canKeepAlive,
                        errorJson("https_required", "只允许 https:// 的下载地址"));
                return !canKeepAlive;
            }
            startEventStream(out);
            try {
                writeEvent(out, eventProgress(0));
                File apk = apkUpdater.targetFile();
                File part = apkUpdater.partFile();
                WebBundle.deleteRecursively(part);
                long size = download(url, part, percent -> writeEvent(out, eventProgress(percent)));
                if (size <= 0L) {
                    throw new IOException("下载到的安装包是空文件");
                }
                if (!part.renameTo(apk)) {
                    // 目标位置可能残留上一次的包，删掉再改名
                    WebBundle.deleteRecursively(apk);
                    if (!part.renameTo(apk)) {
                        throw new IOException("安装包改名失败：" + part.getName());
                    }
                }
                writeEvent(out, "{\"phase\":\"done\",\"path\":" + quoteOrNull(apk.getAbsolutePath())
                        + ",\"size\":" + size + "}");
                return true;
            } catch (IOException failed) {
                Log.w(TAG, "安装包下载失败", failed);
                writeEvent(out, eventError("下载失败：" + describe(failed)));
                return true;
            } finally {
                endEventStream(out);
            }
        } finally {
            apkDownloadRunning.set(false);
        }
    }

    // ---------------------------------------------------------------- 5. 安装 APK

    private void installApk(OutputStream out, boolean keepAlive) throws IOException {
        String error = apkUpdater.install();
        if (error == null) {
            HttpUtil.sendJson(out, 200, keepAlive, "{\"ok\":true}");
            return;
        }
        HttpUtil.sendJson(out, 200, keepAlive, errorJson(error));
    }

    // ---------------------------------------------------------------- 下载与 SSE 基础设施

    /** 单次下载：边收边写盘，按字节数算百分比，不把包读进内存。 */
    private long download(HttpUrl url, File destination, ProgressListener listener)
            throws IOException {
        File parent = destination.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建下载目录");
        }
        Request request = new Request.Builder()
                .url(url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/octet-stream")
                .get()
                .build();
        Call call = client.newCall(request);
        // 共享的 OkHttpClient 把读超时关掉了（为 SSE 留的），下载按调用单独设上限
        call.timeout().timeout(DOWNLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activeCalls.add(call);
        try {
            Response response;
            try {
                response = call.execute();
            } catch (IOException network) {
                throw new IOException("网络请求出错：" + describe(network), network);
            }
            try {
                if (!response.isSuccessful()) {
                    throw new IOException("服务器返回 HTTP " + response.code());
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new IOException("响应体为空");
                }
                long total = body.contentLength();
                long downloaded = 0L;
                int lastPercent = -1;
                byte[] buffer = new byte[DOWNLOAD_BUFFER_BYTES];
                InputStream source = body.byteStream();
                OutputStream sink = new BufferedOutputStream(
                        new FileOutputStream(destination), DOWNLOAD_BUFFER_BYTES);
                try {
                    int read;
                    while ((read = source.read(buffer)) > 0) {
                        sink.write(buffer, 0, read);
                        downloaded += read;
                        if (listener != null) {
                            int percent = total > 0L
                                    ? (int) Math.min(100L, downloaded * 100L / total) : 0;
                            if (percent != lastPercent) {
                                listener.onProgress(percent);
                                lastPercent = percent;
                            }
                        }
                    }
                    sink.flush();
                } finally {
                    HttpUtil.closeQuietly(sink);
                }
                if (listener != null && lastPercent != 100) {
                    listener.onProgress(100);
                }
                if (total > 0L && downloaded != total) {
                    throw new IOException("下载不完整：" + downloaded + "/" + total + " 字节");
                }
                return downloaded;
            } finally {
                response.close();
            }
        } finally {
            activeCalls.remove(call);
        }
    }

    /** 打开一条 SSE 流（chunked，逐条 flush）。 */
    private static void startEventStream(OutputStream out) throws IOException {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "text/event-stream; charset=utf-8");
        headers.put("Cache-Control", "no-cache");
        // 中间层（含 WebView 内核的缓冲）看到这个头会少一层攒批
        headers.put("X-Accel-Buffering", "no");
        headers.put("Transfer-Encoding", "chunked");
        // SSE 是一次性长响应，发完就关，不复用连接
        headers.put("Connection", "close");
        HttpUtil.writeHead(out, 200, null, headers);
        out.flush();
    }

    /** 写一条 SSE 事件并立即 flush，页面才能实时看到进度。 */
    private static void writeEvent(OutputStream out, String payload) throws IOException {
        byte[] bytes = ("data: " + payload + "\n\n").getBytes(StandardCharsets.UTF_8);
        HttpUtil.writeChunk(out, bytes, 0, bytes.length);
        out.flush();
    }

    /** 收尾：写 chunked 结束块，连接随后由 LocalServer 关闭。 */
    private static void endEventStream(OutputStream out) throws IOException {
        HttpUtil.writeLastChunk(out);
        out.flush();
    }

    private static String eventProgress(int percent) {
        int bounded = Math.max(0, Math.min(100, percent));
        return "{\"phase\":\"download\",\"percent\":" + bounded + "}";
    }

    private static String eventError(String message) {
        return "{\"phase\":\"error\",\"message\":" + JSONObject.quote(message) + "}";
    }

    // ---------------------------------------------------------------- 小工具

    /** 只接受 https:// 的下载地址；返回 null 表示不合法。 */
    private static HttpUrl parseDownloadUrl(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.trim();
        if (!value.toLowerCase(Locale.US).startsWith("https://")) {
            return null;
        }
        try {
            return HttpUrl.get(value);
        } catch (IllegalArgumentException brokenUrl) {
            return null;
        }
    }

    /** 从请求目标里取查询参数（已做 URL 解码）。 */
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
            if (!name.equals(decode(key))) {
                continue;
            }
            // 键名对得上就直接返回，值缺省按空串处理
            return equals >= 0 ? decode(pair.substring(equals + 1)) : "";
        }
        return null;
    }

    private static String decode(String raw) {
        try {
            // 查询串里的 '+' 是空格的转义，与路径段不同，这里按标准解码
            return URLDecoder.decode(raw, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException brokenEncoding) {
            return null;
        }
    }

    private static boolean hasRequestBody(HttpUtil.Headers headers) {
        String transferEncoding = headers.get("Transfer-Encoding");
        if (transferEncoding != null
                && transferEncoding.toLowerCase(Locale.US).contains("chunked")) {
            return true;
        }
        String contentLength = headers.get("Content-Length");
        if (contentLength == null) {
            return false;
        }
        try {
            return Long.parseLong(contentLength.trim()) > 0L;
        } catch (NumberFormatException unparsable) {
            // 声明了长度但解析不出来，保守按"有请求体"处理，宁可关连接
            return true;
        }
    }

    private static boolean isReadOnly(String method) {
        return "GET".equals(method) || "HEAD".equals(method);
    }

    private static String errorJson(String error) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(error) + "}";
    }

    private static String errorJson(String error, String message) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(error)
                + ",\"message\":" + JSONObject.quote(message) + "}";
    }

    private static String quoteOrNull(String value) {
        return value == null ? "null" : JSONObject.quote(value);
    }

    private static String describe(Throwable error) {
        if (error == null) {
            return "未知错误";
        }
        String message = error.getMessage();
        if (message != null && !message.trim().isEmpty()) {
            return message.trim();
        }
        return error.getClass().getSimpleName();
    }

    /** 下载进度回调；抛 IOException 表示页面已断开（刷新/切走），下载应立刻放弃。 */
    private interface ProgressListener {
        void onProgress(int percent) throws IOException;
    }

    /** release 解析结果 */
    private static final class Release {
        String tag;
        String version;
        String apkUrl;
        long apkSize;
        String webUrl;
        long webSize;
        String notes = "";
    }
}
