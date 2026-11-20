package ai.deepseek.tablet;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 网页包（web bundle）的安装与版本管理，分体式更新的核心。
 *
 * <p>网页产物单独打成 zip 发在 Release 里，应用把它解压到 {@code filesDir/web}，
 * {@link AssetHandler} 优先从这里读静态资源。这样换页面不必重装 APK，也不会动到
 * WebView 的本地存储（origin 仍是 127.0.0.1:18888，会话记录与 API Key 都还在）。
 *
 * <p>目录约定：
 * <pre>
 * filesDir/web.staging   解压中的临时目录，必须整套校验通过才切换
 * filesDir/web           当前生效的网页包（只认含 index.html 的完整包）
 * cacheDir/web-update.zip 下载下来的更新包（系统空间紧张时可以被回收）
 * </pre>
 *
 * <p>进程内全部方法都由本地服务器的 worker 线程调用，不涉及 UI 线程。
 */
final class WebBundle {

    private static final String TAG = "DsWebBundle";

    /** 首选项：网页包版本只存这一处，页面通过 /__ds_update/state 读 */
    private static final String PREF_NAME = "ds_web_bundle";
    private static final String KEY_WEB_VERSION = "webVersion";

    /** 生效中的网页包目录名（相对 filesDir） */
    private static final String WEB_DIR = "web";
    /** 解压中的临时目录名；校验通过后整体改名成 WEB_DIR */
    private static final String STAGING_DIR = "web.staging";
    /** 更新包文件名（放 cacheDir） */
    private static final String ZIP_NAME = "web-update.zip";

    private static final String INDEX_FILE = "index.html";
    private static final String VERSION_FILE = "version.json";
    private static final String VERSION_FIELD = "version";

    static final String SOURCE_FILES = "files";
    static final String SOURCE_ASSETS = "assets";

    /** 解压上限：挡住畸形/恶意更新包把存储写满 */
    private static final int MAX_ENTRY_COUNT = 20000;
    private static final long MAX_TOTAL_BYTES = 256L * 1024L * 1024L;
    /** version.json 只该有几十字节，给足余量即可 */
    private static final long MAX_VERSION_BYTES = 64L * 1024L;

    private static final int COPY_BUFFER_BYTES = 32 * 1024;

    private final File cacheDir;
    private final File webRoot;
    private final File stagingRoot;
    private final SharedPreferences preferences;

    WebBundle(Context context) {
        Context application = context.getApplicationContext();
        Context base = application != null ? application : context;
        File filesDir = base.getFilesDir();
        this.cacheDir = base.getCacheDir();
        this.webRoot = new File(filesDir, WEB_DIR);
        this.stagingRoot = new File(filesDir, STAGING_DIR);
        this.preferences = base.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    /**
     * 当前真正可用的网页包根目录。
     *
     * <p>每次请求都现算：apply-web 会把目录整体换掉，缓存住这个结果的话，
     * 用户刷新页面仍然看到旧包。
     *
     * @return 含 index.html 的目录；没有下载过（或包已损坏）时返回 null，调用方回退 assets
     */
    File installedRoot() {
        if (!webRoot.isDirectory()) {
            return null;
        }
        if (!new File(webRoot, INDEX_FILE).isFile()) {
            return null;
        }
        // APK 比已装的网页包新 ⇒ 内置资源才是新的。
        // 典型场景：用户 OTA 过一版网页包，之后覆盖安装了新 APK；
        // 若还从这个旧目录取资源，等于新 APK 里的页面永远不生效
        // （曾经出现过「装了新版 APK 仍然卡在旧页面的 bug」）。
        String installed = readVersion(new File(webRoot, VERSION_FILE));
        if (installed != null && compareVersion(installed, BuildConfig.VERSION_NAME) < 0) {
            Log.i(TAG, "丢弃比 APK 旧的网页包：" + installed + " < " + BuildConfig.VERSION_NAME);
            try {
                deleteRecursively(webRoot);
            } catch (IOException ignored) {
                // 删不掉也不能影响启动：下面照样回退内置资源
                Log.w(TAG, "旧网页包删除失败", ignored);
            }
            clearVersion();
            return null;
        }
        return webRoot;
    }

    /** 语义化版本比较：1.10.0 > 1.9.9；解析不出来的段按 0 处理 */
    private static int compareVersion(String left, String right) {
        String[] a = left.trim().replaceFirst("^[vV]", "").split("[.\\-+]");
        String[] b = right.trim().replaceFirst("^[vV]", "").split("[.\\-+]");
        int length = Math.max(a.length, b.length);
        for (int index = 0; index < length; index++) {
            int x = 0;
            int y = 0;
            try {
                x = index < a.length ? Integer.parseInt(a[index].trim()) : 0;
            } catch (NumberFormatException ignored) {
                x = 0;
            }
            try {
                y = index < b.length ? Integer.parseInt(b[index].trim()) : 0;
            } catch (NumberFormatException ignored) {
                y = 0;
            }
            if (x != y) {
                return x < y ? -1 : 1;
            }
        }
        return 0;
    }

    /** "files" = 在用下载的包；"assets" = 在用 APK 内置的 */
    String source() {
        return installedRoot() != null ? SOURCE_FILES : SOURCE_ASSETS;
    }

    /**
     * 当前生效的网页包版本。
     *
     * <p>以 SharedPreferences 为准；被系统清掉、或上次写入失败时用磁盘上的 version.json 兜底，
     * 免得页面以为"从来没更新过"又重复下载同一个包。
     *
     * @return 版本号；内置资源时返回 null
     */
    String currentVersion() {
        File root = installedRoot();
        if (root == null) {
            // 没有生效的下载包（从没更新过，或包被清掉/损坏）：不该报告任何网页包版本，
            // 否则 state 里会出现 source=assets 但 webVersion 有值的自相矛盾结果
            return null;
        }
        String stored = preferences.getString(KEY_WEB_VERSION, null);
        if (stored != null && !stored.trim().isEmpty()) {
            return stored.trim();
        }
        // 首选项被系统清掉、或上次写入失败：用磁盘上的 version.json 兜底，
        // 免得页面以为"从来没更新过"又重复下载同一个包
        try {
            return readVersion(new File(root, VERSION_FILE));
        } catch (IOException unreadable) {
            Log.w(TAG, "web/version.json 读不出来", unreadable);
            return null;
        }
    }

    /** 下载更新包用的临时文件（每次覆盖写） */
    File updateZipFile() {
        return new File(cacheDir, ZIP_NAME);
    }

    /**
     * 安装一个网页包 zip：解压到 web.staging → 校验 → 替换 web → 记录版本。
     *
     * <p>失败时不会动当前生效的包（除非已经删掉旧包准备改名），并且清掉半成品目录。
     *
     * @return 新包的版本号（来自 version.json）
     */
    String install(File zipFile) throws IOException {
        deleteRecursively(stagingRoot);
        if (!stagingRoot.isDirectory() && !stagingRoot.mkdirs()) {
            throw new IOException("无法创建解压目录 web.staging");
        }
        try {
            unzip(zipFile, stagingRoot);
            if (!new File(stagingRoot, INDEX_FILE).isFile()) {
                throw new IOException("更新包里没有 index.html");
            }
            if (!new File(stagingRoot, VERSION_FILE).isFile()) {
                throw new IOException("更新包里没有 version.json");
            }
            String version = readVersion(new File(stagingRoot, VERSION_FILE));

            // 旧包整目录删掉再把 staging 改名过来：两次 IO 之间页面可能短暂回落到
            // 内置资源，但因为紧接着就重载，实际只会在一次请求里发生
            deleteRecursively(webRoot);
            if (!stagingRoot.renameTo(webRoot)) {
                throw new IOException("网页包切换失败：web.staging 无法改名为 web");
            }
            writeVersion(version);
            Log.i(TAG, "网页包已切换：" + version + " @" + webRoot.getAbsolutePath());
            return version;
        } catch (IOException failed) {
            // 清理半成品；如果旧包已经删掉、新包又没就位，版本号也一起清掉，
            // 避免上报一个磁盘上并不存在的网页包版本
            deleteRecursively(stagingRoot);
            if (installedRoot() == null) {
                clearVersion();
            }
            throw failed;
        }
    }

    /** 解压 zip 到目标目录；全程流式写文件，不把 zip 读进内存。 */
    private static void unzip(File zipFile, File targetRoot) throws IOException {
        byte[] buffer = new byte[COPY_BUFFER_BYTES];
        int entryCount = 0;
        long totalBytes = 0L;
        ZipInputStream zip = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(zipFile), COPY_BUFFER_BYTES));
        try {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = normalizeEntryName(entry.getName());
                if (name.isEmpty()) {
                    // "" 或 "./"：内容本来就落在根目录，没有单独的文件要写
                    continue;
                }
                if (!isSafeEntryName(name)) {
                    throw new IOException("更新包里有非法路径：" + name);
                }
                entryCount++;
                if (entryCount > MAX_ENTRY_COUNT) {
                    throw new IOException("更新包文件数超过上限（" + MAX_ENTRY_COUNT + "）");
                }
                File target = new File(targetRoot, name);
                if (entry.isDirectory()) {
                    if (!target.isDirectory() && !target.mkdirs()) {
                        throw new IOException("无法创建目录：" + name);
                    }
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录：" + name);
                }
                OutputStream sink = new BufferedOutputStream(
                        new FileOutputStream(target), COPY_BUFFER_BYTES);
                try {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        totalBytes += read;
                        if (totalBytes > MAX_TOTAL_BYTES) {
                            throw new IOException("更新包解压后超过大小上限");
                        }
                        sink.write(buffer, 0, read);
                    }
                } finally {
                    HttpUtil.closeQuietly(sink);
                }
                zip.closeEntry();
            }
        } finally {
            HttpUtil.closeQuietly(zip);
        }
    }

    /**
     * 剥掉打包工具可能加的 "./" 前缀，得到包内相对路径。
     *
     * @return 归一化后的名字；空串表示整个包的内容就在根目录
     */
    private static String normalizeEntryName(String raw) {
        if (raw == null) {
            return "";
        }
        String name = raw;
        while (name.startsWith("./")) {
            name = name.substring(2);
        }
        return name;
    }

    /**
     * 防路径穿越：只接受包内相对路径。
     *
     * <p>拒绝 {@code ..}、绝对路径（/ 开头与 C: 这种驱动器写法）、反斜杠。
     * 反斜杠不做归一化而是直接拒绝——归一化过一次就漏掉 {@code ..\..\evil} 的变体。
     */
    private static boolean isSafeEntryName(String name) {
        if (name.isEmpty() || name.indexOf('\0') >= 0) {
            return false;
        }
        if (name.indexOf('\\') >= 0) {
            return false;
        }
        if (name.startsWith("/")) {
            return false;
        }
        if (name.length() >= 2 && name.charAt(1) == ':') {
            return false;
        }
        for (String segment : name.split("/")) {
            if ("..".equals(segment)) {
                return false;
            }
        }
        return true;
    }

    /** 读 version.json 里的 version 字段。 */
    private static String readVersion(File versionFile) throws IOException {
        long length = versionFile.length();
        if (length <= 0L || length > MAX_VERSION_BYTES) {
            throw new IOException("version.json 大小异常：" + length + " 字节");
        }
        byte[] bytes = new byte[(int) length];
        InputStream in = new FileInputStream(versionFile);
        try {
            int offset = 0;
            while (offset < bytes.length) {
                int read = in.read(bytes, offset, bytes.length - offset);
                if (read == -1) {
                    throw new IOException("version.json 读取不完整");
                }
                offset += read;
            }
        } finally {
            HttpUtil.closeQuietly(in);
        }
        String version;
        try {
            version = new JSONObject(new String(bytes, StandardCharsets.UTF_8))
                    .optString(VERSION_FIELD, "").trim();
        } catch (JSONException brokenJson) {
            throw new IOException("version.json 不是合法的 JSON", brokenJson);
        }
        if (version.isEmpty()) {
            throw new IOException("version.json 里没有 version 字段");
        }
        return version;
    }

    private void writeVersion(String version) {
        // 这里已经在后台线程，用 commit 保证返回 done 之后立刻读得到
        boolean saved = preferences.edit().putString(KEY_WEB_VERSION, version).commit();
        if (!saved) {
            // 写失败不算致命：currentVersion() 会回落到磁盘上的 version.json
            Log.w(TAG, "网页包版本写入失败：" + version);
        }
    }

    private void clearVersion() {
        boolean cleared = preferences.edit().remove(KEY_WEB_VERSION).commit();
        if (!cleared) {
            Log.w(TAG, "清除网页包版本失败");
        }
    }

    /** 删除文件或目录（递归）；失败只记日志，不抛异常。 */
    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        if (!file.delete() && file.exists()) {
            Log.w(TAG, "删除失败：" + file.getAbsolutePath());
        }
    }
}
