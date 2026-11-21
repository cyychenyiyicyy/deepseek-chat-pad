/**
 * 工作区文件浏览 + 会话附件上传（W3）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/workspace-files.selftest.mts
 *
 * 覆盖任务书点名的四组：
 *   A. **路径拼接与安全**：归一化、拒绝 `..` / 绝对路径 / NUL / 控制字符、
 *      `resolveWorkspacePath` 越界抛错、`relativePathOf` / `isInsideRoot` 的 Windows 语义。
 *   B. **分块拼接**：`readBytes` 的参数形状（`workspaceFileScopeId` + `range{offset,length}`）、
 *      4 MiB 夹取、512 KiB 多块拼接后的字节序列与 `eof`、空块 / 超大块的协议校验、
 *      图片预览「分块读满 + 拒绝半张图」。
 *   C. **图片 MIME 判定**：四种魔术字节、扩展名与内容一致性、`fileKindOf` 的文本/图片/二进制分类。
 *   D. **上传 receiptId 流转**：请求体形状（`{agentId, request:{data,name}}`）、
 *      返回收据解析、缺 `receiptId` 必须是错误、30 MiB 上限本地先拦、进度三段、
 *      文件名消毒、Host 缺端点（`METHOD_NOT_FOUND`）判定。
 *   E. 补充：`list` / `stat` / `read` / `changes` 的解析与能力探测、`session/attachment`
 *      的老 Host 回退、`loadToolImage` 的 `uri` 直通与 `attachmentId` 补内容。
 *
 * 结尾按仓库约定设置真实退出码（`pnpm run type` 之外的一道闸）。
 */

import {
  readSessionAttachment,
  loadToolImage,
  readWorkspaceBytes,
  readWorkspaceBytesRange,
  readWorkspaceChanges,
  readWorkspaceImage,
  readWorkspaceText,
  listWorkspaceFiles,
  probeWorkspaceFiles,
  statWorkspaceFile,
  uploadSessionFile,
  encodeBase64,
  decodeBase64,
  concatBytes,
  sanitizeUploadName,
  normalizeRelativePath,
  rejectionOfRelativePath,
  resolveWorkspacePath,
  relativePathOf,
  isInsideRoot,
  parentRelativePath,
  joinRelativePath,
  baseNameOf,
  fileKindOf,
  sniffImageMime,
  resolveImageMime,
  decodeText,
  extensionOf,
  isMissingEndpoint,
  shouldFallbackToWorkspaceUpload,
  parseWorkspaceListing,
  parseWorkspaceByteChunk,
  parseWorkspaceTextPage,
  parseWorkspaceChanges,
  parseFileReceipt,
  clearToolImageCache,
  resetAttachmentSupport,
  MAX_READ_BYTES,
  READ_CHUNK_BYTES,
  type UploadProgress,
} from '../filesApi.js'
import { lastRemoteTarget, observeRemoteTarget, type RemoteCallTarget } from '../sessionsApi.js'
import { useRemoteStore } from '../store.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

const assertTrue = (value: unknown, label: string): void => {
  if (value !== true) fail(`${label}：期望 true，实际 ${JSON.stringify(value)}`)
}

const assertFalse = (value: unknown, label: string): void => {
  if (value !== false) fail(`${label}：期望 false，实际 ${JSON.stringify(value)}`)
}

const assertThrows = async (run: () => unknown | Promise<unknown>, label: string, code?: string): Promise<void> => {
  try {
    await run()
  } catch (error) {
    if (code === undefined) return
    const actual = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
    if (actual !== code) fail(`${label}：期望错误码 ${code}，实际 ${actual || '(无码)'}`)
    return
  }
  fail(`${label}：应当抛错，但没有抛`)
}

/* ── 内存版 localStorage（`store.ts` 启动时要读盘） ───────────────────── */

class MemoryStorage {
  private readonly data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

;(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage()

/* ── 假 target：记录每一次 `harness.remote.call` ─────────────────────── */

interface RecordedCall {
  method: string
  endpoint?: string
  args?: unknown
}

type Reply =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; message?: string }

interface FakeTarget {
  target: RemoteCallTarget
  calls: RecordedCall[]
}

const fakeTarget = (replies: Record<string, Reply | ((args: unknown, call: number) => Reply)> = {}): FakeTarget => {
  const calls: RecordedCall[] = []
  const seen = new Map<string, number>()
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'harness.remote.call') {
        calls.push({ method })
        return {} as T
      }
      const envelope = params as { endpoint: string; payload: { args: unknown } }
      const endpoint = envelope.endpoint
      const count = (seen.get(endpoint) ?? 0) + 1
      seen.set(endpoint, count)
      calls.push({ method, endpoint, args: envelope.payload.args })
      const configured = replies[endpoint]
      const reply: Reply = configured === undefined
        ? { ok: true, value: {} }
        : typeof configured === 'function' ? configured(envelope.payload.args, count) : configured
      if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
      return { ok: false, error: { code: reply.code, message: reply.message ?? reply.code } } as T
    },
    openStream: async () => {
      throw new Error('本自测不开流')
    },
  }
  return { target, calls }
}

const callAt = (fake: FakeTarget, index: number): RecordedCall => {
  const call = fake.calls[index]
  if (call === undefined) fail(`第 ${index} 次调用不存在（共 ${fake.calls.length} 次）`)
  return call
}

/** 把一条连接装进 store：`loadToolImage` 这类没有 target 入参的入口靠它。 */
const connect = (fake: FakeTarget): void => {
  observeRemoteTarget(fake.target)
  useRemoteStore.setState({ phase: 'ready' })
  if (lastRemoteTarget() !== fake.target) fail('连接目标没有登记成功')
}

/* ── 造字节 ───────────────────────────────────────────────────────────── */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 单调递增的字节序列（拼错顺序一眼能看出来）。 */
const ramp = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251
  return bytes
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

/* ══════════════════════════════════════════════════════════════════════
 * A. 路径拼接与安全
 * ══════════════════════════════════════════════════════════════════════ */

check('A1：相对路径归一化（去 ./、压重复分隔符、统一 /）', async () => {
  assertEqual(normalizeRelativePath('src/a.ts'), 'src/a.ts', '普通路径')
  assertEqual(normalizeRelativePath('./src//a.ts/'), 'src/a.ts', '点前缀 + 重复分隔符 + 尾随')
  assertEqual(normalizeRelativePath('src\\nested\\b.ts'), 'src/nested/b.ts', 'Windows 分隔符')
  assertEqual(normalizeRelativePath('a/./b'), 'a/b', '中间的点段')
})

check('A2：拒绝越界与非法路径（`..` / 绝对 / NUL / 控制字符）', async () => {
  assertEqual(rejectionOfRelativePath('../etc/passwd'), 'parent', '开头就是 ..')
  assertEqual(rejectionOfRelativePath('a/../../b'), 'parent', '中间夹 .. 也不归一化放行')
  assertEqual(rejectionOfRelativePath('a/..'), 'parent', '结尾 ..')
  assertEqual(rejectionOfRelativePath('/etc/passwd'), 'absolute', 'POSIX 绝对路径')
  assertEqual(rejectionOfRelativePath('C:\\Windows\\win.ini'), 'absolute', 'Windows 盘符')
  assertEqual(rejectionOfRelativePath('\\\\host\\share\\x'), 'absolute', 'UNC')
  assertEqual(rejectionOfRelativePath('a\u0000b'), 'nul', 'NUL')
  assertEqual(rejectionOfRelativePath('a\u0007b'), 'control', '控制字符')
  assertEqual(rejectionOfRelativePath(''), 'empty', '空串')
  assertEqual(rejectionOfRelativePath('./'), 'empty', '只有分隔符 / 只有点')
  assertEqual(rejectionOfRelativePath('中文/目录/a.md'), null, '中文路径合法')
  assertEqual(normalizeRelativePath('.'), '', '点归一成空串（= 根）')
  await assertThrows(() => normalizeRelativePath('../x'), 'normalize 拒绝 ..', 'WORKSPACE_PATH_INVALID')
  await assertThrows(() => normalizeRelativePath('/abs'), 'normalize 拒绝绝对路径', 'WORKSPACE_PATH_INVALID')
})

check('A3：resolveWorkspacePath 拼接（POSIX / Windows）与越界拒绝', async () => {
  assertEqual(resolveWorkspacePath('/home/me/code', 'src/a.ts'), '/home/me/code/src/a.ts', 'POSIX 拼接')
  assertEqual(resolveWorkspacePath('/home/me/code/', 'src'), '/home/me/code/src', '尾随分隔符不叠两层')
  assertEqual(resolveWorkspacePath('C:\\code', 'src\\a.ts'), 'C:\\code\\src\\a.ts', 'Windows 反斜杠拼接')
  assertEqual(resolveWorkspacePath('/home/me/code', ''), '/home/me/code', '相对路径为空 = 根本身')
  assertTrue(isInsideRoot('/home/me/code', resolveWorkspacePath('/home/me/code', 'a')), '拼出来的路径在根内')
  assertFalse(isInsideRoot('/home/me/code', '/home/me/codex/a'), '同前缀但不是子目录')
  await assertThrows(() => resolveWorkspacePath('/home/me/code', '../evil'), '根外路径必须抛', 'WORKSPACE_PATH_INVALID')
})

check('A4：relativePathOf / parentRelativePath / joinRelativePath / baseNameOf', async () => {
  assertEqual(relativePathOf('/home/me/code', '/home/me/code/src/a.ts'), 'src/a.ts', '根内取相对')
  assertEqual(relativePathOf('/home/me/code', '/home/me/code'), '', '根自己 → 空串')
  assertEqual(relativePathOf('/home/me/code', '/home/me/other/a.ts'), null, '根外 → null')
  assertEqual(relativePathOf('C:\\code', 'c:\\code\\src\\a.ts'), 'src/a.ts', 'Windows 大小写不敏感')
  assertEqual(parentRelativePath('src/deep/a.ts'), 'src/deep', '上一级')
  assertEqual(parentRelativePath('a.ts'), '', '顶层文件的上一级是根')
  assertEqual(parentRelativePath(''), '', '根本身还是根')
  assertEqual(joinRelativePath('', 'a.ts'), 'a.ts', '根下拼')
  assertEqual(joinRelativePath('src', 'a.ts'), 'src/a.ts', '子目录拼')
  assertEqual(joinRelativePath('src/', '/a.ts'), 'src/a.ts', '两侧分隔符都清')
  assertEqual(baseNameOf('src/deep/a.ts'), 'a.ts', '末段')
  assertEqual(baseNameOf(''), '', '根没有末段')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 分块拼接
 * ══════════════════════════════════════════════════════════════════════ */

check('B1：readWorkspaceBytes 的参数包装与 base64 解码', async () => {
  const payload = bytesOf('hello 世界')
  const fake = fakeTarget({
    'workspaceFiles/readBytes': {
      ok: true,
      value: { absolutePath: '/w/a.txt', version: 'v1', bytes: payload.byteLength, offset: 0, eof: true, data: base64Of(payload) },
    },
  })
  const chunk = await readWorkspaceBytes(fake.target, 's-1', 'a.txt', 0, 4096)
  const call = callAt(fake, 0)
  assertEqual(call.endpoint, 'workspaceFiles/readBytes', '端点')
  assertEqual(call.args, { workspaceFileScopeId: 's-1', path: 'a.txt', range: { offset: 0, length: 4096 } }, 'args 形状')
  assertEqual([...chunk.data], [...payload], 'base64 还原字节')
  assertTrue(chunk.eof, 'eof')
  assertEqual(chunk.totalBytes, payload.byteLength, '总长')
  assertEqual(chunk.version, 'v1', '版本')
})

check('B2：readWorkspaceBytes 把 length 夹到 4 MiB，坏参数直接拒', async () => {
  const fake = fakeTarget({
    'workspaceFiles/readBytes': { ok: true, value: { offset: 0, eof: false, data: base64Of(new Uint8Array(4)) } },
  })
  await readWorkspaceBytes(fake.target, 's-1', 'a.bin', 0, 9 * 1024 * 1024)
  assertEqual((callAt(fake, 0).args as { range: { length: number } }).range.length, MAX_READ_BYTES, '夹到 4 MiB')
  await assertThrows(() => readWorkspaceBytes(fake.target, 's-1', 'a.bin', 0, 0), 'length=0 应抛', 'INVALID_ARGUMENT')
  await assertThrows(() => readWorkspaceBytes(fake.target, 's-1', 'a.bin', 0, -5), 'length<0 应抛', 'INVALID_ARGUMENT')
})

check('B3：readWorkspaceBytesRange 按 512 KiB 分块并拼回原始序列', async () => {
  const total = READ_CHUNK_BYTES * 3 + 17
  const source = ramp(total)
  const fake = fakeTarget({
    'workspaceFiles/readBytes': (args) => {
      const range = (args as { range: { offset: number; length: number } }).range
      const slice = source.subarray(range.offset, range.offset + range.length)
      const eof = range.offset + slice.byteLength >= total
      return {
        ok: true,
        value: { offset: range.offset, eof, bytes: total, data: base64Of(slice) },
      }
    },
  })
  const result = await readWorkspaceBytesRange(fake.target, 's-1', 'big.bin', 0, total)
  assertEqual(result.data.byteLength, total, '拼出来的总长')
  assertTrue(result.eof, '读到结尾')
  assertEqual([...result.data.subarray(0, 8)], [...source.subarray(0, 8)], '头 8 字节一致')
  assertEqual([...result.data.subarray(total - 8)], [...source.subarray(total - 8)], '尾 8 字节一致')
  // 512 KiB 一块 → 4 块（最后一块 17 字节）
  assertEqual(fake.calls.length, 4, '分块次数')
  assertEqual((callAt(fake, 0).args as { range: { length: number } }).range.length, READ_CHUNK_BYTES, '第一块 512 KiB')
})

check('B4：readWorkspaceBytesRange 到 limit 就停（eof=false 时不越读）', async () => {
  const source = ramp(1000)
  const fake = fakeTarget({
    'workspaceFiles/readBytes': (args) => {
      const range = (args as { range: { offset: number; length: number } }).range
      const slice = source.subarray(range.offset, range.offset + range.length)
      return { ok: true, value: { offset: range.offset, eof: range.offset + slice.byteLength >= source.byteLength, data: base64Of(slice) } }
    },
  })
  const result = await readWorkspaceBytesRange(fake.target, 's-1', 'a.bin', 0, 100, { chunkBytes: 64 })
  assertEqual(result.data.byteLength, 100, '只读到 limit')
  assertFalse(result.eof, '没到结尾')
  assertEqual(fake.calls.length, 2, '两块 64 → 64+36')
})

check('B5：分块解析的协议校验（空块 / 超大块）', async () => {
  await assertThrows(
    () => Promise.resolve(parseWorkspaceByteChunk({ offset: 0, eof: false, data: '' }, { offset: 0, length: 16 })),
    '空块且非 eof 应拒',
    'INVALID_RESPONSE',
  )
  await assertThrows(
    () => Promise.resolve(parseWorkspaceByteChunk({ offset: 0, eof: true, data: base64Of(ramp(64)) }, { offset: 0, length: 8 })),
    '分块比请求的还大应拒',
    'INVALID_RESPONSE',
  )
  await assertThrows(
    () => Promise.resolve(parseWorkspaceByteChunk({ offset: 0, eof: true }, { offset: 0, length: 8 })),
    '缺 data 应拒',
    'INVALID_RESPONSE',
  )
  // Gateway 可能把 data 还原成字节数组（不是 base64）
  const asBytes = parseWorkspaceByteChunk({ offset: 4, eof: true, data: ramp(8) }, { offset: 4, length: 8 })
  assertEqual(asBytes.data.byteLength, 8, '字节数组形态也认')
})

check('B6：concatBytes / encodeBase64 / decodeBase64 往返', async () => {
  const a = bytesOf('abc')
  const b = bytesOf('中文')
  const merged = concatBytes([a, b])
  assertEqual(decodeText(merged), 'abc中文', '拼接顺序')
  assertEqual(merged.byteLength, a.byteLength + b.byteLength, '总长')
  const long = ramp(70_000)
  assertEqual([...decodeBase64(encodeBase64(long))], [...long], '70 KB 往返（跨 0x8000 分片）')
})

check('B7：文本分块累加（256 KiB 首屏 + 续读）用原始字节拼，偏移不漂', async () => {
  // 结尾放一个多字节字符，验证「分块切开」后整体重解不会出半个字
  const expected = `${'a'.repeat(300)}中文结尾`
  const source = bytesOf(expected)
  const fake = fakeTarget({
    'workspaceFiles/readBytes': (args) => {
      const range = (args as { range: { offset: number; length: number } }).range
      const slice = source.subarray(range.offset, range.offset + range.length)
      return {
        ok: true,
        value: {
          offset: range.offset,
          eof: range.offset + slice.byteLength >= source.byteLength,
          bytes: source.byteLength,
          data: base64Of(slice),
        },
      }
    },
  })
  // 模拟界面：首屏读 100 字节，之后每次从「已读字节数」续读，直到 eof
  let merged = new Uint8Array(0)
  let eof = false
  while (!eof) {
    const range = await readWorkspaceBytesRange(fake.target, 's-1', 'a.txt', merged.byteLength, 100)
    const next = new Uint8Array(merged.byteLength + range.data.byteLength)
    next.set(merged, 0)
    next.set(range.data, merged.byteLength)
    merged = next
    eof = range.eof
    const offsets = fake.calls.map((call) => (call.args as { range: { offset: number } }).range.offset)
    assertEqual(offsets[offsets.length - 1], merged.byteLength - range.data.byteLength, '每次续读的字节偏移')
  }
  assertEqual(decodeText(merged), expected, '分块累加后的正文')
  assertEqual(merged.byteLength, source.byteLength, '字节数一致')
  // 多字节字符被 100 字节边界切开时，单块解码不该影响整体结果
  assertEqual(decodeText(source.subarray(0, 100)).endsWith('\ufffd'), false, '边界内没有半个汉字')
})

check('B8：图片预览走分块；超限 / 半张图 / 非图片都要拒', async () => {
  const image = new Uint8Array(READ_CHUNK_BYTES + 32)
  image.set(PNG_BYTES, 0)
  const fake = fakeTarget({
    'workspaceFiles/stat': { ok: true, value: { absolutePath: '/w/a.png', version: 'v1', bytes: image.byteLength } },
    'workspaceFiles/readBytes': (args) => {
      const range = (args as { range: { offset: number; length: number } }).range
      const slice = image.subarray(range.offset, range.offset + range.length)
      return { ok: true, value: { offset: range.offset, eof: range.offset + slice.byteLength >= image.byteLength, bytes: image.byteLength, data: base64Of(slice) } }
    },
  })
  const preview = await readWorkspaceImage(fake.target, 's-1', 'a.png')
  assertEqual(preview.mimeType, 'image/png', 'MIME 判定')
  assertEqual(preview.bytes.byteLength, image.byteLength, '分两块拼满')
  assertFalse(preview.truncated, '不是半张图')

  const tooLarge = fakeTarget({
    'workspaceFiles/stat': { ok: true, value: { absolutePath: '/w/big.png', version: 'v1', bytes: 20 * 1024 * 1024 } },
  })
  await assertThrows(
    () => readWorkspaceImage(tooLarge.target, 's-1', 'big.png'),
    '超大图片应拒',
    'WORKSPACE_IMAGE_TOO_LARGE',
  )
  assertEqual(tooLarge.calls.length, 1, '被 stat 挡住，不再去读字节')

  const fakeText = fakeTarget({
    'workspaceFiles/stat': { ok: true, value: { absolutePath: '/w/a.png', version: 'v1', bytes: 16 } },
    'workspaceFiles/readBytes': { ok: true, value: { offset: 0, eof: true, data: base64Of(bytesOf('not an image!!')) } },
  })
  await assertThrows(
    () => readWorkspaceImage(fakeText.target, 's-1', 'a.png'),
    '内容不是图片应拒',
    'WORKSPACE_IMAGE_UNSUPPORTED',
  )
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 图片 MIME 判定与文件分类
 * ══════════════════════════════════════════════════════════════════════ */

check('C1：四种图片魔术字节都能认出来；别的返回 null', async () => {
  assertEqual(sniffImageMime(PNG_BYTES), 'image/png', 'PNG')
  assertEqual(sniffImageMime(JPEG_BYTES), 'image/jpeg', 'JPEG')
  assertEqual(sniffImageMime(GIF_BYTES), 'image/gif', 'GIF')
  assertEqual(sniffImageMime(WEBP_BYTES), 'image/webp', 'WebP')
  assertEqual(sniffImageMime(bytesOf('%PDF-1.7')), null, 'PDF 不是图片')
  assertEqual(sniffImageMime(new Uint8Array(0)), null, '空字节')
})

check('C2：扩展名与内容必须一致（不一致拒绝画破图）', async () => {
  assertEqual(resolveImageMime('a.png', PNG_BYTES), 'image/png', 'png 对 png')
  assertEqual(resolveImageMime('A.PNG', PNG_BYTES), 'image/png', '大写扩展名')
  assertEqual(resolveImageMime('a.jpg', JPEG_BYTES), 'image/jpeg', 'jpeg')
  assertEqual(resolveImageMime('a.png', JPEG_BYTES), null, 'png 扩展名 + jpeg 内容 → null')
  assertEqual(resolveImageMime('a.svg', PNG_BYTES), null, '不支持的扩展名 → null')
  assertEqual(resolveImageMime('noext', WEBP_BYTES), 'image/webp', '没有扩展名就信内容')
})

check('C3：fileKindOf / extensionOf / decodeText', async () => {
  assertEqual(fileKindOf('a.md'), 'text', 'md 是文本')
  assertEqual(fileKindOf('a.tsx'), 'text', 'tsx 是文本')
  assertEqual(fileKindOf('a.png'), 'image', 'png 是图片')
  assertEqual(fileKindOf('a.pdf'), 'binary', 'pdf 归二进制（占位）')
  assertEqual(fileKindOf('a.zip'), 'binary', '压缩包二进制')
  assertEqual(fileKindOf('README'), 'text', 'README 无扩展名也算文本')
  assertEqual(fileKindOf('Makefile'), 'text', 'Makefile')
  assertEqual(fileKindOf('bin.dat'), 'binary', '未知扩展名')
  assertEqual(extensionOf('src/a.TS'), 'ts', '扩展名小写')
  assertEqual(extensionOf('README'), undefined, '没有扩展名')
  assertEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a', '去 BOM')
  assertEqual(decodeText(new Uint8Array([0xe4, 0xb8])), '\ufffd', '半个汉字 → 替换字符（不抛）')
})

/* ══════════════════════════════════════════════════════════════════════
 * D. 上传 receiptId 流转
 * ══════════════════════════════════════════════════════════════════════ */

check('D1：uploadSessionFile 的请求形状与收据解析', async () => {
  const bytes = bytesOf('hello 附件')
  const fake = fakeTarget({
    'fileUploads/upload': { ok: true, value: { receiptId: 'rcpt-1', file: { name: 'a.txt', bytes: bytes.byteLength, mediaType: 'text/plain' } } },
  })
  const receipt = await uploadSessionFile(fake.target, 's-1', { name: 'docs/a.txt', bytes, mediaType: 'text/plain' })
  const call = callAt(fake, 0)
  assertEqual(call.endpoint, 'fileUploads/upload', '端点')
  const args = call.args as { agentId: string; request: { data: string; name: string } }
  assertEqual(args.agentId, 's-1', 'agentId 就是会话 id')
  assertEqual(Object.keys(args).sort(), ['agentId', 'request'], '只这两层，别多包一层 request')
  assertEqual(args.request.name, 'a.txt', '文件名消毒后只剩末段')
  assertEqual(args.request.data, base64Of(bytes), 'data 是标准 base64')
  assertEqual(receipt.receiptId, 'rcpt-1', 'receiptId')
  assertEqual(receipt.name, 'a.txt', '回显文件名')
})

check('D2：缺 receiptId 是错误（不能假装成功），本地先拦 30 MiB', async () => {
  const fake = fakeTarget({ 'fileUploads/upload': { ok: true, value: { file: { name: 'a.txt' } } } })
  await assertThrows(
    () => uploadSessionFile(fake.target, 's-1', { name: 'a.txt', bytes: bytesOf('x') }),
    '缺 receiptId 应抛',
    'INVALID_RESPONSE',
  )
  const empty = fakeTarget({})
  await assertThrows(
    () => uploadSessionFile(empty.target, 's-1', { name: 'a.txt', bytes: new Uint8Array(0) }),
    '空文件应抛',
    'INVALID_ARGUMENT',
  )
  // 31 MiB：本地就拦，不发请求
  const huge = new Uint8Array(31 * 1024 * 1024)
  const big = fakeTarget({})
  await assertThrows(() => uploadSessionFile(big.target, 's-1', { name: 'big.bin', bytes: huge }), '超过 30 MiB 应抛', 'UPLOAD_TOO_LARGE')
  assertEqual(big.calls.length, 0, '超限不发请求')
})

check('D3：进度三段（encoding → uploading → done）且百分比单调', async () => {
  const bytes = ramp(1024 * 1024 * 2 + 512)
  const fake = fakeTarget({ 'fileUploads/upload': { ok: true, value: { receiptId: 'rcpt-2' } } })
  const events: UploadProgress[] = []
  await uploadSessionFile(fake.target, 's-1', { name: 'big.bin', bytes }, {
    onProgress: (progress) => events.push(progress),
  })
  const phases = [...new Set(events.map((event) => event.phase))]
  assertEqual(phases, ['encoding', 'uploading', 'done'], '阶段顺序')
  const encoding = events.filter((event) => event.phase === 'encoding')
  assertTrue(encoding.length >= 2, '2.5 MiB 至少编码两拍')
  assertEqual(encoding[encoding.length - 1]?.sentBytes, bytes.byteLength, '编码最后一拍等于总长')
  assertEqual(events[events.length - 1]?.phase, 'done', '最后是 done')
})

check('D4：文件名消毒（去目录 / 控制字符 / 前导点）', async () => {
  assertEqual(sanitizeUploadName('a/b/c.txt'), 'c.txt', 'POSIX 目录')
  assertEqual(sanitizeUploadName('C:\\tmp\\d.txt'), 'd.txt', 'Windows 目录')
  assertEqual(sanitizeUploadName('..hidden'), 'hidden', '前导点去掉')
  assertEqual(sanitizeUploadName('bad\u0000name.txt'), 'badname.txt', '控制字符')
  assertEqual(sanitizeUploadName('   '), 'file', '全是空白 → 兜底名')
  assertEqual(sanitizeUploadName('x'.repeat(400)).length, 200, '长度封顶')
})

check('D5：Host 缺 upload 端点 → 可判定的错误（R15：降级判据，不再据此收「+」）', async () => {
  const fake = fakeTarget({ 'fileUploads/upload': { ok: false, code: 'METHOD_NOT_FOUND' } })
  let caught: unknown
  try {
    await uploadSessionFile(fake.target, 's-1', { name: 'a.txt', bytes: bytesOf('x') })
  } catch (error) {
    caught = error
  }
  assertTrue(isMissingEndpoint(caught), 'METHOD_NOT_FOUND 仍认成「缺端点」（读取类端点用）')
  assertTrue(shouldFallbackToWorkspaceUpload(caught), '但**上传**要把它当「换通道」的信号')
  // 0.5.22 实测就是这一个码：不在 allowlist → METHOD_NOT_ALLOWED
  assertTrue(
    shouldFallbackToWorkspaceUpload(Object.assign(new Error('x'), { code: 'METHOD_NOT_ALLOWED' })),
    'METHOD_NOT_ALLOWED 也要降级',
  )
  assertTrue(shouldFallbackToWorkspaceUpload(Object.assign(new Error('x'), { code: '405' })), '405 也要降级')
  assertFalse(isMissingEndpoint(Object.assign(new Error('x'), { code: 'UPLOAD_LIMIT' })), 'UPLOAD_LIMIT 不是缺端点')
  assertFalse(shouldFallbackToWorkspaceUpload(Object.assign(new Error('x'), { code: 'UPLOAD_LIMIT' })), '配额错不降级')
  assertFalse(shouldFallbackToWorkspaceUpload(Object.assign(new Error('x'), { code: 'RPC_TIMEOUT' })), '超时不降级')
})

/* ══════════════════════════════════════════════════════════════════════
 * E. 列目录 / stat / read / changes / 附件 / 工具卡图片
 * ══════════════════════════════════════════════════════════════════════ */

check('E1：listWorkspaceFiles 的参数与宽容解析（根传 "."）', async () => {
  const fake = fakeTarget({
    'workspaceFiles/list': {
      ok: true,
      value: {
        path: '.',
        entries: [
          { name: 'src', type: 'directory' },
          { name: 'a.md', type: 'file', size: 12 },
          { name: 'link', type: 'symlink' },
          { name: 'weird' },
          { bogus: true },
        ],
        truncated: true,
      },
    },
  })
  const listing = await listWorkspaceFiles(fake.target, 's-1')
  assertEqual(callAt(fake, 0).args, { workspaceFileScopeId: 's-1', path: '.' }, '根目录用 "."')
  assertEqual(listing.entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.md', type: 'file', size: 12 },
    { name: 'link', type: 'other' },
    { name: 'weird', type: 'file' },
  ], '类型归一 + 坏行丢弃')
  assertTrue(listing.truncated, 'truncated')

  await listWorkspaceFiles(fake.target, 's-1', './src/')
  assertEqual((callAt(fake, 1).args as { path: string }).path, 'src', '子目录归一化')
  // 裸数组形态（老 Host）
  assertEqual(parseWorkspaceListing([{ name: 'x', type: 'dir' }], '.').entries, [{ name: 'x', type: 'directory' }], '裸数组也认')
})

check('E2：probeWorkspaceFiles 三态（支持 / 缺端点 / 其它错误原样抛）', async () => {
  const ok = fakeTarget({ 'workspaceFiles/list': { ok: true, value: { path: '.', entries: [{ name: 'a', type: 'file' }] } } })
  const supported = await probeWorkspaceFiles(ok.target, 's-1')
  assertTrue(supported.supported, '支持')
  assertEqual(supported.supported ? supported.listing.entries.length : -1, 1, '顺手带回根目录')

  const missing = fakeTarget({ 'workspaceFiles/list': { ok: false, code: 'METHOD_NOT_FOUND' } })
  const unsupported = await probeWorkspaceFiles(missing.target, 's-1')
  assertFalse(unsupported.supported, '缺端点 → 不支持')
  assertEqual(unsupported.supported ? '' : unsupported.reason, 'METHOD_NOT_FOUND', '原因码')

  const denied = fakeTarget({ 'workspaceFiles/list': { ok: false, code: 'PERMISSION_DENIED' } })
  await assertThrows(() => probeWorkspaceFiles(denied.target, 's-1'), '权限错误不能当成「不支持」', 'PERMISSION_DENIED')
})

check('E3：stat / read / changes 的解析', async () => {
  const fake = fakeTarget({
    'workspaceFiles/stat': { ok: true, value: { absolutePath: '/w/a.md', version: 'v9', bytes: 321 } },
    'workspaceFiles/read': { ok: true, value: { absolutePath: '/w/a.md', version: 'v9', text: 'a\nb', offset: 1, lines: 2, eof: false } },
    'workspaceFiles/changes': { ok: true, value: { path: '.', version: 'v9', changes: [{ path: 'src', kind: 'modified', version: 'v9' }, { nope: 1 }] } },
  })
  const stat = await statWorkspaceFile(fake.target, 's-1', 'a.md')
  assertEqual(stat, { absolutePath: '/w/a.md', version: 'v9', bytes: 321 }, 'stat')
  const page = await readWorkspaceText(fake.target, 's-1', 'a.md', 1, 200)
  assertEqual(callAt(fake, 1).args, { workspaceFileScopeId: 's-1', path: 'a.md', range: { offset: 1, limit: 200 } }, 'read 的行页参数')
  assertEqual(page.text, 'a\nb', 'read 正文')
  assertEqual(page.offset, 1, 'read 行号从 1 起')
  const changes = await readWorkspaceChanges(fake.target, 's-1')
  assertEqual(changes.changes, [{ path: 'src', kind: 'modified', version: 'v9' }], 'changes 过滤坏行')
  assertEqual(parseWorkspaceChanges({ entries: [{ path: 'x' }] }, '.').changes, [{ path: 'x' }], 'entries 形态也认')
  assertEqual(parseWorkspaceTextPage({ text: 'x', lines: 1 }, 7).offset, 7, '缺 offset 用请求值兜底')
  assertEqual(parseFileReceipt({ receiptId: 'r' }), { receiptId: 'r' }, '最小收据')
})

check('E4：session/attachment 先试完整引用、被严格 codec 拒了就退回 attachmentId', async () => {
  resetAttachmentSupport()
  const bytes = PNG_BYTES
  const fake = fakeTarget({
    'session/attachment': (args) => {
      const request = (args as { request: { attachment?: unknown; attachmentId?: string } }).request
      if (request.attachment !== undefined) return { ok: false, code: 'gateway/arguments-invalid' }
      return { ok: true, value: { attachment: { attachmentId: 'att-1', mediaType: 'image/png' }, data: base64Of(bytes) } }
    },
  })
  const attachment = await readSessionAttachment(fake.target, 's-1', { attachmentId: 'att-1', name: 'a.png' })
  assertEqual(attachment.mimeType, 'image/png', 'MIME')
  assertEqual([...attachment.data], [...bytes], '字节')
  assertEqual(fake.calls.length, 2, '先完整引用、再退回 attachmentId')
  assertEqual(
    (callAt(fake, 1).args as { request: Record<string, unknown> }).request,
    { sessionId: 's-1', attachmentId: 'att-1' },
    '退路参数形状',
  )
  // 第二次（同一条连接）直接用退路，不再多打一次
  await readSessionAttachment(fake.target, 's-1', { attachmentId: 'att-1', name: 'a.png' })
  assertEqual(fake.calls.length, 3, '记住不支持后只打一次')
  resetAttachmentSupport()

  const broken = fakeTarget({ 'session/attachment': { ok: true, value: { attachment: {} } } })
  await assertThrows(
    () => readSessionAttachment(broken.target, 's-1', 'att-2'),
    '没有 data 应抛',
    'INVALID_RESPONSE',
  )
  await assertThrows(
    () => readSessionAttachment(broken.target, 's-1', {}),
    '没有 attachmentId 应抛',
    'INVALID_ARGUMENT',
  )
})

check('E5：loadToolImage —— uri 直通；只有 attachmentId 时补出 data URL 并缓存', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({
    'session/attachment': { ok: true, value: { attachment: { attachmentId: 'att-9', mediaType: 'image/png' }, data: base64Of(PNG_BYTES) } },
  })
  connect(fake)

  assertEqual(await loadToolImage({ uri: 'data:image/png;base64,AAA' }), 'data:image/png;base64,AAA', 'uri 直通')
  assertEqual(fake.calls.length, 0, 'uri 直通不发请求')

  const url = await loadToolImage({ attachmentId: 'att-9', sessionId: 's-1', mediaType: 'image/png' })
  assertEqual(url, `data:image/png;base64,${base64Of(PNG_BYTES)}`, 'attachmentId → data URL')
  const before = fake.calls.length
  assertEqual(await loadToolImage({ attachmentId: 'att-9', sessionId: 's-1' }), url, '第二次命中缓存')
  assertEqual(fake.calls.length, before, '缓存命中不再发请求')

  assertEqual(await loadToolImage({ name: 'nope' }), null, '既没有 uri 也没有 attachmentId → null')
  assertEqual(await loadToolImage({ attachmentId: 'att-x' }), null, '没有会话作用域 → null')

  // 断开后没有连接：要抛而不是静默返回空图
  useRemoteStore.setState({ phase: 'idle' })
  await assertThrows(
    () => loadToolImage({ attachmentId: 'att-new', sessionId: 's-1' }),
    '没连上应抛',
    'REMOTE_NOT_READY',
  )
  clearToolImageCache()
  resetAttachmentSupport()
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const describeDuration = (startedAt: number): string => `  (${Date.now() - startedAt}ms)`

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}${describeDuration(startedAt)}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}${describeDuration(startedAt)}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
