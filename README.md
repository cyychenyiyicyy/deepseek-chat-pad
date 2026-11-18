# DeepSeek Chat Pad

面向平板的 DeepSeek 客户端。基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造，
用 Android WebView 外壳承载，前端做了平板布局与多模型支持。

> 非官方项目，与 DeepSeek 无隶属关系；请自备 API Key。

## 功能

- **平板布局**：常驻左侧栏（可带动效收起）+ 主对话区，字号与触控目标按平板放大
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
  public/catalog/        离线模型目录（生成物，已提交）
android/           WebView 壳（纯 Java，AGP 8.4 / Gradle 8.7）
  LocalServer     127.0.0.1 上的本地 HTTP 服务：静态资源 + API 透传 + 更新接口
  UpdateHandler   分体更新的下载 / 解压 / 切换
tools/            build-catalog.mjs 生成离线目录
.github/workflows/ build.yml：类型检查 → 打包 → 编译 APK → 发布 release
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
NODE_ENV=production npx rspack build -c rspack.config.ts
```

重新生成离线模型目录（需要联网）：

```bash
node tools/build-catalog.mjs
```

## 已知限制

- 联网搜索 / 文件上传 / URL 阅读由 DeepSeek 的服务端能力提供，自定义模型下走客户端代取；
  附件目前仍只在 DeepSeek 模型下可用
- 思考强度依赖模型声明，未声明的模型不显示滑条
- 侧栏只有点按开合，没有手势滑动

## 许可

前端沿用上游 [chat-demo](https://github.com/deepseek-ai/chat-demo) 的 MIT 许可；
本仓库的改动同样以 MIT 发布。
