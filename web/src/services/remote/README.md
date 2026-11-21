# services/remote —— 远程 DSH（S3：账号 / 设备 / 连接状态机）

Chat Pad 连远端 DeepSeek Harness 的**账号与连接层**。协议权威是
`docs/protocol.md`（vendor 快照在 `src/vendor/dsh-remote/`），分工见
`work/2026-11-21-chatpad接入DSH远程/plan-P0P1-实施契约.md`。

> 详细交接（逐帧时序 / 错误映射表 / 与契约差异 / 未确认项）见
> `work/2026-11-21-chatpad接入DSH远程/input-J3-账号与连接状态机.md`

## 分层（谁负责什么）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `serverApi.ts` | REST 调用 + 统一错误映射 + 「401 刷新一次」+ OAuth 发现 / 扫码会话 / 账号资料 | `identity.ts`（base64url / 公钥校验）、`storage.ts`（类型） |
| `identity.ts` | X25519 身份（`@noble/curves`）、UUIDv7、Device Descriptor | `@noble/curves`、`@noble/hashes` |
| `storage.ts` | localStorage：服务器 / 账号 + token / Host 公钥 pin | 无 |
| `oauth.ts` | 多方式登录：QR 会话 + 浏览器 / 扫码两条入口、轮询状态机、token → 设备 | `serverApi.ts`、`identity.ts`、原生桥 `/__ds_auth/*` |
| `qr.ts` | `scanUrl` → 二维码（GIF data URL / SVG），纯前端、不用 canvas | `qrcode-generator` |
| `connection.ts` | `RemoteClient` 状态机：login / loginWithAccountToken → registerDevice → listHosts → connect | 上面四个 + 契约 §3 的 `SecureLink` |
| `store.ts` | zustand 单例数据层（连接编排 + 会话/时间线 + 多方式登录动作） | 全部 |

### 登录方式（三者等价：最后都换回同一个「设备 token pair」）

| 方式 | 入口 | 备援 |
|---|---|---|
| 邮箱密码 | `store.connect(server,email,password)` / `store.loginWithPassword()` | `serverApi.login()` |
| 浏览器授权 | `store.startProviderLogin(id,'browser')` → `pollProviderLogin()` | `oauth.startProviderLogin()` → 原生 `POST /__ds_auth/open {url, serverUrl, mode}`（`inline` 应用内 WebView，`external` 系统浏览器；Google 自动 external） |
| 扫码 | `store.startProviderLogin(id,'qr')` → 画 `qr.scanUrl` → `pollProviderLogin()` | 不需要原生桥（普通浏览器可用） |

> ⚠️ **不走** `return_to=dshremote://oauth` 回调：服务端只认官方 App 的 scheme，
> Chat Pad 声明它会抢回调，且没有 loopback 回调。详见
> `work/2026-11-21-chatpad接入DSH远程/input-J6-登录方式调研.md` §2 与 `input-J8-多方式登录.md`。
>
> 原生桥能力探测：`probeAuthBridge()` → `ready` / `missing`（非壳）/ `outdated`（旧 APK，提示更新）。
> 原生态只收 https、必须带 `serverUrl`、POST 必须 `application/json` —— 三条都已由 `oauth.ts` 兜住。

**传输不在这里**：控制 WS、Noise、分片、心跳都在 S2 的 `core/`。
`connection.ts` 里有一份 `SecureLink` 结构副本，S2 的 `core/index.ts` 落地后改成
`import type { SecureLink, SecureLinkOptions } from './core/index.js'` 即可。

## 三条纪律

1. REST **只走** `POST /__ds_proxy`（`X-DS-Target` / `X-DS-Method` / `X-DS-Headers`），
   不直连远端；桌面浏览器调试可用 `deps.allowDirect` 显式打开直连。
2. **token 只存在 `storage.ts`**，不进 URL、不进日志。要打日志只能用
   `describeRemoteAccount()`（只含邮箱 / 服务器 / deviceId 前缀）或 `describeProviderLogin()`。
3. `harness.remote.v1` 与 `v3` 都拿不到就 **fail-closed**，不按版本号猜降级。

## 自测（tsx，不联网）

```bash
# workdir = projects/deepseek-tablet/web
npx tsx src/services/remote/__selftest__/serverApi.selftest.mts    # 26 PASS（请求形状 / 错误映射 / 刷新重试）
npx tsx src/services/remote/__selftest__/identity.selftest.mts     # 11 PASS（base64url / 身份 / descriptor）
npx tsx src/services/remote/__selftest__/connection.selftest.mts   # 19 PASS（状态机 / 能力协商 fail-closed）
npx tsx src/services/remote/__selftest__/oauth.selftest.mts        # 35 PASS（providers / 扫码状态机 / 原生桥 / 二维码）
npx tsx src/services/remote/__selftest__/adapter.selftest.mts      # 27 PASS（线格式 → ChatItem）
```

每个脚本失败都会 `exit 1`。
