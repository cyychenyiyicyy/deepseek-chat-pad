package ai.deepseek.tablet;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.FileProvider;

import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * APK 的落盘与安装。
 *
 * <p>下载目录优先用 {@code getExternalFilesDir(null)/update}（外部存储读得到、系统安装器
 * 也能通过 FileProvider 取到），拿不到时退回 {@code cacheDir/update}。
 * 两处都在 {@code res/xml/file_paths.xml} 里登记过，FileProvider 才能生成 content:// URI。
 *
 * <p>下载完成后先写 {@code app.apk.part} 再改名，避免中途失败留下一个看起来"已下载"的坏包。
 */
final class ApkUpdater {

    private static final String TAG = "DsApkUpdater";

    /** 下载目录名（相对 getExternalFilesDir(null) 或 cacheDir） */
    private static final String DIR_NAME = "update";
    private static final String APK_NAME = "app.apk";
    private static final String PART_SUFFIX = ".part";
    /** FileProvider 的 authorities 与清单里保持一致：applicationId + .fileprovider */
    private static final String PROVIDER_SUFFIX = ".fileprovider";

    private static final String MIME_APK = "application/vnd.android.package-archive";

    /** 拉起安装器要回主线程，这里最多等这么久；超时按失败处理，不把请求线程吊死 */
    private static final long INSTALL_TIMEOUT_SECONDS = 5L;

    private final Context context;

    ApkUpdater(Context context) {
        Context application = context.getApplicationContext();
        this.context = application != null ? application : context;
    }

    /** 安装包最终路径（不存在时也该返回这个位置，页面据此展示） */
    File targetFile() {
        return new File(updateDir(), APK_NAME);
    }

    /** 下载中的临时文件 */
    File partFile() {
        return new File(updateDir(), APK_NAME + PART_SUFFIX);
    }

    /**
     * 用系统安装器打开已下载的 APK。
     *
     * @return null 表示已成功拉起；否则是错误码（not_downloaded / no_installer）
     */
    String install() {
        File apk = targetFile();
        if (!apk.isFile() || apk.length() <= 0L) {
            return "not_downloaded";
        }
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(context, context.getPackageName() + PROVIDER_SUFFIX, apk);
        } catch (IllegalArgumentException cannotResolve) {
            // 清单里没注册 provider 或 file_paths 没覆盖这个目录
            Log.w(TAG, "FileProvider 无法为安装包生成 URI", cannotResolve);
            return "no_installer";
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, MIME_APK);
        // 安装器的进程读不到我们的私有目录，必须显式授权
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // 请求来自 HTTP 线程，没有 Activity 上下文，必须新开任务栈
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return startOnMainThread(intent) ? null : "no_installer";
    }

    /** startActivity 有线程亲和性的历史包袱，统一回主线程发，再同步等结果。 */
    private boolean startOnMainThread(Intent intent) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return startQuietly(intent);
        }
        final AtomicBoolean started = new AtomicBoolean(false);
        final CountDownLatch done = new CountDownLatch(1);
        boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
            try {
                started.set(startQuietly(intent));
            } finally {
                done.countDown();
            }
        });
        if (!posted) {
            Log.w(TAG, "主线程 Handler 拒绝投递，无法拉起安装器");
            return false;
        }
        try {
            if (!done.await(INSTALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                Log.w(TAG, "拉起安装器超时");
                return false;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
        return started.get();
    }

    private boolean startQuietly(Intent intent) {
        try {
            context.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException noInstaller) {
            Log.w(TAG, "没有可处理安装 Intent 的应用", noInstaller);
            return false;
        } catch (SecurityException blocked) {
            // 少数 ROM 会拦掉 REQUEST_INSTALL_PACKAGES 之外的安装请求
            Log.w(TAG, "系统拒绝拉起安装器", blocked);
            return false;
        }
    }

    private File updateDir() {
        File base = context.getExternalFilesDir(null);
        if (base == null) {
            base = context.getCacheDir();
        }
        return new File(base, DIR_NAME);
    }
}
