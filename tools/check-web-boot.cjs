/**
 * 启动冒烟：构建产物能不能真的跑起来。
 *
 * 为什么要有这个：tsc 和结构断言抓不到**运行期**错误。v1.8.6 就是
 * settings.ts 里 `readBackend` 定义在使用之后，模块加载即抛 TDZ，
 * React 根本没挂载 —— 类型检查全绿，用户端却全黑。
 *
 * 做法：把 web/dist 起一个静态服务，用无头浏览器加载，等待若干秒后 dump DOM，
 * 断言 <html data-ds-booted="1">（由 App 挂载后写入）。没有这个属性就说明没起来。
 *
 * 用法：node tools/check-web-boot.cjs
 *   REQUIRE_BROWSER=1  找不到浏览器时判失败（CI 用）
 */
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'web', 'dist')
const PORT = 18765
const BOOT_BUDGET_MS = 8000

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
  console.log(`[FAIL] web.boot — ${message}`)
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
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    )
  } else {
    list.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser')
  }
  return list.find((item) => {
    if (item.includes(path.sep) || item.includes('/')) {
      return fs.existsSync(item)
    }
    return spawnSync(process.platform === 'win32' ? 'where' : 'which', [item], { stdio: 'ignore' }).status === 0
  })
}

const main = async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    fail('web/dist/index.html 不存在，先构建')
  }

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

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

  const browser = findBrowser()
  if (!browser) {
    server.close()
    if (process.env.REQUIRE_BROWSER === '1') {
      fail('找不到无头浏览器（设置 CHROME_BIN 或安装 chrome/chromium）')
    }
    console.log('[INFO] web.boot — 本机没有可用浏览器，跳过启动冒烟')
    process.exit(0)
  }

  const domFile = path.join(os.tmpdir(), `ds-boot-${process.pid}.html`)
  const fd = fs.openSync(domFile, 'w')

  // 必须用异步 spawn：同步版本会阻塞事件循环，
  // 而静态服务就在本进程里，浏览器会一直等不到响应（表现为 dump 出 0 字节）
  const exitCode = await new Promise((resolve) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        `--virtual-time-budget=${BOOT_BUDGET_MS}`,
        '--dump-dom',
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: ['ignore', fd, fd], windowsHide: true }
    )
    const timer = setTimeout(() => {
      child.kill()
      resolve(-1)
    }, 90_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })
  fs.closeSync(fd)
  server.close()

  const dom = fs.existsSync(domFile) ? fs.readFileSync(domFile, 'utf8') : ''
  try {
    fs.unlinkSync(domFile)
  } catch {
    /* 清理失败不影响结论 */
  }

  if (dom.trim().length < 500) {
    fail(`页面没渲染出内容（DOM ${dom.length} 字节，浏览器退出码 ${exitCode}）`)
  }
  if (!/<html[^>]*data-ds-booted="1"/i.test(dom)) {
    fail('页面没有启动标记 data-ds-booted="1"（很可能模块加载时就抛错了）')
  }

  console.log(`[PASS] web.boot — 无头浏览器加载成功，React 已挂载（DOM ${dom.length} 字节）`)
  process.exit(0)
}

main().catch((error) => fail(`冒烟执行异常：${error && error.message}`))
