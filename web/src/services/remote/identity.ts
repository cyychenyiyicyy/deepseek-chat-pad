/**
 * Chat Pad 远程 DSH：本机 X25519 设备身份。
 *
 * 协议依据：
 *   - docs/protocol.md §7 Device Descriptor：deviceId 必须是 ULID/UUID（新设备建议
 *     UUIDv7 或 ULID）；identityKey 是 32 字节 X25519 公钥的**规范无 padding base64url**，
 *     长度恰好 43；name ≤128 字节可见文本；platform 匹配 `[a-z0-9][a-z0-9._-]*`、≤64 字节；
 *     clientVersion 1–64 字节；**Client 禁止带 harnessVersion**。
 *   - docs/protocol.md §9：同一 deviceId 换 identityKey 会被 Server 拒绝，
 *     所以这份身份一旦生成就必须稳定存在，不能每次启动重新造。
 *
 * 为什么 base64url 编解码写在这里、不复用 `vendor/dsh-remote/crypto`：
 *   那份实现带 `Buffer` 兜底（Node 分支），页面代码要求「只用浏览器全局」，
 *   这里保持零 Node 依赖、零兜底分支，避免打包后留下一个悬空的 `Buffer` 引用。
 *
 * 私钥绝不外传：不进日志、不进 URL、不进错误信息；只有 `deviceDescriptor()` 会用到公钥。
 */

import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

import type { AccountDeviceDescriptor, ClientDeviceDescriptor } from '../../vendor/dsh-remote/protocol/index.js'

/** localStorage 键（契约 §4 指定：dsp.remote.identity.v1） */
export const IDENTITY_STORAGE_KEY = 'dsp.remote.identity.v1'

/**
 * 上报给 Server 的客户端软件版本（docs/protocol.md §10.3 的 `hello.clientVersion` 同源）。
 *
 * 这条值不是「我们的 App 版本」，而是**兼容性闸门**：protocol.md:553 规定
 * `hello.clientVersion < 0.2.13`、缺失或无效时 Server 走 last-client-wins ——
 * 平板连上去会把桌面端挤掉。取 0.2.13 这个下限，多客户端才能各自保持独立连接
 * （protocol.md:545-548：同一 Host 允许不同 clientDeviceId 并存）。
 */
export const CLIENT_VERSION = '0.2.13'

/** ChatPad 是页面客户端，platform 固定 web（protocol §7 允许 `[a-z0-9][a-z0-9._-]*`） */
export const DEFAULT_PLATFORM = 'web'

export interface DeviceIdentity {
  v: 1
  /** UUIDv7（时间有序，便于 Server 端 keyset 分页稳定） */
  deviceId: string
  /** 32 字节 X25519 私钥的无 padding base64url */
  privateKey: string
  /** 32 字节 X25519 公钥的无 padding base64url，长度必须是 43 */
  publicKey: string
  createdAt: number
}

const textEncoder = new TextEncoder()

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const BASE64URL_LOOKUP = new Map<string, number>(
  Array.from(BASE64URL_ALPHABET, (char, index) => [char, index] as const),
)

/** 字节 → 无 padding base64url（规范编码：不多一个填充位） */
export const toBase64Url = (bytes: Uint8Array): string => {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0
    out += BASE64URL_ALPHABET[a >> 2]
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)]
    if (index + 1 < bytes.length) out += BASE64URL_ALPHABET[((b & 0x0f) << 2) | (c >> 6)]
    if (index + 2 < bytes.length) out += BASE64URL_ALPHABET[c & 0x3f]
  }
  return out
}

/** 无 padding base64url → 字节；非法字符 / 非规范填充返回 null（不抛） */
export const fromBase64Url = (value: string): Uint8Array | null => {
  const remainder = value.length % 4
  // 长度 4n+1 不可能是合法 base64，其余按 2/3 字符收尾
  if (remainder === 1) return null
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let offset = 0
  for (const char of value) {
    const sextet = BASE64URL_LOOKUP.get(char)
    if (sextet === undefined) return null
    buffer = (buffer << 6) | sextet
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[offset] = (buffer >> bits) & 0xff
      offset += 1
    }
  }
  // 非零填充位要拒（docs/protocol.md §12.2 对握手数据的要求同理）
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null
  return offset === bytes.length ? bytes : bytes.subarray(0, offset)
}

/** 是否 32 字节公钥的规范无 padding base64url（长度恰好 43） */
export const isIdentityKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 43) return false
  const bytes = fromBase64Url(value)
  return bytes !== null && bytes.length === 32
}

/** UUIDv7：48 位毫秒时间戳 + 版本/变体位 + 随机尾，浏览器里零依赖生成 */
export const createDeviceId = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let timestamp = Date.now()
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isDeviceIdentity = (value: unknown): value is DeviceIdentity => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.v === 1 &&
    typeof record.deviceId === 'string' &&
    record.deviceId.length > 0 &&
    typeof record.privateKey === 'string' &&
    typeof record.publicKey === 'string' &&
    isIdentityKey(record.publicKey) &&
    typeof record.createdAt === 'number'
  )
}

/** 读取已保存的身份；没有 / 坏数据返回 null（坏数据不覆盖，等 loadOrCreate 重建） */
export const loadIdentity = (): DeviceIdentity | null => {
  const ls = storage()
  if (ls === null) return null
  try {
    const raw = ls.getItem(IDENTITY_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isDeviceIdentity(parsed)) return null
    // 私钥必须能推出同一个公钥，否则说明被改过 / 写坏了
    const derived = toBase64Url(x25519.getPublicKey(fromBase64Url(parsed.privateKey) ?? new Uint8Array(0)))
    return derived === parsed.publicKey ? parsed : null
  } catch {
    return null
  }
}

export const saveIdentity = (identity: DeviceIdentity): boolean => {
  const ls = storage()
  if (ls === null) return false
  try {
    ls.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
    return true
  } catch {
    return false
  }
}

/** 换机 / 彻底注销时用：清掉本地身份（下次会生成新 deviceId，需要重新注册设备） */
export const clearIdentity = (): void => {
  const ls = storage()
  if (ls === null) return
  try {
    ls.removeItem(IDENTITY_STORAGE_KEY)
  } catch {
    // 忽略
  }
}

/** 原地生成一份全新的 X25519 身份（不落盘） */
export const createIdentity = (): DeviceIdentity => {
  const privateKey = x25519.utils.randomPrivateKey()
  const publicKey = x25519.getPublicKey(privateKey)
  return {
    v: 1,
    deviceId: createDeviceId(),
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey),
    createdAt: Date.now(),
  }
}

/** 读取或首次创建并落盘（幂等：并发调用都拿到同一份） */
export const loadOrCreateIdentity = (): DeviceIdentity => {
  const existing = loadIdentity()
  if (existing !== null) return existing
  const created = createIdentity()
  saveIdentity(created)
  return created
}

/** 公钥指纹（给设置页显示 / 排障用），不含私钥 */
export const identityFingerprint = (publicKey: string): string => {
  const bytes = fromBase64Url(publicKey)
  if (bytes === null) return 'unknown'
  return Array.from(sha256(bytes).slice(0, 6), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** UTF-8 字节长度（协议里所有长度上限都按字节算，不按字符） */
export const utf8Length = (value: string): number => textEncoder.encode(value).length

const DEFAULT_DEVICE_NAME = 'Chat Pad'

/** 协议 §7：name 必须有可见文本且 ≤128 字节；超长按码点截断，不切坏代理对 */
export const sanitizeDeviceName = (value: string | undefined): string => {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return DEFAULT_DEVICE_NAME
  if (utf8Length(trimmed) <= 128) return trimmed
  let out = ''
  for (const char of trimmed) {
    if (utf8Length(out + char) > 128) break
    out += char
  }
  return out.length > 0 ? out : DEFAULT_DEVICE_NAME
}

/** 协议 §7：platform 匹配 `[a-z0-9][a-z0-9._-]*`、≤64 字节；不合法一律退回 web */
export const sanitizePlatform = (value: string | undefined): string => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) return DEFAULT_PLATFORM
  return normalized.length > 64 ? DEFAULT_PLATFORM : normalized
}

/** 协议 §7：clientVersion 1–64 字节；只保留可打印 ASCII，超长截断 */
export const sanitizeClientVersion = (value: string | undefined): string => {
  const normalized = (value ?? CLIENT_VERSION).trim().replace(/[^\x20-\x7e]/g, '')
  if (normalized.length === 0) return CLIENT_VERSION
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized
}

/** 协议 §7：deviceId 必须是 ULID 或 UUID；这里只做形状校验，不猜服务端实现 */
export const isDeviceIdShape = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)) return true // ULID
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) // UUID
}

/**
 * 组装注册用的 Device Descriptor（docs/protocol.md §7 / §8.1）。
 *
 * Client 分支**不带** `harnessVersion`（§7:188 明令禁止），Host 分支才允许。
 * `identity` 参数只为可测试性保留，正常调用走 localStorage 里的稳定身份。
 */
export function deviceDescriptor(
  role?: 'client',
  name?: string,
  platform?: string,
  identity?: DeviceIdentity,
): ClientDeviceDescriptor
export function deviceDescriptor(
  role: 'host',
  name?: string,
  platform?: string,
  identity?: DeviceIdentity,
): AccountDeviceDescriptor
export function deviceDescriptor(
  role: 'client' | 'host' = 'client',
  name?: string,
  platform?: string,
  identity?: DeviceIdentity,
): AccountDeviceDescriptor {
  const current = identity ?? loadOrCreateIdentity()
  const base = {
    deviceId: current.deviceId,
    name: sanitizeDeviceName(name),
    platform: sanitizePlatform(platform),
    identityKey: current.publicKey,
    clientVersion: sanitizeClientVersion(CLIENT_VERSION),
  }
  // ChatPad 只做 Client；Host 分支留给本地自测 / 将来「本机当 Host」
  return role === 'host' ? { ...base, role: 'host' } : { ...base, role: 'client' }
}
