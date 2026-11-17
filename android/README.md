# DeepSeek 平板 —— Android WebView 壳

纯 Java（无 Kotlin）、单 Activity 的原生壳。它把 Web 产物（`web/dist`）当本地站点跑在
**只监听 127.0.0.1** 的内置 HTTP 服务器上，再由 WebView 加载，并在同一服务器上提供一个
https 透传代理，绕开 CORS。

```
android/
├── settings.gradle / build.gradle / gradle.properties   AGP 8.4.2 + Gradle 8.7 + JDK 17
└── app/
    ├── build.gradle                  compileSdk 34 / minSdk 28 / targetSdk 34, buildConfig 打开
    ├── proguard-rules.pro            当前 minifyEnabled=false，规则只是预留
    └── src/main/
        ├── AndroidManifest.xml       只有 INTERNET + ACCESS_NETWORK_STATE
        ├── assets/www/               ← CI 把前端产物复制到这里（index.html 必须在顶层）
        ├── java/ai/deepseek/tablet/
        │   ├── MainActivity.java     WebView 壳、窗口/inset、文件选择、返回键、崩溃重建
        │   ├── LocalServer.java      ServerSocket(0) + HTTP/1.1 解析 + 路由 + keep-alive
        │   ├── AssetHandler.java     assets/www 静态资源、MIME、缓存头、路径穿越防护
        │   ├── ProxyHandler.java     /__ds_proxy 透传 + chunked 流式回写
        │   └── HttpUtil.java         请求行/头解析、状态行写出、分块写入、base64url
        └── res/                      主题（深色、透明系统栏）、NSC、自适应图标
```

## 构建

本机没有 JDK/SDK，仓库也**不带 gradle wrapper jar**（二进制不便入库）。CI 里二选一：

```yaml
# 方案 A：用 setup-gradle 提供 Gradle 8.7，然后 gradle 直接跑
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: '17' }
- uses: gradle/actions/setup-gradle@v3
  with: { gradle-version: '8.7' }
- run: |
    cd android
    gradle wrapper --gradle-version 8.7   # 可选：生成 wrapper
    gradle assembleDebug
```

```yaml
# 方案 B：手动装 Gradle
- run: |
    cd android && gradle assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。
前端产物要先落到 `android/app/src/main/assets/www/`（`index.html` 在**顶层**，不要多套一层 `dist/`）。

## 内置服务器的对外接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | → `assets/www/index.html` |
| GET | `<path>` | → `assets/www/<path>`；缺失且末段无扩展名时回落到 index.html（SPA 路由刷新） |
| GET | `/__ds_health` | `{"ok":true,"version":"<BuildConfig.VERSION_NAME>"}` |
| POST | `/__ds_proxy` | https 透传代理，见下 |

代理协议（**Web 端已固定，改动需双方同步**）：

```
X-DS-Target  : base64url(UTF-8 完整目标 URL)，必须以 https:// 开头，否则 400
X-DS-Method  : 真实方法，默认 POST
X-DS-Headers : base64url(UTF-8 JSON 对象)，可选
请求体       : 原始字节，原样转发（支持 Content-Length 与 chunked 两种请求体）

响应         : 上游状态码 + Content-Type，Transfer-Encoding: chunked，逐块 flush
```

## 关键实现

- **真流式**：`ProxyHandler.forward()` 里 `upstream.read(buf)` → `writeChunk()` → `flush()`
  三步在同一个循环里，没有"读完再写"的缓冲。SSE 的每一行一到达就穿过回环 socket 到 WebView。
- **共享 OkHttpClient**：`MainActivity.ensureHttpClient()` 建一次，`LocalServer` → `ProxyHandler`
  全程复用；`readTimeout(0)` 保证长连接流不被超时掐断；上游只允许 https（networkInterceptor
  兜住重定向跳到 http 的情况）。
- **端口**：`new ServerSocket(0, 64, 127.0.0.1)` 由系统分配，拿到 `getLocalPort()` 后才 `loadUrl`，
  起不来就显示原生 TextView 错误页（提示端口占用），可点屏重试。
- **缓存策略**：`static/**`（文件名带 contenthash）→ `max-age=31536000, immutable`；
  其余（含 index.html）→ `no-cache`。
- **安全**：只监听回环；路径规范化拒绝 `..` / 反斜杠；`network_security_config` 默认禁明文、
  只放行 `127.0.0.1` 与 `localhost`。

## 自检

```powershell
node tools/check-android-shell.cjs
```

做括号/字面量配平、资源引用交叉校验、Gradle/清单关键项与 26 项需求断言。
报告写到 `tools/check-android-shell.report.json`。**注意**：这不是编译，只是静态检查。
