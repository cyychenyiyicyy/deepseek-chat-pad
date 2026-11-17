# DeepSeek 平板（Tablet）

在 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 基础上做的**平板向 Android 客户端**：
WebView 壳 + 改造过的前端。不是简单套壳——前端做了平板布局、侧栏动效、多模型支持。

## 做了什么

### 1. 平板界面

按官方 DeepSeek 平板端的形态重做了布局：

- **常驻左栏**（宽度 `clamp(280px, 27vw, 396px)`），主对话区在右
- 左栏内是「胶囊搜索框 → 新建对话 → 按时间分组的会话 → 底部模型/设置入口」
- 顶栏：左侧 ☰ 控制侧栏，右侧「停止朗读 / 新对话」
- 字号与触控目标整体放大（会话行 46–50px、搜索框 48–50px），手机端保持原有排版

### 2. 侧栏滑动动效（原项目缺失的部分）

原实现是在 `Sider` 与 `CollapsedSider` 之间**直接换组件**，手机端抽屉更是 `if (!open) return null`，
所以开合是硬切、毫无过渡。现在：

- 侧栏**始终挂载**，收起时同时把容器宽度收到 0、把面板 `translateX(-100%)`
- 两个属性用同一条 `cubic-bezier(.32,.72,0,1)` / 300ms，视觉上是一次干净的滑出
- 手机抽屉同样是常驻挂载 + `transform` 动画，关闭时延后 `visibility` 保证动画播完
- 尊重系统「减弱动态效果」（`prefers-reduced-motion`）

### 3. 自定义模型端点

- 填 **Base URL + API Key** 就能用：自动识别厂商（`models.dev` + `openmodels.run` 的离线目录）、
  自动判断 OpenAI / Anthropic 兼容协议、自动拉 `GET /models` 得到模型列表
- 模型元信息（上下文窗口、是否支持思考、是否收图片、价格、发布日期）从离线目录补全，
  冷门厂商可以点「在线补全元信息」按需从 models.dev 取，结果缓存 7 天
- 输入框里的**模型选择器**：按厂商分组、可搜索、显示上下文长度

已内置 31 家常用厂商 / 2211 个模型的元信息，另有 336 家厂商的端点目录。

### 4. DeepSeek 余额

新对话页问候语下方显示余额胶囊（`GET /user/balance`），点按刷新；余额不足变红提示。
余额与当前对话模型无关，始终用 DeepSeek 的 Key。

### 5. 打包

GitHub Actions 一键出 APK：类型检查 → 前端构建 → 塞进 assets → Gradle 编译 → 上传 artifact + 发 preview release。

## 目录

```
web/                前端（React 18 + rspack，源自 chat-demo）
  src/services/models/   模型目录、端点解析、OpenAI 协议适配
  src/components/models/ 模型选择器、模型服务设置、余额胶囊
  public/catalog/        离线模型目录（生成物，已提交）
android/            WebView 壳（纯 Java，AGP 8.4 / Gradle 8.7）
  LocalServer     127.0.0.1 上的本地 HTTP 服务：静态资源 + API 透传代理
tools/             build-catalog.mjs 生成离线目录
.github/workflows/ build.yml
```

## 架构要点

**为什么要有本地 HTTP 服务？**
几十家模型的端点不可能都对 WebView 的源放行 CORS，而且部分端点不允许浏览器直连。
壳在 `127.0.0.1` 起一个服务，页面加载自它、API 也经它转发：

```
WebView ──GET /static/*──▶ LocalServer ──▶ assets/www/*
        ──POST /__ds_proxy──▶ ProxyHandler ──OkHttp──▶ 任意 https 端点（流式 chunked 回写）
```

同源之后，`fetch` 不再受 CORS 与混合内容限制，SSE 由原生侧边收边转。

**协议适配**：DeepSeek 走 Anthropic 兼容的 `/anthropic/v1/messages`（保留原生思考块、
联网搜索、文件引用、服务端标题）；自定义端点走 OpenAI 兼容的 `/chat/completions`，
`reasoning_content` / `content` 增量被翻译成同一套内部事件，渲染、续写、导出、历史回放都不用改。

## v1.1 变更（第一轮反馈）

- **跨域**：不再依赖 User-Agent 判断，改为探测同源 `/__ds_health`，杜绝「请求发不出去」
- **深色**：顶栏加浅/深切换按钮；系统栏图标随主题切换（JS→原生桥）；首屏预置底色防闪
- **模型服务并入设置页**：设置 → 模型服务，独立滚动由设置页负责（修掉「滑不动」）
- **产品名**：侧栏标题改为「DeepSeek 平板」
- **移除自动朗读**：回答下方朗读按钮、音色设置、顶栏停止朗读
- **后台内存**：渲染进程不可见时降优先级 + 前后台 `pauseTimers`；离线目录按需加载
- **工具支持自定义模型**：联网搜索与读链接改由 DeepSeek 的 `/v1/tools/search`、`/v1/tools/fetch`
  取回资料再注入上下文，界面照常显示来源卡片
- **多 provider 同名模型**：元信息按 provider 优先匹配，选择器按 provider 分组并标注来源

## v1.2 变更（第二轮反馈）

- **修掉「发不出消息」**：上游用了 `toReversed`（Chrome 110）与 `throwIfAborted`（Chrome 100），
  老 WebView 缺这两个方法就在发送前抛错。新增 `web/src/polyfills.ts` 兜底，并让错误显示真实原因而不是一律「上传失败」
- **模型选择器**改为居中弹层，点击不再把焦点交给输入框（之前会弹软键盘）
- **状态栏避让**：WebView 顶部按状态栏高度留白（Android 上 `env(safe-area-inset-*)` 恒为 0）
- **应用图标**换成鲸鱼 logo

## v1.3 变更（第三轮反馈）

- **固定签名**：仓库内置自签密钥，debug/release 共用，CI 校验签名指纹；
  versionCode 取 run number，保证每次构建都能覆盖安装、保留本地数据
- **图标**改为等比缩放，不再拉伸
- **OpenCode Go**：请求带稳定的 `x-opencode-session`
- **收起侧栏**后不再有悬浮胶囊与标题重叠，统一用顶栏 ☰
- **侧栏名**改为 DeepSeek
- **界面缩放**：设置 → 通用 → 界面缩放（80%–130%）

> 注意：v1.3.0 之前的包签名各不相同，装这一版仍需卸载一次；之后所有更新都能直接覆盖。

## 已知限制

- **联网搜索、文件上传、读链接仍是 DeepSeek 独有能力**。选中自定义模型时这两个开关会置灰，
  附件也会被拦下并提示切回 DeepSeek 模型。这些能力由 DeepSeek 服务端执行（`/v1/tools/*`），
  与对话模型解耦，后续可以接到任意模型上。
- 自定义模型下历史里的图片附件不会回传（第三方端点无法引用 DeepSeek 的 `file_id`）。
- 首版未做手势滑动开合侧栏，只有点按 + 动画。

## 构建

CI 已经全自动。本地想跑前端：

```bash
cd web
pnpm install
pnpm run type                  # 类型检查
npx rspack build -c rspack.config.ts   # 需要 NODE_ENV=production
```

本地打 APK 需要 JDK 17 + Android SDK 34（`gradle assembleDebug`），CI 里由
`gradle/actions/setup-gradle` 提供，仓库不放 wrapper jar。

## 安装

从 Actions 的 artifact 或 Release 里下载 `app-debug.apk`，允许「未知来源」后安装。
最低 Android 9（API 28）。

## 许可

前端沿用上游 MIT。本仓库的修改同样以 MIT 发布。
