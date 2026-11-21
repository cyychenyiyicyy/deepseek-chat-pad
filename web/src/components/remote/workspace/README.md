# components/remote/workspace —— 工作区文件浏览与会话附件上传（W3）

远程会话页右侧的「工作区」抽屉 + 输入区的「+」附件上传。数据面在本目录**之外**：
端点封装在 `src/services/remote/filesApi.ts`，这里只有界面状态与组件。

## 文件

| 文件 | 职责 |
|---|---|
| `workspacePaneStore.ts` | 纯界面 store（zustand）：抽屉开关、能力门禁、目录缓存、预览态、附件队列。只**读** `useRemoteStore` / `useNewSessionStore` 的公开字段 |
| `WorkspacePane.tsx` | 抽屉 / 手机全屏 sheet：顶栏（标题 + 工作区路径 + 工作区切换 + 刷新 + 关闭）、面包屑、目录树 / 预览二选一 |
| `WorkspaceTree.tsx` | 目录树，**懒加载**（展开才 `list`，一次一层）；目录在前、同类按名称；文件图标复用 `components/files/FileIcon` |
| `FilePreview.tsx` | 文本（前 256 KiB + 「加载更多」）/ 图片（blob URL）/ 二进制占位 |
| `AttachmentTray.tsx` | 输入框上方的附件条：上传中（进度）/ 完成（收据 **或** 已存到工作区 + 引用）/ 失败（可读原因 + 重试 + 移除） |
| `AttachmentButton.tsx` | 输入框旁的「+」 + 隐藏 `<input type=file multiple>`；通道全不可用时变暗但**不消失** |
| `uploadCopy.ts` | 上传失败原因码 → i18n 文案（组件里不写中文） |
| `WorkspacePane.module.css` / `AttachmentTray.module.css` | 样式（颜色一律走 `theme.css` 的 `dsw-*` 变量） |

## 三条纪律（改这里之前先读）

1. **一次一目录**：`workspaceFiles/list` 只按需拉当前展开的那层，不递归、不预取；
   目录缓存 key 是相对路径（根是 `''`），换会话整块丢掉。
2. **大文件不整块进内存**：`readBytes` 单次 4 MiB 上限、transfer chunk 512 KiB
   （见 `input-B-rpc-surface.md` 附录 B）。文本按 256 KiB 累加（封顶 4 MiB），
   图片按 512 KiB 分块拼（超过 8 MiB 直接拒），二进制**只 stat 不读正文**。
3. **blob URL 必须释放**：图片预览在「换图 / 关预览 / 关抽屉 / 换会话 / 组件卸载」五处
   `URL.revokeObjectURL`。

## 能力门禁（没有专属 capability，只能按调用结果判断）

| 能力 | 初始 | 关闭条件 | 影响 |
|---|---|---|---|
| 工作区文件 | `filesSupported: null`（先画） | `workspaceFiles/list` 回 `METHOD_NOT_FOUND` 等 | 顶栏「工作区」按钮 + 抽屉整块消失 |
| 附件上传 | `uploadSupported: null`（先画） | **两条**上传通道都明确不可用（`UPLOAD_UNAVAILABLE`） | 「+」**仍然在**，但标成不可用（`aria-disabled`）+ tooltip/点击 toast 说原因 |

这与 `services/remote/newSessionStore.ts` 的「先信任、失败即关」是同一条约定：
两条端点都没有专属 capability 字符串（`input-B` §1.4.2），不真发一次没有别的办法知道。

## 附件上传的分级链（R15，改之前必读）

**单次失败不是「没能力」**：`fileUploads/upload` 在 Host 0.5.22 上必然回 `METHOD_NOT_ALLOWED`
（它的 allowlist 里没这个端点），而 0.5.22 **一定会**声明 `workspace.upload.v1`。
所以上传走 `services/remote/upload.ts` 的两级链：

```
fileUploads/upload（收据）  → 被拒（METHOD_NOT_ALLOWED/405/旧 codec…）
   → workspace.upload.open|chunk|commit|abort（20 MiB@Relay / 1 GiB@LAN-P2P）
      → 拿到 ./name → 发送时正文追加 @name（引用令牌穿过 readyReceipts）
```

| 成功凭据 | 附件 chip | 发送时 |
|---|---|---|
| `receiptId` | 普通实线 | `content:[{type:'file', receiptId}]` |
| `remotePath`（`./a.png`） | 虚线边 + 「已存到工作区 · @a.png」 | 正文 `@a.png`（令牌被 `sendPrompt()` 摘掉，不进 `file` 块） |

三条不能改的边界：

1. **唯一该关入口的条件是 `UPLOAD_UNAVAILABLE`**（两条通道都明确不可用）——`uploadSupported`
   才置 `false`；`405` / `METHOD_NOT_ALLOWED` 只说明「这条通道不认」，必须继续降级。
2. **不再静默隐藏「+」**：置 `false` 时按钮保留、变暗、带原因（`AttachmentButton` 的
   `data-upload-state="unavailable"`），点一下弹 toast。编辑器与视觉都别把它改回 `return null`。
3. **工作区上传的名字必须过 Host 的 `name` 规则**（≤220 UTF-8 字节、无 `<>:"|?*` 与控制字符、
   避开保留名与 `.dsh-upload-` 前缀）——`upload.ts` 的 `sanitizeWorkspaceUploadName()` 负责，
   改规则先跑 `upload.selftest.mts` 的 F 组。

排查时看页面 console 的 `[upload] …` 行：每次上传都会打出计划、走的通道、失败码、最终路径。

## 给 `components/remote/tool/**`（工具卡）的接入点

工具卡里「只有 `attachmentId`、没有 `uri`」的图片以前只能画占位（L2 报告 §5.3 的缺口），
现在有读取口了 —— **本批没有改 `tool/**`**，接入方式如下：

```tsx
// components/remote/tool/ToolCard.tsx 的 Thumbnail
import { toolImageLoader } from '../../../services/remote/filesApi.js'

const [src, setSrc] = useState(image.uri)
useEffect(() => {
  if (src !== undefined || image.attachmentId === undefined) return undefined
  let alive = true
  toolImageLoader(image, image.sessionId)
    .then((uri) => { if (alive && uri !== null) setSrc(uri) })
    .catch(() => undefined)
  return () => { alive = false }
}, [image, src])
```

- `toolImageLoader === loadToolImage(image, sessionId?)`：`uri` 直接返回；只有 `attachmentId`
  时走 `session/attachment`，返回 `data:` URL，并对「同一 (session, attachment)」做内存缓存
  （24 张 / 24 MiB 上限，超了丢最旧）。
- 需要一条活连接：内部用 `lastRemoteTarget()` + `phase === 'ready'`，否则抛 `REMOTE_NOT_READY`
  —— 所以工具卡那条 `.catch(() => undefined)` 不能少。
- 换连接 / 退出远程模式想清缓存：`clearToolImageCache()`。

## 已知缺口

- **PDF / Office 预览没做**（要走 `officeToPdf/generation|render`，两条额外端点 + 生成器版本校验，
  归 P2）。现在落到二进制占位，只显示大小。
- **图片按 `uri` 内联的（`data:`）不走分块**：那是结果块自带的像素，直接显示。
- **`workspaceFiles/changes` 只实现了读取函数，界面不订阅**：一次 `list` 比维护增量游标便宜。
- **降级路径把附件送出去靠的是正文 `@name` 引用**（官方 RN 客户端同做法）：模型会按引用去读
  工作区里的文件，而不是收到内联图片。真机要确认「200 KB 的图」能被看到；若看不到，下一步才是
  在 `sendPrompt` 里把图片改成 `{type:'image', mediaType, data}` 内联（需要另一份字节保留策略）。
- **首次上传会白试一次收据通道**：0.5.22 上它必然 `METHOD_NOT_ALLOWED`，而且 base64 编码在
  调用之前（20 MiB 约 2.5 s）。结论按连接记忆（`upload.ts` 的 `memoryFor()`），同一条连接只付一次；
  换连接自动重来。要彻底省掉得先做一次「1 字节探针」，会留下一个真实收据，暂不做。
- 错误原因文案是中文（来自数据层，与 `store.ts` / `newSessionStore.ts` 的处理一致）；
  界面骨架文案（标题 / 按钮 / 空态）全部走 i18n 的 `workspacePane*` 与 `upload*`。
