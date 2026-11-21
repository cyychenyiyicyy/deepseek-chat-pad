# services/remote —— 远程 DSH（S3：账号 / 设备 / 连接状态机）

Chat Pad 连远端 DeepSeek Harness 的**账号与连接层**。协议权威是
`docs/protocol.md`（vendor 快照在 `src/vendor/dsh-remote/`），分工见
`work/2026-11-21-chatpad接入DSH远程/plan-P0P1-实施契约.md`。

> 详细交接（逐帧时序 / 错误映射表 / 与契约差异 / 未确认项）见
> `work/2026-11-21-chatpad接入DSH远程/input-J3-账号与连接状态机.md`

## 分层（谁负责什么）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `serverApi.ts` | 5 个 REST 调用 + 统一错误映射 + 「401 刷新一次」 | `identity.ts`（base64url / 公钥校验）、`storage.ts`（类型） |
| `identity.ts` | X25519 身份（`@noble/curves`）、UUIDv7、Device Descriptor | `@noble/curves`、`@noble/hashes` |
| `storage.ts` | localStorage：服务器 / 账号 + token / Host 公钥 pin | 无 |
| `connection.ts` | `RemoteClient` 状态机：login → registerDevice → listHosts → connect | 上面三个 + 契约 §3 的 `SecureLink` |

**传输不在这里**：控制 WS、Noise、分片、心跳都在 S2 的 `core/`。
`connection.ts` 里有一份 `SecureLink` 结构副本，S2 的 `core/index.ts` 落地后改成
`import type { SecureLink, SecureLinkOptions } from './core/index.js'` 即可。

## 三条纪律

1. REST **只走** `POST /__ds_proxy`（`X-DS-Target` / `X-DS-Method` / `X-DS-Headers`），
   不直连远端；桌面浏览器调试可用 `deps.allowDirect` 显式打开直连。
2. **token 只存在 `storage.ts`**，不进 URL、不进日志。要打日志只能用
   `describeRemoteAccount()`（只含邮箱 / 服务器 / deviceId 前缀）。
3. `harness.remote.v1` 与 `v3` 都拿不到就 **fail-closed**，不按版本号猜降级。

## 自测（tsx，不联网）

```bash
# workdir = projects/deepseek-tablet/web
npx tsx src/services/remote/__selftest__/serverApi.selftest.mts    # 26 PASS（请求形状 / 错误映射 / 刷新重试）
npx tsx src/services/remote/__selftest__/identity.selftest.mts     # 11 PASS（base64url / 身份 / descriptor）
npx tsx src/services/remote/__selftest__/connection.selftest.mts   # 19 PASS（状态机 / 能力协商 fail-closed）
```

三个脚本失败都会 `exit 1`。
