# 平板改版与 DSH Go 远程功能验收

参照 2026 年 11 月 21 日发布（北京时间）的 DSH Go v1.3.0，标签提交 `da798027013851328f83f59af4adb52c3afaab23`。以该标签的产品入口及中继协议为清单来源，账号设备接口补用 DSH Remote 的协议文档。部分操作依赖服务器版本、主机插件版本或主机开关。[发布说明](https://github.com/ccch1mneyyy/dsh-Go/releases/tag/v1.3.0) · [中继端点](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.3.0/packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart) · [消息状态](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.3.0/app/lib/state/chat_state.dart)

**2026-11-23 复核**：表中「已实现」的入口全部接入界面并通过本地验证 —— 远程自测 36 套、浏览器回归 188 项断言、Android 静态检查 8 项；APK 由 GitHub Actions 构建。仍标「待验」的是需要真机或真实主机才能确认的部分。

## 平板

| 场景 | 改动 | 验收 |
| --- | --- | --- |
| 横屏，1366×900 | 常驻会话导航，对话和输入区对齐，工作区停靠 | Chromium 模拟主机通过聊天、切换、引用、工作区、新建与设置 |
| 竖屏，800×1120 | 会话导航保留，工作区弹出，设置适应屏宽 | 同上 |
| 窄分屏，460×780 | 会话列表用抽屉，工作区独立浮层 | 同上，另验收抽屉 |
| 软键盘与窗口尺寸变化 | 主框架和弹窗使用 `visualViewport`，保持输入区可达 | Chromium 模拟视口缩短通过。Android IME、旋转和分屏实机待验 |
| 样式 | 沿用现有配色、字体和组件样式，重新安排各区域和操作层级 | 当前浏览器截图位于 `tmp/tablet-*.png` |

## DSH Remote 中继

| 能力 | Chat Pad 入口或实现 | 验收 |
| --- | --- | --- |
| 邮箱密码，OAuth，OAuth 扫码，设备注册，凭据刷新 | 设置 › 远程 DSH，`serverApi.ts`、`connection.ts` | REST 与连接自测。真实服务联调待验 |
| 设备配对 | 设置 › 远程 DSH › 配对主机。短链接和旧版二维码载荷、服务器确认、主机指纹、八位验证码 | 签名和绑定流程在本地验证。照片识别取决于 WebView 的 BarcodeDetector 支持，真机扫码待验 |
| 账号设备改名和撤销，撤销本机 | 设置 › 远程 DSH › 管理设备，`serverApi.ts`、`RemoteDevices.tsx` | 主机改名和撤销需支持账号设备管理的服务器。普通自部署和已配对账号兼容性待实测 |
| 配对关系列表和逐条解绑 | 设置 › 远程 DSH › 管理设备，`GET/DELETE /api/v1/device-memberships` | Chromium 模拟主机验收确认与逐条解绑，未断开未受影响的当前主机 |
| 多主机与公钥校验 | 会话栏主机菜单，`identity.ts`、`storage.ts`、`store.ts` | 切换和密钥自测，已指定主机时只连接该主机。真实主机待验 |
| 连接自愈、诊断、后台保护 | 设置 › 远程 DSH，设置 › 通用 › 后台与权限 | 握手耗时与按需请求耗时、自愈与通知回归。Chromium 检查连接报告只含耗时、传输方式和时间戳。完整分步诊断及真实弱网、连接速度和保活待验 |
| 会话列表、分页、搜索，新建、重命名、置顶与归档 | 会话栏，`sessionsApi.ts`、`newSessionStore.ts` | 远程自测，三尺寸切会话和新建模拟通过 |
| 会话删除、调整顺序 | 设置 › 远程 DSH › 管理工作区 › 工作区会话顺序，`workspace/insertSessionBefore` | Chromium 模拟主机验收按锚点上移并更新工作区。所选工作区采用主机顺序，置顶与归档保留各自分区。跨工作区移动待核实。DSH Go 的永久删除依赖支持该能力的 HTTP 载体和 Host 网关 |
| 工作区列表、新建、浏览目录、工作区文件 | 会话栏、新建页、工作区，`workspace/follow`、`workspaceFiles/*` | 工作区、文件及上传自测，浏览器停靠与浮层通过。Chromium 验证目录和当前文件预览随主机变更刷新，关闭面板释放订阅。独立新建文件夹需支持 `directoryPicker/createDirectory` 的载体 |
| 工作区改名、移除、上移与下移 | 设置 › 远程 DSH › 管理工作区 | Chromium 模拟主机完成排序和确认移除，保留模拟会话列表。验证主机推送的排序、取消置顶、归档和权限变化后的替换快照。自测覆盖切主机后迟到的订阅与旧主机能力回退。真实主机待验 |
| 工作区置顶、分组和最近目录 | 设置 › 远程 DSH › 管理工作区。分组用于会话列表筛选、新建和工作区切换。成功新建的目录可在目录表单中再次选用 | 按服务器、主机公钥及本机设备保存。Chromium 验证编辑、选择器展示、切主机隔离和重载恢复 |
| 新建时选工作区、模型、推理级别、权限预设和代理预设 | 新建页与对话输入区，`newSessionStore.ts`、`sessionControls.ts` | 新建与会话控制自测。不同 Host 版本的模型和权限结果待验 |
| 聊天时间线、流式输出、计划、工具、审批、提问、子代理 | 对话与输入区，`adapter.ts`、`store.ts`、`sessionControls.ts` | 时间线、计划、工具、审批和提问回归。各种主机的实际工具和交互待验 |
| 会话目标 | 对话 › 更多操作 › 会话目标，`goals/*`、`session/projections` | Chromium 模拟主机验收创建和暂停、检查会话和目标版本。编辑、继续、完成、清除及真实主机待验 |
| 技能、引用工作区文件及其他会话 | 对话 › 更多操作 › 技能／引用文件或会话，`skills/list`、`fileReferences/list`、`sessionReferenceResolver/candidates` | Chromium 模拟主机验收当页调用、带空格文件路径、主机生成的会话引用。其他工作区和真实主机待验 |
| 图片、文件和工作区引用 | 对话输入区／工作区，`upload.ts`、`filesApi.ts` | 上传与图片缓存自测。Host 对会话附件端点的支持需联调 |
| 排队、插话、停止 | 对话输入区，`composerState.ts`、`store.ts` | 输入和初始流自测。Chromium 模拟验证超时状态留在原会话，以及同一请求 ID 重试时由主机回显对账。真实断链和主机重启待验 |
| 复制、引用、图片预览 | 消息操作 | Chromium 验收当前会话引用，图片归属有自测 |
| 编辑重发、重新回答、分叉 | 消息操作，`messageActions.ts` | 使用 Host 支持的事件序号分叉。首轮、插话和只含附件的真实会话待验 |
| 草稿、附件、旧历史和断点恢复 | 输入区、会话缓存 | Chromium 用两台具有相同会话 ID 的主机验证刷新后的草稿、待确认消息和附件隔离。新建页和已有会话的附件草稿在设备上保留七天。已有会话按服务器、主机公钥、客户端设备及会话恢复。重连和重载可续用已确认收据并重试中断的原文件。首发失败重试复用同一连接上已创建的会话和收据。旧历史按持久事件分页，未回复的旧文本可放回输入框确认重发 |
| 单会话与工作区备份、跨主机恢复 | 设置 › 远程 DSH › 会话备份与恢复，`sessionTransfer.ts`、`sessionBackupDb.ts` | 导出／分片校验、恢复提交与状态查询自测。Chromium 验收加密存储及备份列表。恢复保留待核对记录，真实 Host 迁移待验 |
| 主机网页版 | 设置 › 远程 DSH › 打开 DSH 网页版，`dshWeb.ts`、`RemoteDshWebView.java` | 使用 `dsh.web.v1`，独立原生 WebView。已随 APK 编译通过，兑换、交互和租约回收待实机 |
| 插件包和插件条目开关 | 设置 › 远程 DSH › 主机插件 | Chromium 模拟主机通过读取、保护条目和开关后刷新。真实 Host 待验 |
| 远程插件设置、模型提供方与渠道凭据 | 设置 › 远程 DSH › 主机插件设置／主机模型渠道，`settings/*`、`llm/*`、`credentials/*` | Chromium 模拟主机验收按路径和版本写入、模型发现、凭据状态、写入和清除。模型覆盖支持名称、上下文、最大输出和输入类型。验证按模型 ID 写入、保留其他字段及清除单个覆盖。HTTP 插件配置桥、复杂插件表单、插件市场和真实主机待验 |
| 后台任务与输出 | 对话 › 更多操作 › 后台任务，`job/*` | Chromium 模拟主机验收任务列表、输出和停止 |
| 定时任务与投递历史 | 设置 › 远程 DSH › 自动化任务，`schedule/*` | Chromium 模拟主机验收列表、详情、历史、立即运行、选投递会话、创建、编辑标题与时间规则、删除，以及旧主机的 `schedule_create` 队列入口。复杂 Cron、时区边界和旧协议规则写入待联调 |
| 终端 | 对话 › 更多操作 › 终端，`terminal/*`，主机需要开启终端能力 | 自测通过。Chromium 模拟主机验收快照、输入与切会话释放流。真实 shell 和设备键盘待验 |
| 消息反馈、文件导出和朗读 | 消息工具和对话导出 | Chromium 验证反馈提交和清除带正确的消息、会话与版本，Markdown 归属正确，快照 ZIP 的会话与 SHA-256 匹配。切会话取消导出。当前 ZIP 格式是 Chat Pad 会话快照，DSH Go 的流式日志 ZIP 由 HTTP `/api/session.export` 提供。朗读复用应用 TTS，需 API Key，音频待实测 |
| 长图、分享链接和回放 | 对话 › 更多操作 › 导出会话。设置 › 远程 DSH › 会话分享与回放 | Chromium 验收消息范围、正文长图、播放速度与拖动。DSH Go v1.3.0 查看器验证正文 `.dshgo` 及加密托管字节。Chromium 模拟 Android 代理验证创建、保留凭据、解密回放和撤销。富媒体、工具事件、独立网页导出和线上服务实测待补 |
| 语音输入 | 现有会话和新建页的输入区，沿用 Chat Pad 的 DeepSeek API Key、ASR 和麦克风权限 | Chromium 模拟麦克风及 ASR 验证填入当前草稿、切会话丢弃迟到结果。Android 录音权限和实际转写待验 |
| 语音通话 | 对话 › 更多操作 › 语音通话，使用 Chat Pad ASR 和 TTS | 已接入既有会话的语音发送、单问题作答、朗读、打断和静音断句，浏览器回归通过。新建通话、流式断句朗读、实际识别和真机音频待验 |
| SSH 主机 | 设置 › 远程 DSH › 连接 SSH 主机，`sshHost.ts`、`SshDshHandler.java`、`SshManagedDsh.java` | 已实现：JSch 密码 / 私钥 + 主机公钥指纹校验，可自动拉起或接入已运行的 DSH Web，`ssh-mux` 走原生隧道。Chromium 模拟主机验收连接、表单回填与凭据不落盘；真机实连待验 |
| 直连、TURN 及中继降级 | 连接载体，`rtcTransport.ts`、`secureChannel.ts`，设置 › 远程 DSH › 连接方式 | 已实现直连 / TURN / 中继三档自动降级（RTCH 分片 + Noise）。Chromium 用两个模拟对端验证分片收发；真实网络、弱网与连接速度待实测 |

## 验证环境

Windows 有 Node.js、pnpm，以及 Chrome / Edge 之一；Android 构建由 GitHub Actions 完成，本机不再安装 JDK、Gradle、Android SDK。浏览器回归用模拟主机和三档视口，Android 静态检查覆盖源文件结构、清单权限与资源引用。真机扫码、Android 安装、旧版及新版 Host 对接、首次连接及切会话速度仍待独立验证。

本地与 CI 的检查口径一致：Web 类型检查、Rspack 生产构建、远程自测 36 套、浏览器回归 188 项断言、Android 静态检查 8 项、APK 构建。DSH Go v1.3.0 的分享查看器是 AGPL-3.0 第三方源码，未入库；本地放了夹具时额外跑两组兼容性断言，没有则标记 SKIP。

本地通过 Web 类型检查、Rspack 生产构建、浏览器启动检查、远程回归 35 套和 Android 静态检查 8 项。上级工作区检查通过，其 Python 检查因指定解释器不存在而跳过。模拟浏览器夹具和截图在 `tmp`。
