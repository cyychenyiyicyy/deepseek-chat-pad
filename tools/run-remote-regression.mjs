// 远程 DSH 自测总入口：把 web/src 下所有 *.selftest.mts 逐个跑一遍，任何一套非零退出即整体失败。
//
// 用法：
//   node tools/run-remote-regression.mjs           # 全部
//   node tools/run-remote-regression.mjs terminal  # 只跑文件名含 terminal 的
//
// 用 web/ 里已经装好的 tsx 执行（.mts / .ts 以及 `./x.js → x.ts` 的解析都由它负责），
// 不依赖 `--experimental-transform-types`，所以本地 Node 和 CI Node 版本不一致也不会翻车。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const tools = import.meta.dirname
const root = path.resolve(tools, '../web/src')
const filter = process.argv[2] ?? ''
const reports = process.env.SELFTEST_REPORT_DIR
  ? path.resolve(process.env.SELFTEST_REPORT_DIR)
  : path.join(path.resolve(tools, '..'), 'tmp', 'remote-regression')
const tsxCli = path.resolve(tools, '../web/node_modules/tsx/dist/cli.mjs')

if (!fs.existsSync(tsxCli)) {
  console.error('[FAIL] 找不到 tsx：先在 web/ 里执行 pnpm install')
  process.exit(1)
}

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
  const result = spawnSync(process.execPath, [tsxCli, filename],
    { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120_000 })
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
