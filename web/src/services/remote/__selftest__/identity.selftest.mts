/**
 * `identity.ts` 单测：X25519 身份 / base64url 规范性 / Device Descriptor 约束。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/identity.selftest.mts
 *
 * 这些点单靠 typecheck 抓不到，但错了会被 Server 直接拒（docs/protocol.md §7/§8.1）：
 * base64url 必须无 padding 且填充位为零、identityKey 必须恰好 43 字符、
 * name ≤128 字节、platform 必须匹配 `[a-z0-9][a-z0-9._-]*`、Client 不许带 harnessVersion。
 */

import { x25519 } from '@noble/curves/ed25519'

import { deviceDescriptor, createDeviceId, fromBase64Url, identityFingerprint, isIdentityKey, loadIdentity, sanitizeDeviceName, sanitizePlatform, toBase64Url, createIdentity } from '../identity.js'

/* ── 极简断言器（与 serverApi.selftest 同款） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> | void }> = []
const check = (name: string, run: () => Promise<void> | void): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

/* ── base64url ────────────────────────────────────────────────────────── */

check('base64url：32 字节往返一致，长度 43，字符集合法，无 padding', () => {
  for (let round = 0; round < 20; round += 1) {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    const encoded = toBase64Url(bytes)
    assertEqual(encoded.length, 43, '32 字节的长度')
    assertTrue(/^[A-Za-z0-9_-]+$/.test(encoded), `字符集不合法：${encoded}`)
    assertTrue(!encoded.includes('='), '不能有 padding')
    const decoded = fromBase64Url(encoded)
    assertTrue(decoded !== null && decoded.length === 32, '解码长度')
    assertEqual(Array.from(decoded!), Array.from(bytes), '往返字节')
  }
})

check('base64url：拒非法字符 / 4n+1 长度 / 非零填充位', () => {
  assertEqual(fromBase64Url('AAAA+AAA'), null, '+ 不是 base64url 字符')
  assertEqual(fromBase64Url('AAAA/AAA'), null, '/ 不是 base64url 字符')
  assertEqual(fromBase64Url('AAAAA'), null, '4n+1 长度不可能合法')
  // 'AB' 的最后一个 4 位（低 4 位）非零 → 非规范编码
  assertEqual(fromBase64Url('AB'), null, '非零填充位必须拒绝')
  const ok = toBase64Url(new Uint8Array([0, 0]))
  assertEqual(ok, 'AAA', '两个 0 字节编码')
  assertEqual(fromBase64Url('AAA')?.length, 2, 'AAA 解出 2 字节')
})

check('isIdentityKey：恰好 43 字符的规范 base64url 才通过', () => {
  const identity = createIdentity()
  assertTrue(isIdentityKey(identity.publicKey), '真实公钥应通过')
  assertTrue(!isIdentityKey(identity.publicKey.slice(0, 42)), '42 字符不通过')
  assertTrue(!isIdentityKey(`${identity.publicKey}A`), '44 字符不通过')
  // 换成标准 base64 的 '+'（base64url 里不存在）必须被判非法
  assertTrue(!isIdentityKey(`${identity.publicKey.slice(0, 42)}+`), '标准 base64 字符不通过')
  assertTrue(!isIdentityKey(123), '非字符串不通过')
})

/* ── 身份 ─────────────────────────────────────────────────────────────── */

check('createIdentity：私钥能推出同一个公钥（与 noble 交叉验证）', () => {
  const identity = createIdentity()
  const privateBytes = fromBase64Url(identity.privateKey)
  assertTrue(privateBytes !== null && privateBytes.length === 32, '私钥 32 字节')
  const derived = toBase64Url(x25519.getPublicKey(privateBytes!))
  assertEqual(derived, identity.publicKey, '公钥必须是私钥的派生结果')
  assertEqual(identity.v, 1, '结构版本')
})

check('createDeviceId：UUIDv7 形状（version 7 / variant 10xx）且时间有序', () => {
  const first = createDeviceId()
  assertTrue(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first), `不是 UUIDv7：${first}`)
  const second = createDeviceId()
  assertTrue(first !== second, '两次生成不能相同')
  // 时间前缀（前 12 位十六进制）单调不减
  assertTrue(Number.parseInt(first.slice(0, 8), 16) <= Number.parseInt(second.slice(0, 8), 16), '时间前缀应单调')
})

check('loadIdentity：没有 localStorage 时返回 null（不崩）', () => {
  assertEqual(loadIdentity(), null, 'Node 环境无 localStorage')
})

check('identityFingerprint：12 位十六进制、稳定', () => {
  const identity = createIdentity()
  const first = identityFingerprint(identity.publicKey)
  assertTrue(/^[0-9A-F]{12}$/.test(first), `指纹形状：${first}`)
  assertEqual(identityFingerprint(identity.publicKey), first, '同一公钥指纹稳定')
  assertEqual(identityFingerprint('not-a-key'), 'unknown', '非法公钥回落')
})

/* ── Device Descriptor（docs/protocol.md §7） ─────────────────────────── */

check('deviceDescriptor(client)：字段集合固定，不含 harnessVersion', () => {
  const identity = createIdentity()
  const descriptor = deviceDescriptor('client', 'Chat Pad', 'web', identity)
  assertEqual(Object.keys(descriptor).sort(), ['clientVersion', 'deviceId', 'identityKey', 'name', 'platform', 'role'], '字段集合')
  assertEqual(descriptor.role, 'client', 'role')
  assertEqual(descriptor.deviceId, identity.deviceId, 'deviceId 用身份里的')
  assertEqual(descriptor.identityKey, identity.publicKey, 'identityKey')
  assertEqual(descriptor.platform, 'web', 'platform')
  assertTrue(!('harnessVersion' in descriptor), 'Client 禁止带 harnessVersion（§7:188）')
})

check('deviceDescriptor(host)：Host 分支 role=host', () => {
  const identity = createIdentity()
  const descriptor = deviceDescriptor('host', 'Workstation', 'linux', identity)
  assertEqual(descriptor.role, 'host', 'role')
})

check('name 清洗：空值给默认、超长按字节截到 ≤128', () => {
  assertEqual(sanitizeDeviceName('   '), 'Chat Pad', '空名字')
  assertEqual(sanitizeDeviceName(undefined), 'Chat Pad', 'undefined')
  assertEqual(sanitizeDeviceName('  我的平板  '), '我的平板', '去首尾空格')
  const long = '中'.repeat(100) // 每个字 3 字节 → 300 字节
  const cleaned = sanitizeDeviceName(long)
  assertTrue(new TextEncoder().encode(cleaned).length <= 128, '截断后必须 ≤128 字节')
  assertTrue(cleaned.length > 0, '截断后不能为空')
})

check('platform 清洗：必须匹配 [a-z0-9][a-z0-9._-]*，否则退回 web', () => {
  assertEqual(sanitizePlatform('WEB'), 'web', '大写转小写')
  assertEqual(sanitizePlatform('android.webview'), 'android.webview', '合法值保留')
  assertEqual(sanitizePlatform('linux/x86'), 'web', '斜杠不合法')
  assertEqual(sanitizePlatform('_x'), 'web', '不能以下划线开头')
  assertEqual(sanitizePlatform(''), 'web', '空值')
  assertEqual(sanitizePlatform(undefined), 'web', 'undefined')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
