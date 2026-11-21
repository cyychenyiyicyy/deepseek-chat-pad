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
| `autoConnect.ts` | **上次连接**（`dsp.remote.last-session.v1`，不含 token）+ 「重启后怎么连回去」的纯函数判定（`planAutoConnect`） | `storage.ts`（类型） |
| `permissions.ts` | 原生权限中心（`/__ds_keepalive/permissions.json` / `open` / `notify`）：通知 / 电池 / 自启动 / 精确定时 / 悬浮窗 / 常驻通知 | 原生桥 |
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

### 重启后自动恢复登录（K4）：`dsp.remote.last-session.v1`

**根因**：设备 token pair 一直存在 `dsp.remote.accounts.v1` 里，缺的是「启动时用它」的代码 ——
`resumeLogin()` 只续「登录过程中」的 QR 会话，所以 App 一起来 `phase === 'idle'`，
远程页显示「未连接」、设置页把邮箱密码表单原样摆出来。

```
连上（密码 / 浏览器授权 / 扫码 / 自动恢复成功）
   └─► last-session = {serverUrl, email, hostDeviceId, hostName, capabilities?, transport?, savedAt}
        （**不含 token**；token 的唯一归属仍是 storage.ts）

启动 ──► autoConnectNow()（幂等单飞；装在 RemoteChatView + RemoteSettingsPanel 的挂载 effect 里）
   ├ 没有记录 / 账号没了 / 还没注册设备 ─► 什么都不做（**不删记录**，见 R10）
   ├ refresh token 过期 ─► failed/SESSION_EXPIRED（「登录已过期，请重新登录」；记录/邮箱都留着）
   ├ access token 快过期（60s 提前量） ─► POST /auth/refresh（原子替换）+ 建链
   └ 其余 ─► 直接建链（优先连回 hostDeviceId 那台）
         成功 ─► 写 last-session + autoConnect=done
         失败 ─► **保留** last-session + autoConnect=failed（不写 state.error、不弹红条）
```

- `disconnect()` = **临时断开**：保留 last-session / 账号，下次启动照常自动连；
  `signOut()` = **退出登录**：清 last-session + 删本机凭据（**唯一**允许清凭据的地方）。
- `retryAutoConnect()`：用户点「重试连接」（设置页横幅）；`disconnect()` 之后重连也走它。
- 不在壳里（普通浏览器）直接跳过：没有 `/__ds_proxy`，连也连不上，白打一轮网络请求。

### 掉线自愈（R10）：连接断了 ≠ 凭据失效

真机反馈：「放后台很久重新打开会显示凭据失效，重启一下就好了」「连接失败你就刷新一下就好了呀」。

| 输入 | 分诊（`reconnect.ts`） | 动作 |
|---|---|---|
| 没网 / 超时 / `CONNECTION_FAILED` / `CONNECTION_REPLACED` / WS 1006·4001·4009 | `offline` / `unreachable` | 退避 1·2·4·8·16 s 自动重连（最多 5 次），**绝不**提示凭据 |
| `TOKEN_EXPIRED` / 401·403 / WS 4002 | `token-expired` | 先 `POST /auth/refresh` 再重连（每次恢复只刷一次） |
| refresh 也 401 / `REFRESH_FAILED` / 没有 refreshToken | `need-login` | 停：红字「登录已过期，请重新登录」 |
| `DEVICE_REVOKED` / WS 4004 / 身份不符 / 会员 / 版本不兼容 | `blocked` | 停：展示具体码与说明 |

- 触发点：`SecureLink.onState('closed', detail)`（解析出真实 code 与 close code）、
  `visibilitychange → visible` / `focus`（`installForegroundSelfHeal()`，装在 store 模块上，
  不依赖页面是否挂载）、用户点「立即重连」（`reconnectNow()`）。
- **纪律**：这条路径永不 `clearLastSession()` / `removeAccount()`；`disconnect()` 会
  `cancelReconnect()`（连"下一秒自己连回来"都不许发生）。
- 成功之后 `restoreActiveSession()` 把上次开着的会话重新打开（否则「会话还在但发不出消息」）。
- 自测：`__selftest__/reconnect.selftest.mts`（分诊表逐条 / 退避序列 / 刷新只一次 / 不清凭据 / 回前台立即重连）。

### 原生权限中心（M2）：`/__ds_keepalive/*`

权限 UI 在「**通用设置 → 后台与权限**」（`components/settings/BackgroundPermissions.tsx`），
**不在**远程面板里 —— 通知 / 电池 / 自启动 / 精确定时 / 悬浮窗属于整个 App 的后台存活能力。

| 行 | 判据 | 动作（`POST /open {target}`） |
|---|---|---|
| 通知权限 | `notifications.granted`（`channelBlocked` 另外提示渠道被关） | `notifications` |
| 电池优化 | `battery.exempt \|\| battery.ignored` | `battery` |
| 自启动 | `autoStart.intentAvailable`（标题带 `manufacturer`） | `autoStart`，不可用降级 `appDetails` |
| 后台保活服务 | `foregroundService.running / shouldRun` 三态 | —（状态行） |
| 精确定时 / 悬浮窗 | **只在 `declared:true` 时显示** | `exactAlarm` / `overlay` |

- **业务失败也是 HTTP 200**：判定只看 `ok` / `fallback`，不看状态码；
  `degraded:true` 要提示「已打开应用详情页，请在里面手动设置」。
- 旧 APK：`permissions.json` 404（或回了 `index.html`）→ 整节不显示。

### 原生保活服务（K1）：`/__ds_keepalive/start|stop|state.json`

远程连接的心跳是页面定时器；用户切到系统浏览器时定时器被冻结，服务端 75 秒就踢连接。
`keepAlive.ts` 负责：`phase==='ready'` 时 `POST /start`（幂等）、主动断开 / 终态 closed 时
`POST /stop`、回前台 `GET /state.json` 后按 `shouldRun && !running` 补一次 `start`。
探测**必须**用带 `.json` 的路径（旧 APK 的静态兜底会把未知路径回落成 `index.html` 且回 200）。
权限相关（通知 / 电池 / 自启动…）走上面的权限中心，不再由 `keepAlive.ts` 管。

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
npx tsx src/services/remote/__selftest__/last-session.selftest.mts # 17 PASS（重启自动恢复 / 权限中心 404 降级）
```

每个脚本失败都会 `exit 1`。
