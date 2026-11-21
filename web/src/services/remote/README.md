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
| `oauth.ts` | 多方式登录：QR 会话 + 浏览器 / 扫码两条入口、轮询状态机、token → 设备、**待完成会话的跨进程恢复**（`dsp.remote.pending-login.v1`） | `serverApi.ts`、`identity.ts`、`storage.ts`、原生桥 `/__ds_auth/*` |
| `keepAlive.ts` | 原生保活服务（`/__ds_keepalive/*`）：连上就拉起、真断开就停、回前台自检 | 原生桥 |
| `qr.ts` | `scanUrl` → 二维码（GIF data URL / SVG），纯前端、不用 canvas | `qrcode-generator` |
| `connection.ts` | `RemoteClient` 状态机：login / loginWithAccountToken → registerDevice → listHosts → connect | 上面四个 + 契约 §3 的 `SecureLink` |
| `store.ts` | zustand 单例数据层（连接编排 + 会话/时间线 + 多方式登录动作 + 登录恢复 + 保活编排） | 全部 |

### 登录方式（三者等价：最后都换回同一个「设备 token pair」）

| 方式 | 入口 | 备援 |
|---|---|---|
| 邮箱密码 | `store.connect(server,email,password)` / `store.loginWithPassword()` | `serverApi.login()` |
| 浏览器授权 | `store.startProviderLogin(id,'browser')` → `pollProviderLogin()` | `oauth.startProviderLogin()` → 原生 `POST /__ds_auth/open {url, serverUrl, mode:'external'}`（**系统浏览器**；`no_browser` 自动回退 `inline`） |
| 扫码 | `store.startProviderLogin(id,'qr')` → 画 `qr.scanUrl` → `pollProviderLogin()` | 不需要原生桥（普通浏览器可用） |

> ⚠️ **不走** `return_to=dshremote://oauth` 回调：服务端只认官方 App 的 scheme，
> Chat Pad 声明它会抢回调，且没有 loopback 回调。详见
> `work/2026-11-21-chatpad接入DSH远程/input-J6-登录方式调研.md` §2 与 `input-J8-多方式登录.md`。
>
> 原生桥能力探测：`probeAuthBridge()` → `ready` / `missing`（非壳）/ `outdated`（旧 APK，提示更新）。
> 原生态只收 https、必须带 `serverUrl`、POST 必须 `application/json` —— 三条都已由 `oauth.ts` 兜住。

### 登录会话可恢复（K2）：`dsp.remote.pending-login.v1`

「切到系统浏览器 → 回后台」时 Android 常直接把 WebView 进程杀掉。服务端会话与进程无关，
所以只要把**待完成会话**落盘就能续上：

```
startProviderLogin ──► localStorage[dsp.remote.pending-login.v1]
   │                    = {serverUrl, providerId, mode, qrId, scanUrl, startedAt, expiresAt}（无 token）
   ├─► 系统浏览器授权
   ▼
（进程可能被杀）──► resumePendingLogin()  ← App 启动、visibilitychange→visible、回前台补拍
                        ├ pending / 网络瞬断 ─► 继续轮询（MAX_POLL_FAILURES=3 连败才放弃）
                        ├ complete          ─► 落账号 + 注册设备 + 删键
                        ├ expired / 超时    ─► 删键 + 返回原因
                        └ 401/404           ─► 删键 + 终止（qrId 已作废）
```

- `store.resumeLogin()`：单飞（并发只跑一个轮询）、代际守卫（旧流程不覆盖新会话）、
  没有待完成会话时**什么都不做**；
- `store.onAppForeground()`：回前台时 **续登录 + 立刻补一拍 + 保活自检**（后台
  `setTimeout` 被系统节流，不能等 2s 定时器）；
- `store.cancelProviderLogin()`：`abort` 轮询 + 删键（进程再被杀也不会续上）；
- **判定授权成功只看轮询结果**，`authPageState().open === false` 在 `external` 下是常态，
  拿它当「用户取消」会在打开浏览器的瞬间误判。

### 原生保活（K1）：`/__ds_keepalive/*`

远程连接的心跳是页面定时器；用户切到系统浏览器时定时器被冻结，服务端 75 秒就踢连接。
`keepAlive.ts` 负责：`phase==='ready'` 时 `POST /start`（幂等）、主动断开 / 终态 closed 时
`POST /stop`、回前台 `GET /state.json` 后按 `shouldRun && !running` 补一次 `start`。
探测**必须**用带 `.json` 的路径（旧 APK 的静态兜底会把未知路径回落成 `index.html` 且回 200）。
`battery`（拉起「忽略电池优化」）只能由用户点击触发。快照记在 `store.keepAlive` 里给 UI 用。

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
npx tsx src/services/remote/__selftest__/oauth.selftest.mts        # 40 PASS（providers / 扫码状态机 / 原生桥 / 二维码）
npx tsx src/services/remote/__selftest__/adapter.selftest.mts      # 27 PASS（线格式 → ChatItem）
npx tsx src/services/remote/__selftest__/login-resume.selftest.mts # 18 PASS（登录会话恢复 / 原生保活）
```

每个脚本失败都会 `exit 1`。
