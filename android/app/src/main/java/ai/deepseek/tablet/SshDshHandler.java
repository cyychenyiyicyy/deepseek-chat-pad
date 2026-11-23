package ai.deepseek.tablet;

import android.content.Context;
import android.util.Base64;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UserInfo;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Authenticated HTTP to a DSH Web listener reached through pinned SSH. */
final class SshDshHandler {
    static final String PREFIX = "/__ds_ssh/";
    private static final String LOOPBACK = "127.0.0.1";
    private static final String MUX_PATH = "/api/remote.mux";
    private static final Pattern ID = Pattern.compile("[a-f0-9]{32}");
    private static final Pattern FINGERPRINT = Pattern.compile("SHA256:[A-Za-z0-9+/]{43}");
    private static final Pattern RPC = Pattern.compile("/api/([A-Za-z0-9_$.-]+/)*[A-Za-z0-9_$.-]+");
    private static final Pattern MANAGED_URL = Pattern.compile("http://127\\.0\\.0\\.1:([0-9]{1,5})/\\?token=([^\\s&#]+)");
    private static final Pattern PLUGIN_CONFIG = Pattern.compile("/dsh-go/v1/plugin-config(?:/[A-Za-z0-9_.!~*'()%+-]+)?");
    private static final int MAX_REQUEST_BYTES = 12 * 1024 * 1024;
    private static final long MAX_RESPONSE_BYTES = 64L * 1024 * 1024;
    private static final okhttp3.MediaType JSON = okhttp3.MediaType.get("application/json");
    private final OkHttpClient http = new OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .proxy(Proxy.NO_PROXY).build();
    private Connection current;
    private final SshCredentialStore credentials;

    SshDshHandler(Context context) {
        credentials = new SshCredentialStore(context);
    }

    boolean handle(String method, String path, int originPort, HttpUtil.Headers headers, InputStream in, OutputStream out)
            throws IOException {
        if ((PREFIX + "health.json").equals(path) && "GET".equals(method)) {
            HttpUtil.sendJson(out, 200, false, "{\"ok\":true,\"version\":1}");
            return true;
        }
        if (!"POST".equals(method) || !sameOrigin(headers, originPort)) return error(out, 403, "FORBIDDEN");
        if ((PREFIX + "forget").equals(path)) {
            try {
                JSONObject config = new JSONObject(new String(body(headers, in, 2048), StandardCharsets.UTF_8));
                credentials.forget(credentialIdentity(config));
                HttpUtil.sendJson(out, 200, false, "{\"ok\":true}");
                return true;
            } catch (JSONException | IllegalArgumentException invalid) {
                return error(out, 400, "INVALID_SSH_REQUEST");
            } catch (BridgeFailure invalid) {
                return error(out, invalid.status, invalid.getMessage());
            } catch (GeneralSecurityException | IOException | IllegalStateException failed) {
                return error(out, 500, "SSH_CREDENTIAL_STORAGE_FAILED");
            }
        }
        String id = headers.get("X-Ds-Ssh-Id");
        if (id == null || !ID.matcher(id).matches()) return error(out, 400, "INVALID_SSH_REQUEST");
        if ((PREFIX + "close").equals(path)) {
            close(id);
            HttpUtil.sendJson(out, 200, false, "{\"ok\":true}");
            return true;
        }
        if ((PREFIX + "open").equals(path)) return open(id, headers, in, out);
        if ((PREFIX + "request").equals(path)) return relay(id, headers, in, out);
        return error(out, 404, "METHOD_NOT_ALLOWED");
    }

    static boolean sameOrigin(HttpUtil.Headers headers, int port) {
        return ("http://" + LOOPBACK + ":" + port).equals(headers.get("Origin"));
    }

    private boolean open(String id, HttpUtil.Headers headers, InputStream in, OutputStream out) throws IOException {
        Connection connection;
        try {
            JSONObject config = new JSONObject(new String(body(headers, in, 36 * 1024), StandardCharsets.UTF_8));
            String identity = credentialIdentity(config);
            if (config.optBoolean("useSavedCredentials")) {
                try {
                    credentials.fill(identity, config);
                } catch (GeneralSecurityException | IOException | JSONException | RuntimeException failed) {
                    return error(out, 409, "SSH_CREDENTIAL_STORAGE_FAILED");
                }
            }
            connection = reserve(id, config);
            connection.establish(config);
            if (config.optBoolean("rememberCredentials") && !config.optBoolean("useSavedCredentials")) {
                try {
                    saveIfCurrent(connection, identity, config);
                } catch (GeneralSecurityException | IOException | JSONException | RuntimeException failed) {
                    close(id);
                    return error(out, 500, "SSH_CREDENTIAL_STORAGE_FAILED");
                }
            }
        } catch (JSONException | IllegalArgumentException invalid) {
            close(id);
            return error(out, 400, "INVALID_SSH_REQUEST");
        } catch (BridgeFailure failed) {
            close(id);
            return error(out, failed.status, failed.getMessage());
        } catch (JSchException | IOException failed) {
            close(id);
            return error(out, 502, "SSH_CONNECT_FAILED");
        }
        try {
            HttpUtil.sendJson(out, 200, false, "{\"ok\":true}");
        } catch (IOException gone) {
            close(connection.id);
            throw gone;
        }
        return true;
    }

    private synchronized void saveIfCurrent(Connection connection, String identity, JSONObject config)
            throws GeneralSecurityException, IOException, JSONException {
        if (current != connection) throw new IOException("Connection closed");
        credentials.save(identity, config);
    }

    private static String credentialIdentity(JSONObject config) {
        String host = config.optString("host").trim();
        String user = config.optString("user").trim();
        String fingerprint = config.optString("fingerprint");
        int port = config.optInt("port");
        String mode = config.optString("mode");
        int remotePort = config.optInt("remotePort");
        if (!host.matches("[A-Za-z0-9._:\\-]{1,253}") || !user.matches("[A-Za-z0-9._@\\-]{1,128}")
                || port < 1 || port > 65535 || !FINGERPRINT.matcher(fingerprint).matches()
                || (!"attach".equals(mode) && !"managed".equals(mode))
                || ("attach".equals(mode) && (remotePort < 1 || remotePort > 65535))) {
            throw new IllegalArgumentException();
        }
        return host + "\n" + port + "\n" + user + "\n" + fingerprint + "\n" + mode + "\n"
                + ("attach".equals(mode) ? remotePort : 0);
    }

    private synchronized Connection reserve(String id, JSONObject config) throws JSchException, BridgeFailure {
        if (current != null && id.equals(current.id)) throw new BridgeFailure(409, "SSH_ALREADY_OPEN");
        JSch jsch = new JSch();
        PinnedKey pin = new PinnedKey(config.optString("fingerprint"));
        jsch.setHostKeyRepository(pin);
        String key = config.optString("privateKey");
        String password = config.optString("password");
        if (key.isEmpty() == password.isEmpty()) throw new IllegalArgumentException();
        if (!key.isEmpty()) {
            byte[] pem = key.getBytes(StandardCharsets.UTF_8);
            byte[] phrase = config.optString("passphrase").getBytes(StandardCharsets.UTF_8);
            try {
                jsch.addIdentity("chatpad", pem, null, phrase.length == 0 ? null : phrase);
            } catch (JSchException invalid) {
                throw new BridgeFailure(400, "SSH_INVALID_KEY");
            } finally {
                Arrays.fill(pem, (byte) 0);
                Arrays.fill(phrase, (byte) 0);
            }
        }
        Session ssh = jsch.getSession(config.optString("user").trim(), config.optString("host").trim(), config.optInt("port"));
        ssh.setConfig("StrictHostKeyChecking", "yes");
        ssh.setConfig("PreferredAuthentications", key.isEmpty() ? "password" : "publickey");
        if (!password.isEmpty()) ssh.setPassword(password);
        ssh.setServerAliveInterval(10_000);
        ssh.setServerAliveCountMax(3);
        closeAll();
        current = new Connection(id, ssh, pin, jsch);
        return current;
    }

    private synchronized Connection lookup(String id) {
        if (current == null || !current.id.equals(id) || current.cookie == null || !current.ssh.isConnected()) return null;
        return current;
    }

    WebSocket openMux(String id, WebSocketListener listener) throws BridgeFailure {
        Connection connection = lookup(id);
        if (connection == null) throw new BridgeFailure(401, "SSH_NOT_CONNECTED");
        synchronized (connection) {
            if (connection.closed || connection.mux != null) throw new BridgeFailure(409, "SSH_MUX_UNAVAILABLE");
            connection.mux = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).pingInterval(12, TimeUnit.SECONDS)
                    .build().newWebSocket(connection.request(MUX_PATH).build(), listener);
            return connection.mux;
        }
    }

    private boolean relay(String id, HttpUtil.Headers headers, InputStream in, OutputStream out) throws IOException {
        Connection connection = lookup(id);
        if (connection == null) return error(out, 401, "SSH_NOT_CONNECTED");
        String method = headers.get("X-Ds-Host-Method");
        String path = headers.get("X-Ds-Host-Path");
        if (!allowedPath(method, path)) return error(out, 403, "METHOD_NOT_ALLOWED");
        Request.Builder request = connection.request(path);
        if ("POST".equals(method)) {
            try {
                request.post(RequestBody.create(body(headers, in, MAX_REQUEST_BYTES), JSON));
            } catch (BridgeFailure invalid) {
                return error(out, invalid.status, invalid.getMessage());
            }
        }
        try (Response response = http.newBuilder().callTimeout(5, TimeUnit.MINUTES).build().newCall(request.build()).execute()) {
            return sendHostResponse(out, response, path.startsWith("/api/session.export?"));
        }
    }

    private static boolean allowedPath(String method, String path) {
        if (path == null || path.length() > 1024 || path.contains("\\") || path.contains("#")) return false;
        if ("GET".equals(method)) {
            return "/dsh-go/v1/sessions/deletion".equals(path)
                    || PLUGIN_CONFIG.matcher(path).matches()
                    || path.matches("/api/session\\.export\\?sessionId=[0-9A-Za-z_.~%+-]+&includeDescendants=true");
        }
        if (!"POST".equals(method)) return false;
        if ("/dsh-go/v1/sessions/delete".equals(path) || PLUGIN_CONFIG.matcher(path).matches()) return true;
        if (!RPC.matcher(path).matches()) return false;
        for (String segment : path.split("/")) if (segment.equals(".") || segment.equals("..")) return false;
        return true;
    }

    private static boolean sendHostResponse(OutputStream out, Response response, boolean export) throws IOException {
        ResponseBody body = response.body();
        long limit = export ? 256L * 1024 * 1024 : MAX_RESPONSE_BYTES;
        if (body != null && body.contentLength() > limit) return error(out, 413, "FRAME_TOO_LARGE");
        String contentType = response.header("Content-Type", "application/octet-stream");
        if (!contentType.matches("(?i)(application/(json|octet-stream|zip)|multipart/form-data)(;[^\\r\\n]*)?")) {
            contentType = "application/octet-stream";
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", contentType);
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Cache-Control", "no-store");
        headers.put("Connection", "close");
        if (body == null || response.code() == 204 || response.code() == 304) {
            headers.put("Content-Length", "0");
            HttpUtil.writeHead(out, response.code(), null, headers);
            out.flush();
            return true;
        }
        headers.put("Transfer-Encoding", "chunked");
        HttpUtil.writeHead(out, response.code(), null, headers);
        byte[] chunk = new byte[32 * 1024];
        long received = 0;
        try (InputStream stream = body.byteStream()) {
            int read;
            while ((read = stream.read(chunk)) != -1) {
                received += read;
                if (received > limit) return true;
                HttpUtil.writeChunk(out, chunk, 0, read);
                out.flush();
            }
        }
        HttpUtil.writeLastChunk(out);
        out.flush();
        return true;
    }

    synchronized void close(String id) {
        if (current != null && current.id.equals(id)) closeAll();
    }

    synchronized void closeAll() {
        Connection old = current;
        current = null;
        if (old != null) old.close();
    }

    private static byte[] body(HttpUtil.Headers headers, InputStream in, int max) throws IOException, BridgeFailure {
        String length = headers.get("Content-Length");
        if (headers.get("Transfer-Encoding") != null) throw new BridgeFailure(400, "INVALID_SSH_REQUEST");
        int size;
        try {
            size = length == null ? 0 : Integer.parseInt(length);
        } catch (NumberFormatException invalid) {
            throw new BridgeFailure(400, "INVALID_SSH_REQUEST");
        }
        if (size < 0 || size > max) throw new BridgeFailure(413, "FRAME_TOO_LARGE");
        byte[] contents = new byte[size];
        for (int offset = 0; offset < size;) {
            int read = in.read(contents, offset, size - offset);
            if (read == -1) throw new IOException("Truncated request");
            offset += read;
        }
        return contents;
    }

    private static boolean error(OutputStream out, int status, String code) throws IOException {
        HttpUtil.sendJson(out, status, false, "{\"ok\":false,\"code\":" + JSONObject.quote(code) + "}");
        return true;
    }

    private final class Connection {
        final String id;
        final Session ssh;
        final PinnedKey pin;
        final JSch jsch;
        volatile boolean closed;
        volatile String cookie;
        int localPort;
        int remotePort;
        ChannelExec managed;
        WebSocket mux;

        Connection(String id, Session ssh, PinnedKey pin, JSch jsch) {
            this.id = id;
            this.ssh = ssh;
            this.pin = pin;
            this.jsch = jsch;
        }

        void establish(JSONObject config) throws JSchException, IOException, BridgeFailure {
            try {
                ssh.connect(12_000);
            } catch (JSchException failed) {
                if (pin.mismatch) throw new BridgeFailure(403, "PEER_IDENTITY_MISMATCH");
                String message = failed.getMessage();
                if (message != null && message.startsWith("Auth fail")) throw new BridgeFailure(401, "SSH_AUTH_FAILED");
                throw failed;
            } finally {
                jsch.removeAllIdentity();
            }
            if (closed) {
                ssh.disconnect();
                throw new BridgeFailure(409, "SSH_CONNECTION_CLOSED");
            }
            String token = config.optString("launchToken").trim();
            remotePort = config.optInt("remotePort");
            if ("managed".equals(config.optString("mode"))) {
                String url = launch();
                HttpUrl launch = HttpUrl.parse(url);
                if (launch == null) throw new BridgeFailure(502, "SSH_DSH_START_FAILED");
                remotePort = launch.port();
                token = launch.queryParameter("token");
            }
            if (remotePort < 1 || remotePort > 65535 || token == null || token.isEmpty() || token.length() > 2048) {
                throw new BridgeFailure(400, "INVALID_SSH_REQUEST");
            }
            localPort = ssh.setPortForwardingL(LOOPBACK, 0, LOOPBACK, remotePort);
            HttpUrl loginUrl = HttpUrl.get("http://" + LOOPBACK + ":" + localPort + "/").newBuilder()
                    .addQueryParameter("token", token).build();
            Request login = request("/").url(loginUrl).build();
            try (Response result = http.newCall(login).execute()) {
                if (result.code() != 303 && result.code() != 302) throw new BridgeFailure(401, "SSH_DSH_LOGIN_FAILED");
                for (String header : result.headers("Set-Cookie")) {
                    String candidate = header.split(";", 2)[0];
                    if (candidate.matches("dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~+/=\\-]{1,8192}")) {
                        if (closed) throw new BridgeFailure(409, "SSH_CONNECTION_CLOSED");
                        cookie = candidate;
                        return;
                    }
                }
                throw new BridgeFailure(502, "SSH_DSH_LOGIN_FAILED");
            }
        }

        private String launch() throws JSchException, IOException, BridgeFailure {
            ChannelExec command = (ChannelExec) ssh.openChannel("exec");
            // 主机上由本 App 拉起的 DSH 交给 SshManagedDsh 的脚本管：有 pid 文件就复用/重启，
            // 不会每次重连都多起一个 `dsh web`；进程用 nohup 脱离，关掉通道也不影响它。
            command.setCommand(SshManagedDsh.command(false, "dsh"));
            command.setErrStream(new OutputStream() {
                @Override public void write(int ignored) {}
                @Override public void write(byte[] bytes, int offset, int count) {}
            });
            InputStream output = command.getInputStream();
            synchronized (this) {
                if (closed) throw new BridgeFailure(409, "SSH_CONNECTION_CLOSED");
                managed = command;
            }
            command.connect(8_000);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            while (!closed && System.nanoTime() < deadline) {
                if (output.available() == 0) {
                    if (command.isClosed()) break;
                    try {
                        Thread.sleep(40);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    continue;
                }
                int value = output.read();
                if (value == -1) break;
                if (value != '\n') {
                    if (line.size() < 8192) line.write(value);
                    continue;
                }
                String printed = line.toString(StandardCharsets.UTF_8.name());
                line.reset();
                Matcher match = MANAGED_URL.matcher(printed);
                if (match.find()) return match.group();
                if (printed.contains("CHATPAD:BUSY") || printed.contains("CHATPAD:STILL_RUNNING")) {
                    throw new BridgeFailure(409, "SSH_DSH_BUSY");
                }
                if (printed.contains("CHATPAD:DSH_MISSING")) throw new BridgeFailure(502, "SSH_DSH_MISSING");
            }
            Matcher tail = MANAGED_URL.matcher(line.toString(StandardCharsets.UTF_8.name()));
            if (tail.find()) return tail.group();
            throw new BridgeFailure(502, "SSH_DSH_START_FAILED");
        }

        Request.Builder request(String path) {
            String authority = LOOPBACK + ":" + remotePort;
            Request.Builder request = new Request.Builder().url("http://" + LOOPBACK + ":" + localPort + path)
                    .header("Host", authority).header("Origin", "http://" + authority);
            if (cookie != null) request.header("Cookie", cookie);
            return request;
        }

        synchronized void close() {
            closed = true;
            cookie = null;
            if (mux != null) mux.cancel();
            if (managed != null) managed.disconnect();
            ssh.disconnect();
        }
    }

    private static final class PinnedKey implements HostKeyRepository {
        final String expected;
        volatile boolean mismatch;

        PinnedKey(String expected) { this.expected = expected; }

        @Override public int check(String host, byte[] key) {
            try {
                byte[] hash = MessageDigest.getInstance("SHA-256").digest(key);
                String fingerprint = "SHA256:" + Base64.encodeToString(hash, Base64.NO_WRAP | Base64.NO_PADDING);
                mismatch = !MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                        fingerprint.getBytes(StandardCharsets.US_ASCII));
                return mismatch ? CHANGED : OK;
            } catch (NoSuchAlgorithmException unavailable) {
                return CHANGED;
            }
        }
        @Override public void add(HostKey hostKey, UserInfo userInfo) {}
        @Override public void remove(String host, String type) {}
        @Override public void remove(String host, String type, byte[] key) {}
        @Override public String getKnownHostsRepositoryID() { return null; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return getHostKey(); }
    }

    static final class BridgeFailure extends Exception {
        final int status;
        BridgeFailure(int status, String code) {
            super(code);
            this.status = status;
        }
    }
}
