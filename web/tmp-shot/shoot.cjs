/**
 * [S3] 出图：把 `tmp-shot/dist` 起个静态服务，用无头浏览器一屏一张截下来。
 *
 * 用法（workdir = projects\deepseek-tablet\web）：
 *   node tmp-shot/shoot.cjs                    # 先构建再截图
 *   node tmp-shot/shoot.cjs --no-build         # 只截图（dist 已是最新）
 *
 * 三张图（写进任务目录，命名按任务书）：
 *   live-session-list.png     两个在跑 + 一个待审批
 *   live-composer-stop.png    运行中 + 输入框为空 → 主按钮是停止
 *   live-composer-send.png    运行中 + 输入框有字 → 主按钮是发送、停止让到第二颗钮
 *
 * 纪律（与 `tools/check-web-boot.cjs` 同一套）：
 *   - 起服务与截图必须在**同一个进程**里用异步 spawn（同步 spawn 会阻塞事件循环，
 *     静态服务就在本进程，浏览器会一直等不到响应）；
 *   - 子进程输出走文件描述符，**不要**用管道捕获（这个环境的 EPERM 会弹系统错误框）；
 *   - 打不开的图（0 字节）要判失败，不能只看退出码。
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const DIST = path.join(HERE, 'dist')
const PORT = 18771
/** 截图输出目录：任务目录（与其它批次一致） */
const OUT = path.resolve(ROOT, '..', '..', '..', 'work', '2026-11-21-chatpad接入DSH远程')

const SHOTS = [
  { name: 'live-session-list.png', query: 'list', width: 420, height: 560 },
  { name: 'live-composer-stop.png', query: 'stop', width: 420, height: 260 },
  { name: 'live-composer-send.png', query: 'send', width: 420, height: 260 },
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const fail = (message) => {
  console.error(`[FAIL] ${message}`)
  process.exit(1)
}

const findBrowser = () => {
  const list = []
  if (process.env.CHROME_BIN) list.push(process.env.CHROME_BIN)
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    )
  } else {
    list.push('google-chrome', 'chromium', 'chromium-browser')
  }
  return list.find((item) => (item.includes(path.sep) ? fs.existsSync(item) : false))
}

const build = () => {
  console.log('[shot] 构建截图页…')
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['rspack', 'build', '-c', 'tmp-shot/rspack.shot.config.ts'],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' },
  )
  if (result.status !== 0) fail(`构建失败（退出码 ${result.status}）`)
}

const serve = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      let file = path.join(DIST, url === '/' ? 'index.html' : url)
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html')
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      fs.createReadStream(file).pipe(res)
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })

/** 一张图：等浏览器退出（超时 60s 就杀掉，避免挂死） */
const shoot = (browser, shot) =>
  new Promise((resolve) => {
    const target = path.join(OUT, shot.name)
    fs.rmSync(target, { force: true })
    const url = `http://127.0.0.1:${PORT}/?shot=${shot.query}`
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${shot.width},${shot.height}`,
        '--virtual-time-budget=2500',
        `--screenshot=${target}`,
        url,
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, reason: 'timeout' })
    }, 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const size = fs.existsSync(target) ? fs.statSync(target).size : 0
      if (code !== 0 || size < 2000) return resolve({ ok: false, reason: `exit=${code} size=${size}` })
      resolve({ ok: true, size })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: error.message })
    })
  })

const main = async () => {
  const noBuild = process.argv.includes('--no-build')
  if (!noBuild) build()
  if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('tmp-shot/dist/index.html 不存在')
  fs.mkdirSync(OUT, { recursive: true })

  const browser = findBrowser()
  if (!browser) fail('找不到无头浏览器（设置 CHROME_BIN）')

  const server = await serve()
  let failures = 0
  for (const shot of SHOTS) {
    const result = await shoot(browser, shot)
    if (result.ok) {
      console.log(`[PASS] ${shot.name} — ${result.size} 字节`)
      continue
    }
    failures += 1
    console.log(`[FAIL] ${shot.name} — ${result.reason}`)
  }
  server.close()
  console.log(`\n${SHOTS.length - failures}/${SHOTS.length} 张出图成功（输出目录 ${OUT}）`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => fail(`截图执行异常：${error && error.message}`))
