package ai.deepseek.tablet;

import android.app.Dialog;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Handler;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Pattern;

/** One DSH Web lease displayed in a WebView with no access to the shell bridges. */
public final class RemoteDshWebView {
    private static final Pattern ROOT =
            Pattern.compile("https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.hostc\\.4ba\\.io/");
    private static final Pattern GRANT = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Pattern OPERATION_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");

    private final MainActivity activity;
    private final WebView shell;
    private final Handler main;
    private Page page;
    private boolean retired;

    RemoteDshWebView(MainActivity activity, WebView shell, Handler main) {
        this.activity = activity;
        this.shell = shell;
        this.main = main;
    }

    @JavascriptInterface
    public void open(String id, String root, String grant, long expiresAt) {
        if (id == null || !OPERATION_ID.matcher(id).matches()) return;
        main.post(() -> {
            if (retired) return;
            if (page != null || activity.isFinishing() || activity.isDestroyed() ||
                    root == null || !ROOT.matcher(root).matches() ||
                    grant == null || !GRANT.matcher(grant).matches() || expiresAt <= System.currentTimeMillis()) {
                report(id, "failed");
                return;
            }
            try {
                page = new Page(id, root, grant);
            } catch (RuntimeException failure) {
                report(id, "failed");
            }
        });
    }

    @JavascriptInterface
    public void close(String id) {
        main.post(() -> {
            if (page != null && page.id.equals(id)) page.dismiss("closed");
        });
    }

    void retire() {
        retired = true;
        if (page != null) page.dismiss("closed");
    }

    private void report(String id, String status) {
        if (retired) return;
        shell.evaluateJavascript("window.dispatchEvent(new CustomEvent('dsh-web-result',{detail:{id:"
                + JSONObject.quote(id) + ",status:" + JSONObject.quote(status) + "}}))", null);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private final class Page {
        private final String id;
        private final Uri origin;
        private final Dialog dialog;
        private final WebView view;
        private final Runnable timeout = () -> dismiss("failed");
        private String status = "closed";
        private boolean closing;

        Page(String id, String root, String grant) {
            this.id = id;
            origin = Uri.parse(root);
            dialog = new Dialog(activity, R.style.remote_web_theme);
            LinearLayout content = new LinearLayout(activity);
            content.setOrientation(LinearLayout.VERTICAL);
            Button close = new Button(activity);
            close.setText(R.string.remote_web_close);
            close.setOnClickListener(button -> dismiss("closed"));
            content.addView(close, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            view = new WebView(activity);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setGeolocationEnabled(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
            view.setWebViewClient(new Client());
            content.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            dialog.setContentView(content);
            dialog.setOnDismissListener(ignored -> {
                main.removeCallbacks(timeout);
                content.removeView(view);
                view.destroy();
                if (page == this) page = null;
                report(id, status);
            });
            dialog.show();
            if (dialog.getWindow() != null) {
                dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            }
            main.postDelayed(timeout, 30_000);
            byte[] body = ("browserGrant=" + grant).getBytes(StandardCharsets.US_ASCII);
            try {
                view.postUrl(root + "__remote/session", body);
            } catch (RuntimeException failure) {
                dismiss("failed");
            } finally {
                Arrays.fill(body, (byte) 0);
            }
        }

        void dismiss(String outcome) {
            if (closing) return;
            closing = true;
            status = outcome;
            main.post(dialog::dismiss);
        }

        boolean allowed(Uri uri) {
            return "https".equals(uri.getScheme()) && origin.getHost().equals(uri.getEncodedAuthority());
        }

        private final class Client extends WebViewClient {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return !allowed(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView webView, String url, Bitmap icon) {
                if (!allowed(Uri.parse(url))) {
                    webView.stopLoading();
                    dismiss("failed");
                }
            }

            @Override
            public void onPageFinished(WebView webView, String url) {
                Uri uri = Uri.parse(url);
                if (allowed(uri) && "/".equals(uri.getPath()) && uri.getQuery() == null) main.removeCallbacks(timeout);
            }

            @Override
            public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) dismiss("failed");
            }

            @Override
            public void onReceivedHttpError(WebView webView, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) dismiss(response.getStatusCode() == 429 ? "busy" : "failed");
            }

            @Override
            public void onReceivedSslError(WebView webView, SslErrorHandler handler, SslError error) {
                handler.cancel();
                dismiss("failed");
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView webView, HttpAuthHandler handler, String host, String realm) {
                handler.cancel();
                dismiss("failed");
            }

            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                dismiss("failed");
                return true;
            }
        }
    }
}
