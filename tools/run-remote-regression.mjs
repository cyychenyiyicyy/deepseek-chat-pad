// 远程 DSH 自测总入口：把 web/src 下所有 *.selftest.mts 逐个跑一遍，任何一套非零退出即整体失败。
//
// 用法：
//   node tools/run-remote-regression.mjs           # 全部
//   node tools/run-remote-regression.mjs terminal  # 只跑文件名含 terminal 的
//
// 依赖 Node >= 22.7（--experimental-transform-types 做类型擦除）；CI 用 Node 22。
// 每套的原始输出写在 tmp/remote-regression/<文件名>.log，失败时打印尾部 1400 字。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const tools = import.meta.dirname
const root = path.resolve(tools, '../web/src')
const filter = process.argv[2] ?? ''
const reports = process.env.SELFTEST_REPORT_DIR
  ? path.resolve(process.env.SELFTEST_REPORT_DIR)
  : path.join(path.resolve(tools, '..'), 'tmp', 'remote-regression')

// --experimental-transform-types 从 Node 22.7 起才有；低于这个版本直接给出可读的失败原因。
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 7)) {
  console.error(`[FAIL] 当前 Node ${process.version} 不支持 --experimental-transform-types，需要 Node >= 22.7`)
  process.exit(1)
}

// 源码里 import './x.js' 指向 TypeScript 的 x.ts：用 resolve 钩子把后缀换成 .ts。
const loader = [
  "import { registerHooks } from 'node:module';",
  'registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    try { return nextResolve(specifier, context) }',
  '    catch (error) {',
  "      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js'))",
  "        return nextResolve(specifier.slice(0, -3) + '.ts', context)",
  '      throw error',
  '    }',
  '  },',
  '});',
].join('\n')

const collect = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const filename = path.join(folder, entry.name)
  if (entry.isDirectory()) return collect(filename)
  return entry.name.endsWith('.selftest.mts') && entry.name.includes(filter) ? [filename] : []
})

const tests = [
  ...collect(path.join(root, 'services/remote')),
  ...collect(path.join(root, 'components/remote')),
].sort()

if (tests.length === 0) {
  console.error(`[FAIL] 在 ${root} 下没有找到匹配的 *.selftest.mts`)
  process.exit(1)
}

fs.mkdirSync(reports, { recursive: true })

// 上次的报告先清掉：脚本崩在半路时旧结论会留在磁盘上，读起来和新的一样。
for (const file of fs.readdirSync(reports)) {
  if (file.endsWith('.log')) fs.rmSync(path.join(reports, file), { force: true })
}

let failed = 0
for (const filename of tests) {
  const report = path.join(reports, path.basename(filename) + '.log')
  const fd = fs.openSync(report, 'w')
  // 用文件描述符而不是管道：沙箱里管道会 EPERM（见 AGENTS.md 第 4 条）。
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    '--import', 'data:text/javascript,' + encodeURIComponent(loader),
    filename,
  ], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120_000 })
  fs.closeSync(fd)
  const logs = fs.readFileSync(report, 'utf8').trim()
  const passed = result.status === 0 && !/^\[FAIL\]/m.test(logs)
  if (!passed) failed++
  const summary = logs.split('\n').filter((line) => /pass|passed|ok/i.test(line.trim())).at(-1) ?? ''
  console.log((passed ? '[PASS] ' : '[FAIL] ') + path.basename(filename) + ' ' + summary)
  if (!passed) console.log(result.error?.message ?? logs.slice(-1400))
}

console.log((tests.length - failed) + '/' + tests.length + ' suites passed')
console.log('报告目录：' + path.relative(process.cwd(), reports))
process.exitCode = failed ? 1 : 0
