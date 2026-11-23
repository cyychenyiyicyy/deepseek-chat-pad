# DeepSeek Chat Pad

面向平板的 DeepSeek 客户端。基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造，
用 Android WebView 外壳承载，前端做了平板布局与多模型支持。

> 非官方项目，与 DeepSeek 无隶属关系；请自备 API Key。

## 功能

- **平板布局**：常驻左侧栏（可带动效收起）+ 主对话区，字号与触控目标按平板放大
  - 横屏常驻会话栏、工作区停靠右侧；竖屏保留导航、工作区浮层；窄分屏用抽屉 + 独立浮层
  - 主框架与弹窗跟随 `visualViewport`，软键盘、旋转、分屏时输入区仍然可达
- **远程 DSH**：把 DSH Go 的远程客户端搬进平板
  - 连接：中继 / 直连 / TURN 自动降级，SSH 主机（密码或私钥 + 主机指纹），设备配对与多主机切换
  - 会话：列表管理、草稿与断点恢复、编辑重发 / 重新回答 / 分叉、会话目标、后台任务、终端
  - 工作区：目录浏览、新建文件夹、PDF / Office 预览，工作区排序与分组
  - 管理与自动化：定时任务、主机插件与插件市场、主机插件设置与模型渠道、会话备份与跨主机恢复
  - 分享与导出：长图、Markdown、网页、快照 ZIP，DSH Go 加密分享链接与回放
  - 语音：语音输入与语音通话（ASR + TTS）
  - 能力清单与验收状态见 [REMOTE-PARITY.md](REMOTE-PARITY.md)
- **多模型**：内置 DeepSeek，也可以填任意 OpenAI / Anthropic 兼容端点（MiniMax、OpenCode Go、Kimi、GLM…）
  - 填 Base URL + API Key 自动识别厂商与协议、自动拉模型列表
  - 上下文长度、是否支持思考等元信息来自 [models.dev](https://models.dev)，内置离线目录（31 家常用厂商）
- **思考强度滑条**：模型胶囊里一条可拖动的滑条，档位来自模型声明的 `reasoning_options`
  - DeepSeek 走 Anthropic 格式的 `output_config.effort`，其它端点走标准 `reasoning_effort`
- **分体式更新**：网页包和 APK 分开更新，网页包可以直接在应用内拉取，不必重装
- **DeepSeek 余额**：新对话页显示账户余额
- 联网搜索、文件上传、URL 阅读沿用 DeepSeek 官方接口
- 会话导入导出（DeepSeek 导出的 `deepseek_data-*.zip`）

## 安装

到 [Releases](https://github.com/cyychenyiyicyy/deepseek-chat-pad/releases) 下载最新的 `app-debug.apk`，
允许「未知来源」后安装。最低 Android 9（API 28）。

首次打开在设置里填 DeepSeek API Key 即可开始；想用第三方模型则在「设置 → 模型服务」里添加端点。

## 架构

```
web/               前端（React 18 + rspack，源自 chat-demo）
  src/services/models/   模型目录、端点解析、思考档位、协议适配
  src/components/models/ 模型胶囊（浮窗 + 滑条）、模型服务设置
  src/services/remote/   远程 DSH：连接 / 会话 / 工作区 / 文件 / 备份 / 分享 / 终端 / 语音
  src/components/remote/ 远程界面：会话页、抽屉、设置面板、工作区、各类管理弹窗
  public/catalog/        离线模型目录（生成物，已提交）
android/           WebView 壳（纯 Java，AGP 8.4 / Gradle 8.7）
  LocalServer     127.0.0.1 上的本地 HTTP 服务：静态资源 + API 透传 + 更新接口
  UpdateHandler   分体更新的下载 / 解压 / 切换
  RemoteWsHandler 远程 DSH 的 WebSocket 隧道（含 SSH mux）
  SshDshHandler   SSH 主机：JSch 隧道 + 主机侧 DSH Web 拉起
  RemoteDshWebView 主机网页版（独立 WebView）
tools/            build-catalog.mjs 生成离线目录
                  run-remote-regression.mjs 远程自测总入口
                  check-tablet-layout.mjs 浏览器回归（三档视口 + 远程功能）
                  check-android-shell.cjs Android 源文件 / 清单静态检查
                  qa/ 浏览器回归用的测试构建入口（tablet-qa.*）
.github/workflows/ build.yml：类型检查 → 构建 → 自测 → 浏览器回归 → 编译 APK → 发布 release
```

### 为什么要有本地 HTTP 服务

几十家模型的端点不可能都对 WebView 的源放行 CORS，部分端点也不允许浏览器直连。
壳在 `127.0.0.1` 上起一个服务（固定端口 18888），页面加载自它、API 也经它转发：

```
WebView ──GET /static/*──▶ LocalServer ──▶ assets/www 或 filesDir/web
        ──POST /__ds_proxy──▶ ProxyHandler ──OkHttp──▶ 任意 https 端点（流式 chunked 回写）
        ──/__ds_update/*──▶ UpdateHandler ──▶ 网页包 / APK 更新
```

同源之后 `fetch` 不再受 CORS 与混合内容限制，SSE 由原生侧边收边转。

### 分体式更新

Release 里会同时挂两个产物：

| 产物 | 用途 |
|---|---|
| `app-debug.apk` | 完整安装包 |
| `web-v1.5.0.zip` | 网页包，应用内下载后直接切换，不重装 |

壳会把网页包解压到应用私有目录，`AssetHandler` 优先从那里取资源；切换完刷新页面即可生效。
APK 更新则下载后拉起系统安装器。

## 本地开发

```bash
cd web
pnpm install
pnpm run type                          # 类型检查
pnpm run selftest                      # 远程自测（36 套，用已安装的 tsx 跑）
NODE_ENV=production npx rspack build -c rspack.config.ts
```

浏览器回归（三档视口 + 远程功能，188 项断言，需要本机有 Chrome / Edge）：

```bash
# 先构建测试入口（会替换远程连接层为模拟实现），再跑断言
cd web && NODE_ENV=production npx rspack build -c ../tools/qa/tablet-qa.config.ts && cd ..
QA_DIST=tmp/qa-dist node tools/check-tablet-layout.mjs
```

Android 源文件静态检查（不需要 JDK / Android SDK）：

```bash
node tools/check-android-shell.cjs
```

重新生成离线模型目录（需要联网）：

```bash
node tools/build-catalog.mjs
```

## v1.6.0 变更：分体式更新

- Release 同时发布 `app-debug.apk` 与 `web-v<版本>.zip`
- 应用内「设置 → 通用 → 检查更新」：只更新网页包（不重装，刷新即生效）或下载 APK（带进度）
- 原生接口 `/__ds_update/state|release|apply-web|download-apk|install-apk`，
  网页包解压到 `filesDir/web`，`AssetHandler` 优先从那里提供静态资源
- 启动时静默检查一次更新
- 滑条加大并新增 −/+ 步进按钮；修掉拖动时浮窗被滚动事件关闭的问题
- 应用名改为 **DeepSeek Chat Pad**

## v1.6.2 变更

- 更新改成**弹窗**：启动时自动检查并显示完整更新日志，设置里的入口打开同一个弹窗
- 下载**进度条 + 百分比**（下载 / 解压 / 校验）
- **可验证的完成判定**：下载前记录目标版本，结束后重新核对原生 state，只有版本真的变了才算成功；
  下次启动能识别「上次更新未完成」与「网页包已更新但页面未重载」
- release 正文改为纯文本（来自 `release-notes.md`）

## v1.6.3 变更

- 更新弹窗显示**网络状态**：系统代理地址 / VPN / 直连（新增 `/__ds_update/net`）
- 检查更新失败时如实显示原因，不再伪装成「已是最新」
- 说明：OkHttp 未禁用代理，系统 HTTP 代理与 VPN TUN 都会自动生效

## v1.6.4 变更

- **修掉开 VPN 时显示「没有新版本」**：GitHub API 按 IP 限流，VPN 共享出口容易 403；
  现在增加 `latest.json` 备用通道（release 资产，走 `/releases/latest/download/latest.json`，不限流）
- API 失败自动回落，两条都失败才报错

## v1.6.5 变更

- 思考强度滑条**真正跟手**：拖动期间直接写 CSS 变量，不经 React 渲染；带磁吸，松手吸附
- 模型弹层**向上展开**：用两个 rect 相减定位，不再依赖视口高度，界面缩放/软键盘都不会算歪

## v1.7.0 变更

- 更新可**跳过此版本**、可关闭**启动自动检查**；只改网页时 CI 标记 `apkRequired:false`，不再催更 APK
- **第三方多模态模型支持图片**：图片转 data URL 直发，不再要求 DeepSeek 模型
- **Tavily 搜索渠道**：设置里可切换 DeepSeek / Tavily

## v1.7.1 / v1.7.2

- Tavily 搜索失败不再中断对话，真实原因写进上下文；鉴权同时带 Bearer 头
- 长会话渐进式加载（首屏 24 条，按需补 40 条，保位置不跳）
- 修 `apkRequired` 恒为 true（`version.properties` 被算作原生改动）

## v1.7.3 变更

- Tavily 网络层失败重试一次；错误提示是可读的一句话（`upstream_failed` 是本地代理的错误码）
- 会话列表分页（首屏 60 + 显示更多）；长会话渐进加载（24 + 40）

## v1.8.0 变更：会话存储迁到原生 SQLite

- 四张表（sessions / messages / files / meta）；列会话列表不读消息体 → 启动快
- 老用户首启自动迁移，分批 + 校验条数，失败静默回退，IndexedDB 永不删除
- 设置 → 数据 显示后端（原生 SQLite / IndexedDB）
- 导入暂存仍用 IndexedDB

## v1.16.0 变更：远程 DSH 对齐 DSH Go v1.3.0

v1.9–v1.15 的变更见 [Releases](https://github.com/cyychenyiyicyy/deepseek-chat-pad/releases)；这一版把远程入口按 DSH Go v1.3.0 补齐：

- 连接：直连 / TURN / 中继三档自动降级；SSH 主机（JSch + 主机指纹 + 自动拉起 DSH Web）；设备配对与设备管理；连接自愈、诊断与后台保活
- 会话：分页 / 搜索 / 重命名 / 置顶 / 归档 / 永久删除；工作区会话排序；草稿与附件草稿（7 天、按主机隔离）；断点恢复
- 对话：会话目标、技能、引用文件与会话、后台任务、终端、编辑重发 / 重新回答 / 分叉、消息反馈、对话详情
- 工作区：新建文件夹、PDF / Office 预览、排序 / 置顶 / 分组 / 最近目录
- 管理与自动化：定时任务、主机插件与插件市场、主机插件设置与模型渠道、会话备份与跨主机恢复
- 分享与导出：长图、Markdown、网页、快照 ZIP，DSH Go 加密链接与回放
- 语音：语音输入、语音通话
- 平板布局重做：三档布局 + `visualViewport` 全局适配
- 工具链：远程自测 36 套、浏览器回归 188 项、Android 静态检查 8 项全部接入 CI

## 已知限制

- 联网搜索 / 文件上传 / URL 阅读由 DeepSeek 的服务端能力提供，自定义模型下走客户端代取；
  附件目前仍只在 DeepSeek 模型下可用
- 思考强度依赖模型声明，未声明的模型不显示滑条
- 侧栏只有点按开合，没有手势滑动
- 远程：真机扫码、IME / 旋转 / 分屏、录音与 TTS、SSH 实连、主机网页版兑换仍需真机验证；
  直连与 TURN 需要真实网络；分享与回放只带位图；跨工作区移动会话暂未支持；
  设备管理、配对关系、独立新建文件夹、永久删除依赖主机或服务器支持，不支持时界面会说明；
  插件更新是「先卸旧包再装新包」，安装失败时旧版本不会自动回滚，重新点安装即可

## 许可

前端沿用上游 [chat-demo](https://github.com/deepseek-ai/chat-demo) 的 MIT 许可；
本仓库的改动同样以 MIT 发布。
