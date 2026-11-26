
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { runInThisContext } from 'node:vm'
import { unzipSync } from '../web/node_modules/fflate/esm/index.mjs'

const annotate = (error) => {
  const message = typeof error?.message === 'string' ? error.message : String(error)
  // Actions 会把 ::error:: 变成 annotation：公开仓库不登录也能看到是哪一条断言挂了。
  console.log('::error title=tablet-layout::' + message.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 900))
}
process.on('uncaughtException', (error) => { annotate(error); process.exit(1) })
process.on('unhandledRejection', (error) => { annotate(error); process.exit(1) })

const dir = import.meta.dirname
const project = path.join(dir, '..')
// 默认吃 web/dist（CI 先构建再跑这里）；本地也可以 QA_DIST 指到别的产物目录。
const dist = process.env.QA_DIST ? path.resolve(process.env.QA_DIST) : path.join(project, 'web', 'dist')
// 截图、Chrome 临时 profile 都写 tmp/qa，不污染仓库根目录。
const out = process.env.QA_OUT ? path.resolve(process.env.QA_OUT) : path.join(project, 'tmp', 'qa')
fs.mkdirSync(out, { recursive: true })
const browser = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(fs.existsSync)
assert(browser, 'No Chromium browser found（可用 CHROME_PATH 指定 chrome/edge 路径）')
assert(fs.existsSync(path.join(dist, 'index.html')), `前端产物不存在：${dist}，先构建（或设 QA_DIST）`)
// DSH Go v1.3.0 的分享查看器是 AGPL-3.0 的第三方源码，不入库；本地有夹具时才跑那两组兼容性断言。
const viewerPath = [
  process.env.DSHGO_VIEWER,
  path.join(project, 'tmp', 'dshgo-v130-share-viewer.src'),
  path.join(dir, 'fixtures', 'dshgo-v130-share-viewer.src'),
].filter(Boolean).find((candidate) => fs.existsSync(candidate))
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' }
let paired = true
let shareBlob
let shareTtl
let dictatedCount = 0
let delayDictation = false
let spoken = ''
let changedHostIdentity = false
let sshId
let sshDeleted = false
let sshConnectCount = 0
let sshPluginRevision = 'opaque:plugin:initial'
let sshPluginEnabled = false
let sshFolder
let installedSshPackage = false
let buildApprovalsRequired = true
const shareId = 'FixtureS01'
const deleteToken = 'fixture-delete-token'
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname
  console.log('GET', route)
  if (route === '/__ds_ssh/health.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"version":1}')
    return
  }
  if (route.startsWith('/__ds_ssh/')) {
    const parts = []
    req.on('data', (chunk) => parts.push(chunk))
    req.on('end', () => {
      const id = req.headers['x-ds-ssh-id']
      const reply = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}')
      if (route === '/__ds_ssh/open') {
        assert.equal(req.headers.origin, 'http://127.0.0.1:' + server.address().port)
        assert.match(id, /^[a-f0-9]{32}$/)
        assert.equal(body.host, 'tablet-ssh.test')
        assert.equal(body.mode, 'attach')
        assert.equal(body.launchToken, 'fixture-launch')
        assert.equal(body.password, 'fixture-ssh')
        sshId = id
        sshConnectCount += 1
        return reply(200, { ok: true })
      }
      if (id !== sshId) return reply(401, { code: 'SSH_NOT_CONNECTED' })
      if (route === '/__ds_ssh/close') { sshId = undefined; return reply(200, { ok: true }) }
      const path = req.headers['x-ds-host-path']
      const method = req.headers['x-ds-host-method']
      if (path === '/dsh-go/v1/plugin-config' && method === 'GET') return reply(200, {
        entries: [{ entryId: 'fixture/plugin', label: { en: 'SSH plugin settings' }, configurable: true }],
      })
      if (path === '/dsh-go/v1/plugin-config/fixture%2Fplugin') {
        if (method === 'POST') {
          assert.equal(body.revision, sshPluginRevision)
          assert.deepEqual(body.ops, [{ op: 'set', path: ['nested', 'enabled'], value: true }])
          sshPluginRevision = 'opaque:plugin:changed'
          sshPluginEnabled = true
        }
        return reply(200, { entry: {
          v: 1, entryId: 'fixture/plugin', revision: sshPluginRevision, writable: true,
          schema: { uid: 0, refs: {
            0: { type: 'object', dict: { nested: 1 } },
            1: { type: 'union', list: [2, 3] },
            2: { type: 'object', dict: { kind: 4, enabled: 5 } },
            3: { type: 'object', dict: { kind: 6, token: 7 } },
            4: { type: 'const', value: 'known' }, 5: { type: 'boolean', meta: { title: 'Enable nested option' } },
            6: { type: 'const', value: 'other' }, 7: { type: 'string', meta: { role: 'secret' } },
          } },
          value: { nested: { kind: 'known', enabled: sshPluginEnabled } },
          user: sshPluginEnabled ? { nested: { enabled: true } } : {},
        } })
      }
      if (path === '/dsh-go/v1/sessions/deletion' && method === 'GET') return reply(200, { version: 1, supported: true })
      if (path === '/dsh-go/v1/sessions/delete' && method === 'POST') {
        assert.equal(body.sessionId, 'qa-a')
        assert.equal(sshDeleted, false)
        sshDeleted = true
        return reply(200, { deleted: true, sessionId: 'qa-a' })
      }
      const envelope = (value) => reply(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
      assert.equal(path, '/api/' + body.method)
      assert.equal(method, 'POST')
      if (path === '/api/session/list') return envelope({ items: sshDeleted ? [] : [{ sessionId: 'qa-a', title: 'SSH-only conversation' }] })
      if (path === '/api/pluginManager/listBundles') return envelope(installedSshPackage
        ? [{ name: '@tablet/notes-plugin', version: '1.2.0', removable: true, enabled: true }] : [])
      if (path === '/api/pluginManager/listPlugins') return envelope([])
      if (path === '/api/pluginManager/installBundle') {
        assert.equal(body.payload.args.spec, '@tablet/notes-plugin@1.2.0')
        assert.match(body.payload.args.options.requestId, /^[a-f0-9-]{36}$/u)
        assert.equal(body.payload.args.options.saveExact, true)
        if (buildApprovalsRequired) {
          assert.equal(body.payload.args.options.approvedBuilds, undefined)
          buildApprovalsRequired = false
          return envelope({ application: 'failed', pendingBuilds: ['@tablet/dependency'] })
        }
        assert.deepEqual(body.payload.args.options.approvedBuilds, ['@tablet/dependency'])
        installedSshPackage = true
        return envelope({ application: 'applied' })
      }
      if (path === '/api/pluginManager/removeBundle') {
        assert.equal(installedSshPackage, true)
        assert.equal(body.payload.args.name, '@tablet/notes-plugin')
        installedSshPackage = false
        return envelope({ application: 'applied' })
      }
      if (path === '/api/directoryPicker/list') return envelope({ path: body.payload.args.path || '/project', entries: [] })
      if (path === '/api/directoryPicker/createDirectory') {
        assert.deepEqual(body.payload.args, { path: '/project', name: 'Tablet notes' })
        sshFolder = '/project/Tablet notes'
        return envelope(sshFolder)
      }
      return reply(404, {})
    })
    return
  }
  if (route === '/__ds_proxy' && typeof req.headers['x-ds-target'] === 'string') {
    const upstream = new URL(Buffer.from(req.headers['x-ds-target'], 'base64url').toString())
    const path = upstream.pathname
    const method = req.headers['x-ds-method']
    if (path === '/user/balance' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.50' }],
      }))
      return
    }
    if (['dl.dshtui.com', 'go.dshtui.com'].includes(upstream.hostname) && path.startsWith('/market/')) {
      res.writeHead(403).end()
      return
    }
    if (upstream.hostname === 'ccch1mneyyy.github.io' && path.startsWith('/dsh-go-market/')) {
      const name = '@tablet/notes-plugin'
      const value = path.endsWith('index.json') ? { format: 1, plugins: [
        { name, versions: [{ version: '1.2.0', source: { type: 'npm' } }] },
      ] } : { schema: 1, plugins: {
        [name]: { version: '1.2.0', title: 'Tablet notes plugin', tier: 'community', dshGo: { minApp: '1.0.13' },
          risk: { level: 'medium', flags: ['filesystem'] } },
      } }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
      return
    }
    if (path === '/v1/tools/asr' && method === 'POST') {
      const body = []
      req.on('data', (chunk) => body.push(chunk))
      req.on('end', () => {
        assert(Buffer.concat(body).includes('RIFF'))
        dictatedCount += 1
        setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ text: 'Dictated only to this chat' })), delayDictation ? 500 : 0)
      })
      return
    }
    if (path === '/v1/tools/tts' && method === 'POST') {
      const body = []
      req.on('data', (chunk) => body.push(chunk))
      req.on('end', () => {
        spoken = JSON.parse(Buffer.concat(body)).text
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.alloc(4800))
      })
      return
    }
    if (upstream.origin === 'https://go.dshtui.com') {
      const headers = JSON.parse(Buffer.from(req.headers['x-ds-headers'], 'base64url').toString())
      assert.equal(upstream.hash, '')
      if (path === '/api/v1/c' && method === 'POST') {
        assert.equal(headers['content-type'], 'application/octet-stream')
        assert.equal(headers.authorization, undefined)
        shareTtl = upstream.searchParams.get('ttl')
        const pieces = []
        req.on('data', (chunk) => pieces.push(chunk))
        req.on('end', () => {
          shareBlob = Buffer.concat(pieces)
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: shareId, deleteToken, expiresAt: new Date(Date.now() + 86400000).toISOString() }))
        })
      } else if (path === '/api/v1/c/' + shareId && shareBlob && method === 'GET') {
        assert.equal(headers.authorization, undefined)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(shareBlob)
      } else if (path === '/api/v1/c/' + shareId && shareBlob && method === 'DELETE') {
        assert.equal(headers.authorization, 'Bearer ' + deleteToken)
        shareBlob = undefined
        res.writeHead(204).end()
      } else {
        res.writeHead(404).end()
      }
      return
    }
    const host = { deviceId: 'fixture-host', name: 'Fixture Host', role: 'host', online: true,
      identityKey: changedHostIdentity ? 'C' + 'A'.repeat(42) : 'A'.repeat(43) }
    const secondary = { ...host, deviceId: 'fixture-secondary', name: 'Second Fixture Host', identityKey: 'B' + 'A'.repeat(42) }
    let payload = {}
    if (path === '/api/v1/auth/login') payload = { token: 'fixture-account-token', account: 'qa@example.com', expiresAt: Date.now() + 3600000 }
    if (path === '/api/v1/devices/register') payload = {
      accessToken: 'fixture-device-access-token', refreshToken: 'fixture-device-refresh-token',
      accessTokenExpiresAt: Date.now() + 3600000, refreshTokenExpiresAt: Date.now() + 7200000,
    }
    if (path === '/api/v1/devices') payload = { items: [host, secondary], nextCursor: null }
    if (path === '/api/v1/devices/fixture-host' || path === '/api/v1/devices/fixture-host/presence') payload = host
    if (path === '/api/v1/devices/fixture-secondary' || path === '/api/v1/devices/fixture-secondary/presence') payload = secondary
    if (path === '/api/v1/device-memberships') payload = { items: paired ? [
      { membershipId: 'fixture-membership', peer: { ...host, deviceId: 'fixture-paired', name: 'Paired travel computer' } },
    ] : [], nextCursor: null }
    if (path === '/api/v1/device-memberships/fixture-paired' && method === 'DELETE') paired = false
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }
  if (route.startsWith('/__ds_download/')) {
    res.writeHead(404).end()
    return
  }
  if (route.startsWith('/__ds_')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  const file = path.join(dist, route === '/' ? 'index.html' : route)
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(out, 'chrome-'))
const downloads = fs.mkdirSync(path.join(profile, 'downloads'), { recursive: true })
const logPath = path.join(out, 'chrome.log')
const log = fs.openSync(logPath, 'w')
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: ['ignore', log, log], windowsHide: true })
let launchError
child.once('error', (error) => { launchError = error })
let socket
try {
  const portFile = path.join(profile, 'DevToolsActivePort')
  const launchDeadline = Date.now() + 20_000
  let port
  while (!port && Date.now() < launchDeadline && !launchError && child.exitCode === null && child.signalCode === null) {
    try {
      const candidate = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (/^\d+$/u.test(candidate)) port = candidate
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EBUSY') throw error
    }
    // Some launches report the endpoint before writing DevToolsActivePort.
    if (!port) {
      port = fs.readFileSync(logPath, 'utf8').match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//u)?.[1]
    }
    if (!port) await sleep(100)
  }
  if (!port) {
    const detail = launchError?.message ?? fs.readFileSync(logPath, 'utf8').trim().slice(-650)
    throw new Error('Chromium did not start its debugging endpoint' + (detail ? ': ' + detail : ''))
  }
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page' && page.url === 'about:blank').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const pair = pending.get(message.id)
    if (!pair) return
    pending.delete(message.id)
    if (message.error) pair.reject(message.error)
    else pair.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const check = async (description, expression, timeout = 5000) => {
    const deadline = Date.now() + timeout
    let passed = await js(expression)
    while (!passed && Date.now() < deadline) {
      await sleep(60)
      passed = await js(expression)
    }
    if (!passed) {
      console.log(await js('({ dialogs: Array.from(document.querySelectorAll("[role=dialog]"), x => x.innerText.slice(0, 450)), text: document.body?.innerText?.slice(0, 1800), boot: document.documentElement.dataset.dsBooted, state: window.fixture?.remote.getState().phase, location: location.href, requests: performance.getEntriesByType("resource").slice(-15).map(x => [x.name, x.responseStatus]) })'))
      throw new Error(description)
    }
    console.log('[PASS] ' + description)
  }
  const operation = async (expression) => {
    await js(expression)
    await sleep(110)
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      let sampleCount = 0;
      Object.defineProperty(window, 'fixtureAudioSamples', { get: () => sampleCount });
      const createProcessor = AudioContext.prototype.createScriptProcessor;
      AudioContext.prototype.createScriptProcessor = function (...args) {
        const processor = createProcessor.apply(this, args);
        processor.addEventListener('audioprocess', event => { sampleCount += event.inputBuffer.length; });
        return processor;
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.15;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); void context.close(); };
        await context.resume();
        return destination.stream;
      };
      const BrowserSocket = window.WebSocket;
      class FixtureSshSocket extends EventTarget {
        readyState = BrowserSocket.CONNECTING;
        constructor() {
          super();
          window.fixtureSshSocket = this;
          queueMicrotask(() => {
            this.readyState = BrowserSocket.OPEN;
            this.dispatchEvent(new Event('open'));
          });
        }
        message(frame) {
          if (this.readyState === BrowserSocket.OPEN) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
        }
        send(text) {
          const frame = JSON.parse(text);
          if (frame.type === 'connect') {
            this.message({ type: 'open' });
            return;
          }
          if (frame.type !== 'open') return;
          if (frame.endpoint === '$events') {
            this.message({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'ssh-event-client' } });
          }
          if (frame.endpoint === 'session/follow') {
            const sessionId = frame.payload.args.request.address.sessionId;
            this.message({ type: 'item', streamId: frame.streamId, value: {
              type: 'snapshot', header: { sessionId, version: 3 }, cursor: 1, hasMore: false, records: [{
                type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: {
                  message: { id: 'ssh-answer', content: [{ type: 'text', text: 'SSH-only response' }] },
                } },
              }],
            } });
          }
        }
        close() {
          if (this.readyState === BrowserSocket.CLOSED) return;
          this.readyState = BrowserSocket.CLOSED;
          queueMicrotask(() => this.dispatchEvent(new Event('close')));
        }
      }
      window.WebSocket = new Proxy(BrowserSocket, {
        construct(Original, args) {
          return new URL(args[0]).pathname === '/__ds_remote/ssh-mux' ? new FixtureSshSocket() : new Original(...args);
        },
      });
    })();` })
  const recordVoice = async (dialog = false) => {
    const scope = dialog ? '[role="dialog"] ' : ''
    const control = (name) => `document.querySelector(${JSON.stringify(scope + 'button[aria-label="' + name + '"]')})`
    const before = await js('window.fixtureAudioSamples')
    await operation(`${control('Voice input')}?.click()`)
    await check('the microphone supplied PCM samples', `Boolean(${control('Stop recording and transcribe')}) && window.fixtureAudioSamples >= ${before + 8192}`, 6000)
    await operation(`${control('Stop recording and transcribe')}?.click()`)
  }
  const label = (text) => Array.from(document.querySelectorAll('button,[role=menuitem]')).find((el) =>
    !el.disabled && el.getClientRects().length && (el.getAttribute('aria-label') === text || el.textContent.trim() === text))
  const openBy = async (text) => {
    const button = '(' + label + ')(' + JSON.stringify(text) + ')'
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await js('Boolean(' + button + ')')) {
        await operation(button + '?.click()')
        return
      }
      await sleep(50)
    }
    throw new Error('Button did not appear: ' + text)
  }
  const leaveSettings = async () => {
    await openBy('Chat')
    await check('returns to chat from settings', '!document.querySelector("[data-settings-page]")')
  }
  const frame = 'document.querySelector("[class^=frame-]")'
  const themeColor = (role) => `getComputedStyle(document.body).getPropertyValue('--md-${role}').trim()`
  const textarea = 'document.querySelector("textarea")'
  const photo = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data, 'base64'))
  }
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.method === 'Runtime.exceptionThrown') console.log(msg.params.exceptionDetails.exception?.description)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  const captureDownloads = () => operation(`(() => {
    window.capturedDownloads = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith("blob:")) return click.call(this)
      const name = this.download
      void fetch(this.href).then(r => r.arrayBuffer()).then(bytes => {
        let data = ""
        for (const byte of new Uint8Array(bytes)) data += String.fromCharCode(byte)
        capturedDownloads.push({ name, data: btoa(data) })
      })
    }
  })()`)
  const readDownload = async (name) => {
    const file = path.join(downloads, name)
    const lookup = `window.capturedDownloads?.find(item => item.name === ${JSON.stringify(name)})?.data`
    for (let attempt = 0; attempt < 60; attempt++) {
      const data = await js(lookup)
      if (data !== undefined) {
        const bytes = Buffer.from(data, 'base64')
        fs.writeFileSync(file, bytes)
        return bytes
      }
      await sleep(50)
    }
    throw new Error('No download emitted for ' + name + ': ' + await js('document.querySelector("[role=alert]")?.textContent'))
  }
  if (!process.argv.includes('--integration-only')) {
  for (const [name, width, height] of [['landscape', 1366, 900], ['portrait', 800, 1120], ['phone-landscape', 844, 390], ['split', 460, 780]]) {
    const singlePane = width < 840 || height < 480
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' })
    for (let attempt = 0; attempt < 70; attempt++) {
      if (await js('document.body?.textContent.includes("A distinct response for qa-a")').catch(() => false)) break
      await sleep(90)
    }
    await check(name + ' renders chat', 'document.body.textContent.includes("A distinct response for qa-a")')
    await check(name + ' composer within viewport', textarea + '.getBoundingClientRect().bottom <= innerHeight')
    await check(name + ' frame fits window', frame + '.scrollWidth <= innerWidth')
    if (name === 'phone-landscape') {
      await check('phone landscape fits idle input and send on one line',
        'document.querySelector("[data-composer-primary]").parentElement.getBoundingClientRect().height <= 64')
    }
    await photo('tablet-' + name)
    if (singlePane) {
      await openBy('History')
      await check(name + ' opens the conversation list', 'document.querySelector("#mobile-session-drawer").getAttribute("aria-hidden") === "false"')
    }
    await openBy('Tablet workspace beta')
    await check(name + ' select beta', 'fixture.remote.getState().activeSessionId === "qa-b" && document.body.textContent.includes("A distinct response for qa-b")')
    await check(name + ' keeps alpha text out of beta', '!document.body.textContent.includes("A distinct response for qa-a")')
    await openBy('Quote')
    await check(name + ' quotes into the active composer', textarea + '.value.startsWith("> My request for qa-b")')
    await operation('fixture.workspace.setState({open:true})')
    await check(name + ' workspace placement', 'document.querySelector("[data-workspace-pane]").getAttribute("role") === "' + (width >= 1200 ? 'complementary' : 'dialog') + '"')
    await photo('tablet-' + name + '-workspace')
    await operation('fixture.workspace.getState().closePane()')
    await operation(textarea + '.focus(); Object.defineProperty(visualViewport, "height", { configurable:true, value: Math.round(innerHeight * .57) }); visualViewport.dispatchEvent(new Event("resize"))')
    await check(name + ' composer stays above keyboard', textarea + '.getBoundingClientRect().bottom <= visualViewport.height')
    await check(name + ' frame follows visual viewport', 'Math.round(' + frame + '.getBoundingClientRect().height) === visualViewport.height')
    await operation(textarea + '.blur(); delete visualViewport.height; visualViewport.dispatchEvent(new Event("resize"))')
    await operation('fixture.newSession.getState().openPanel()')
    await check(name + ' new session shows workspace selection', 'document.querySelector("[data-testid=new-session-page] h1") !== null')
    await check(name + ' new session keeps workspace and composer together',
      'document.querySelector("textarea").getBoundingClientRect().top - document.querySelector("[data-testid=new-session-page] h1").getBoundingClientRect().bottom < 125')
    await photo('tablet-' + name + '-new')
    await operation('fixture.newSession.getState().closePanel()')
    await openBy('Settings')
    await check(name + ' settings list has four sections in a main page',
      'document.querySelectorAll("[data-settings-page] nav button").length === 4 && !document.querySelector("[role=dialog]")')
    await check(name + ' places primary navigation for this window size', `(() => {
      const nav = document.querySelector('[data-app-frame] > nav').getBoundingClientRect()
      return ${width < 600 && height >= 480} ? nav.bottom === innerHeight && nav.width === innerWidth : nav.left === 0 && nav.width === 88
    })()`)
    await openBy('General')
    await check(name + ' settings adapts its list and detail',
      'Boolean(document.querySelector("[data-settings-content]")) && Boolean(document.querySelector("[data-settings-page] nav")) === ' + !singlePane)
    await check(name + ' group controls fit on screen', `(() => {
      const panel = document.querySelector('[data-settings-content]')
      return panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().bottom <= innerHeight
    })()`)
    await photo('tablet-' + name + '-settings')
    if (singlePane) {
      await operation('history.back()')
      await check(name + ' browser Back returns from settings detail to the list',
        'Boolean(document.querySelector("[data-settings-page] nav")) && !document.querySelector("[data-settings-content]")')
    }
    await openBy('Back to chat')
    await check(name + ' returning from settings preserves the conversation',
      '!document.querySelector("[data-settings-page]") && document.body.innerText.includes("A distinct response for qa-b")')
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/?local' })
  await check('local welcome shows editable first-message starters', 'document.querySelector("h1")?.textContent === "What are we working on?" && !document.querySelector("[role=dialog]")')
  await check('local welcome shows the current balance', 'document.body.innerText.includes("12.50")')
  await operation('fixture.settings.setState({ locale: "zh-CN" })')
  await photo('tablet-local-welcome')
  await operation('fixture.settings.setState({ locale: "en-US" })')
  await openBy('Draft a message')
  await check('a starter fills and focuses the composer without sending', 'document.activeElement === document.querySelector("textarea") && document.activeElement.value === "Help me draft a message about " && !document.querySelector("[aria-current=true]")')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: false })
  await operation('fixture.settings.setState({ themePreference: "dark" })')
  await check('dark split welcome keeps input and 44px send target inside the frame', `(() => {
    const send = document.querySelector('button[aria-label="Send"]');
    const rect = send?.getBoundingClientRect();
    const toolbar = send?.closest('[class^="functionRow-"]');
    return document.body.dataset.dsDarkTheme === "dark" && ${frame}.scrollWidth <= innerWidth &&
      rect?.height >= 44 && rect.bottom <= innerHeight &&
      toolbar && toolbar.scrollWidth === toolbar.clientWidth;
  })()`)
  await check('the compact welcome keeps its title close to the composer and uses the indigo scheme',
    `${themeColor('primary')} === "#bec2ff" &&
      ${textarea}.getBoundingClientRect().top - document.querySelector('h1').getBoundingClientRect().bottom < 100`)
  await photo('tablet-local-split-dark')
  await openBy('Settings')
  await openBy('General')
  await openBy('Rose')
  await check('a color preset updates Material roles without changing dark mode', `
    ${themeColor('primary')} !== "#bec2ff" && document.body.dataset.dsDarkTheme === "dark" &&
    localStorage.getItem("chat-demo:theme-color") === "#a94264" &&
    [...document.querySelectorAll('button[aria-pressed=true]')].some(button => button.textContent === 'Rose')
  `)
  await operation(`(() => {
    const picker = document.querySelector('input[type=color]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(picker, '#d66931')
    picker.dispatchEvent(new Event('input', { bubbles: true }))
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await check('a custom seed updates the stored color', 'localStorage.getItem("chat-demo:theme-color") === "#d66931"')
  await send('Page.reload')
  await check('the custom color persists and the light palette maintains contrast', `(() => {
    const picker = document.querySelector('input[type=color]')
    const luminance = (role) => {
      const color = getComputedStyle(document.body).getPropertyValue('--md-' + role).trim()
      const [r, g, b] = [...color.slice(1).matchAll(/../g)].map(match => {
        const c = parseInt(match[0], 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    return picker?.value === '#d66931' && ${themeColor('primary')} !== '#555a92' &&
      (luminance('on-primary') + 0.05) / (luminance('primary') + 0.05) >= 4.5 &&
      (luminance('surface') + 0.05) / (luminance('on-surface') + 0.05) >= 4.5
  })()`)
  await photo('tablet-custom-theme')
  await openBy('Indigo (default)')
  await check('restoring indigo clears the custom seed and reapplies the default roles',
    `localStorage.getItem("chat-demo:theme-color") === null && ${themeColor('primary')} === "#555a92"`)
  await leaveSettings()
  await operation('document.querySelector(\'[aria-controls="mobile-session-drawer"]\').click()')
  await operation('fixture.remote.setState({ phase: "idle", hostId: null, activeSessionId: null }); document.querySelector(\'#mobile-session-drawer button[aria-haspopup="dialog"]\').click()')
  await check('one host picker includes the current local context and remote connection',
    'document.querySelector("[role=dialog] h2")?.textContent === "Switch computer" && document.querySelector("[role=dialog] [aria-current=true]")?.textContent.includes("This device") && document.querySelector("[role=dialog]").textContent.includes("Remote connection")')
  await photo('tablet-mobile-host-picker')
  await operation(`[...document.querySelectorAll('[role=dialog] button')].find(x => x.textContent.includes('Disconnected')).click()`)
  await check('unconnected remote mode exposes connection without opening Settings', 'document.querySelector("h1")?.textContent.includes("Not connected") && !document.querySelector("[role=dialog]")')
  await openBy('Remote connection')
  await check('the remote settings page exposes pairing and SSH',
    'document.querySelector("[data-settings-page]")?.innerText.includes("Connect SSH host") && document.querySelector("[data-settings-page]")?.innerText.includes("Pair a host") && !document.querySelector("[role=dialog]")')
  await photo('tablet-remote-connection')
  await openBy('Connect SSH host')
  await check('a complex form fills the compact window', `(() => {
    const dialog = document.querySelector('[role=dialog][data-expanded]')
    return dialog?.getBoundingClientRect().width === innerWidth && Boolean(dialog.querySelector('input[name=host]'))
  })()`)
  await operation(`document.querySelector('input[name=host]').focus()
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 280 })
    visualViewport.dispatchEvent(new Event('resize'))`)
  await check('a full-screen form follows the keyboard and retains its close control', `(() => {
    const dialog = document.querySelector('[role=dialog]')
    const body = dialog.querySelector('[class^="main-"]')
    const close = dialog.querySelector('button[aria-label="Close"]').getBoundingClientRect()
    return dialog.getBoundingClientRect().height === 280 && body.scrollHeight > body.clientHeight &&
      close.top >= 0 && close.bottom <= 280
  })()`)
  await photo('tablet-ssh-keyboard')
  await openBy('Close')
  await operation('delete visualViewport.height; visualViewport.dispatchEvent(new Event("resize"))')
  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 780, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/?management' })
  for (let attempt = 0; attempt < 70 && !await js('location.search === "?management" && document.documentElement.dataset.dsBooted === "1"').catch(() => false); attempt++) await sleep(90)
  await operation('document.querySelector(\'[aria-controls="mobile-session-drawer"]\')?.click()')
  await operation(`(() => { const entry = document.querySelector('#mobile-session-drawer button[aria-label="Remote tools"]'); entry.focus(); entry.click(); })()`)
  await check('remote tools group Host actions and conversation data outside Settings',
    'document.querySelector("[role=dialog] h2")?.textContent === "Remote tools" && Boolean(document.querySelector("section[aria-label=Host] button") && document.querySelector(\'section[aria-label="Conversation data"] button\'))')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 390, deviceScaleFactor: 1, mobile: false })
  await check('a long dialog scrolls independently and its close control stays reachable', `(() => {
    const dialog = document.querySelector('[role=dialog]')
    const body = dialog.querySelector('[class^="main-"]')
    const close = dialog.querySelector('button[aria-label="Close"]')
    const before = close.getBoundingClientRect()
    body.scrollTop = body.scrollHeight
    const after = close.getBoundingClientRect()
    return body.scrollTop > 0 && before.top === after.top && after.top >= 0 &&
      after.bottom <= innerHeight && document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2)?.closest('button') === close
  })()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 780, deviceScaleFactor: 1, mobile: false })
  await operation('fixture.settings.setState({ locale: "zh-CN" })')
  await photo('tablet-remote-tools')
  await operation('fixture.settings.setState({ locale: "en-US" })')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await check('closing remote tools returns keyboard focus to its sidebar entry',
    '!document.querySelector("[role=dialog]") && document.activeElement.getAttribute("aria-label") === "Remote tools"')
  await openBy('Remote tools')
  await openBy('Host plugins')
  await sleep(350)
  await check('plugin inventory renders protected host entries', 'document.body.innerText.includes("protected-plugin") && document.body.innerText.includes("Managed on the Host")')
  await openBy('Enable')
  await check('plugin toggle sends bundle request and refreshes', 'fixture.calls.some(x => x.endpoint === "pluginManager/setBundleEnabled" && x.args.name === "fixture-plugin" && x.args.enabled) && document.body.innerText.includes("Host result: applied")')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  await openBy('Manage workspaces')
  await sleep(350)
  const choose = 'const s = [...document.querySelectorAll("[role=dialog]")].at(-1).querySelector("select"); s.value = "folder"; s.dispatchEvent(new Event("change", { bubbles: true }));'
  await operation(choose)
  await openBy('Move down')
  await check('workspace reorder updates host inventory', 'fixture.newSession.getState().hostWorkspaces[0].workspaceId === "other-folder"')
  await operation(`(() => {
    const select = [...document.querySelectorAll('[role=dialog]')].at(-1).querySelectorAll('select')[1];
    select.value = 'qa-b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await openBy('Move conversation up')
  await check('workspace conversation reorder uses the Host anchor and updates the projection', `(() => {
    const call = fixture.calls.find(item => item.endpoint === 'workspace/insertSessionBefore');
    return call?.args.request.workspaceId === 'folder' && call.args.request.sessionId === 'qa-b' &&
      call.args.request.beforeSessionId === 'qa-a' && fixture.newSession.getState().hostWorkspaces.find(item => item.workspaceId === 'folder')?.sessionIds.join(',') === 'qa-b,qa-a';
  })()`)
  await openBy('Remove workspace')
  await check('workspace removal asks for confirmation', 'document.body.innerText.includes("Its files and conversations will remain on the Host")')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("section button")?.click()')
  await check('workspace removal keeps conversations', 'fixture.newSession.getState().hostWorkspaces.length === 1 && fixture.remote.getState().sessions.length === 2')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  await operation('fixture.saveSessionBackup({ id: "browser-test", sessionId: "qa-b", title: "Stored tablet backup", throughSeq: 3, createdAt: Date.now(), totalBytes: 3, sha256: "fixture" }, { bytes: new Uint8Array([1, 3, 5]), sha256: "fixture" })')
  await check('browser encrypted storage round-trips the backup', '(async () => { const { backups } = await fixture.listSessionBackups(); return String((await fixture.openSessionBackup(backups[0])).bytes) === "1,3,5"; })()')
  await openBy('Session backup and restore')
  await sleep(350)
  await check('backup screen lists the stored snapshot', 'document.body.innerText.includes("Stored tablet backup")')
  await photo('tablet-split-backups')
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 780, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/?integration' })
  for (let attempt = 0; attempt < 70 && !await js('Boolean(window.fixture)').catch(() => false); attempt++) await sleep(90)
  await operation('fixture.remote.getState().connect("https://fixture.invalid", "qa@example.com", "fixture-password")')
  await check('integration connects the production remote store', 'fixture.remote.getState().phase === "ready" && fixture.remote.getState().sessions.some(row => row.id === "qa-a")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await operation('fixture.telemetry.sendOutcome = "timeout"')
  await operation('fixture.remote.getState().send("Confirm this once")')
  await check('timeout creates a retryable message with its original id', 'fixture.remote.getState().items.some(row => row.sendState === "unconfirmed") && document.body.textContent.includes("Delivery to the host is unconfirmed.")')
  await operation('fixture.remote.getState().openSession("qa-b")')
  await check('the other session has no pending prompt', '!document.body.textContent.includes("Confirm this once")')
  await operation('fixture.remote.getState().openSession("qa-a"); fixture.telemetry.sendOutcome = "echo-timeout"')
  await openBy('Retry this message')
  await check('retry reuses the id and a late error leaves the Host echo intact', '(() => { const c=fixture.telemetry.calls.filter(x=>x.endpoint==="session/prompt"); const rows=fixture.remote.getState().items; return c.length===2 && c[0].args.request.requestId===c[1].args.request.requestId && rows.length===1 && rows[0].text==="Confirm this once" && !rows[0].sendState; })()')
  await openBy('More actions')
  await openBy('Terminal')
  await sleep(500)
  await check('terminal renders the Host snapshot', 'document.querySelector(".xterm-rows")?.textContent.includes("fixture terminal output")')
  await openBy('Tab')
  await check('terminal sends keyboard input to the selected shell', 'fixture.telemetry.calls.some(x=>x.endpoint==="terminal/write" && x.args.data===String.fromCharCode(9))')
  await operation('fixture.remote.getState().openSession("qa-b")')
  await check('switching sessions closes terminal follow and retain', 'fixture.telemetry.closed.includes("terminal/follow") && fixture.telemetry.closed.includes("terminal/retain") && !document.querySelector(".xterm")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await openBy('More actions')
  await openBy('Background jobs')
  await sleep(350)
  await check('jobs stream renders the Host roster', 'document.body.textContent.includes("Fixture background job")')
  await openBy('Job output')
  await check('job output appears in the progress panel', 'document.querySelector("pre")?.textContent.includes("fixture job output")')
  await openBy('Stop job')
  await check('job stop presents confirmation', 'document.body.textContent.includes("Stop this background job?")')
  await openBy('Stop job')
  await check('job stop requests the correct session and job', 'fixture.telemetry.calls.some(x=>x.endpoint==="job/kill" && x.args.request.sessionId==="qa-a" && x.args.request.jobId==="fixture-job")')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  await operation('fixture.openSettings("remote")')
  await openBy('Manage devices')
  await sleep(300)
  await check('paired device list renders the membership', 'document.body.textContent.includes("Paired travel computer")')
  await openBy('Unpair')
  await check('unpair asks for confirmation', 'document.body.textContent.includes("Unpair this device from Paired travel computer?")')
  await operation('[...document.querySelectorAll("button")].filter(x=>x.textContent.trim()==="Unpair").at(-1)?.click()')
  await check('only the requested pairing is removed', 'document.body.textContent.includes("This device has no active pairings.") && fixture.remote.getState().phase==="ready"')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  await openBy('Scheduled tasks')
  await sleep(300)
  await check('schedule catalog renders the Host task', 'document.body.textContent.includes("Fixture schedule")')
  await openBy('View details')
  await check('schedule detail loads delivery history', 'document.body.textContent.includes("Fixture delivery")')
  await openBy('Run now')
  await openBy('Run now')
  await check('schedule manual run targets the original task', 'fixture.telemetry.calls.some(x=>x.endpoint==="schedule/run" && x.args.request.id==="fixture-schedule")')
  await photo('tablet-split-schedules')
  const closeManagement = () => operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  const changeInput = (selector, value, event = 'input') => operation('(' + ((selector, value, event) => {
    const input = document.querySelector(selector)
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value)
    input.dispatchEvent(new Event(event, { bubbles: true }))
  }) + ')(' + [selector, value, event].map((arg) => JSON.stringify(arg)).join(',') + ')')
  await closeManagement()
  await openBy('Host plugin settings')
  await check('Host settings renders schema fields', 'document.body.textContent.includes("Fixture behavior")')
  await openBy('Edit')
  await changeInput('[role=dialog] form select', 'true', 'change')
  await openBy('Save')
  await check('Host settings writes the selected path with its original revision',
    'fixture.telemetry.calls.some(x=>x.endpoint==="settings/mutate" && x.args.ns==="fixture-plugin" && x.args.expectedRevision===3 && x.args.ops[0].path.join("/")==="enabled" && x.args.ops[0].value===true) && !document.querySelector("[role=dialog] form")')
  await closeManagement()
  await openBy('Host model providers')
  await check('the provider picker only shows routes from its own adapter', 'document.body.textContent.includes("Fixture provider") && !document.body.textContent.includes("Other adapter")')
  await openBy('Edit')
  await openBy('Discover models')
  await check('discovery renders model ids', 'document.body.textContent.includes("discovered-model")')
  await changeInput('[role=dialog] form label:nth-of-type(2) input', 'Renamed fixture provider')
  await openBy('Save')
  await check('provider edits leave inherited model defaults on the Host',
    'fixture.telemetry.calls.some(x=>x.endpoint==="settings/mutate" && x.args.ns==="llm-pi-ai" && x.args.expectedRevision===8 && x.args.ops.length===1 && x.args.ops[0].path.join("/")==="providers/fixture-provider/displayName") && document.body.textContent.includes("Renamed fixture provider")')
  await openBy('Model overrides')
  await changeInput('[role=dialog] input[list=remote-override-models]', 'base-model')
  await changeInput('[role=dialog] form input[inputmode=numeric]', '64000')
  await openBy('Save')
  await check('a model override writes only the selected catalog entry and preserves unexposed fields', `(() => {
    const op = fixture.telemetry.calls.find(x => x.endpoint === 'settings/mutate' && x.args.expectedRevision === 9)?.args.ops[0];
    return op?.path.join('/') === 'providers/fixture-provider/modelOverrides/base-model' &&
      op.value.contextWindow === 64000 && op.value.name === 'Base model' && op.value.compat.supportsCache === true;
  })()`)
  await openBy('Model overrides')
  await changeInput('[role=dialog] input[list=remote-override-models]', 'base-model')
  await openBy('Clear override')
  await check('resetting the last model override leaves the provider and its credential untouched',
    'fixture.telemetry.calls.some(x => x.endpoint==="settings/mutate" && x.args.expectedRevision===10 && x.args.ops[0].op==="unset" && x.args.ops[0].path.join("/")==="providers/fixture-provider/modelOverrides")')
  await openBy('Provider credentials')
  await sleep(250)
  await changeInput('[role=dialog] input[type=password]', 'fixture-key-never-persist')
  await openBy('Save')
  await check('credential is written only to the credentials endpoint and cleared from the input',
    'fixture.telemetry.calls.filter(x=>JSON.stringify(x.args).includes("fixture-key-never-persist")).length===1 && fixture.telemetry.calls.some(x=>x.endpoint==="credentials/set" && x.args.ref==="FIXTURE_API_KEY") && document.querySelector("[role=dialog] input[type=password]")?.value==="" && !document.body.textContent.includes("fixture-key-never-persist") && !JSON.stringify(localStorage).includes("fixture-key-never-persist") && !JSON.stringify(sessionStorage).includes("fixture-key-never-persist")')
  await openBy('Clear credential')
  await openBy('Clear credential')
  await check('clear uses the current provider credential reference',
    'fixture.telemetry.calls.some(x=>x.endpoint==="credentials/unset" && x.args.ref==="FIXTURE_API_KEY") && document.body.textContent.includes("Not configured")')
  await closeManagement()
  await leaveSettings()
  const enter = () => operation('document.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true}))')
  await operation('fixture.newSession.getState().openPanel(); fixture.telemetry.createDelay=450; fixture.telemetry.sendOutcome="success"')
  await changeInput('textarea', 'Keep draft when leaving new session')
  await enter()
  await operation('fixture.newSession.getState().closePanel(); fixture.remote.getState().openSession("qa-b")')
  await sleep(500)
  await check('late create completion never sends to the session selected in the meantime',
    'fixture.remote.getState().activeSessionId==="qa-b" && !fixture.telemetry.calls.some(x=>x.endpoint==="session/prompt" && JSON.stringify(x.args).includes("Keep draft when leaving"))')
  await operation('fixture.newSession.getState().openPanel(); fixture.telemetry.createDelay=0; fixture.telemetry.sendOutcome="reject"')
  await check('leaving a new session retains its host-owned draft', 'document.querySelector("textarea").value==="Keep draft when leaving new session"')
  await enter()
  await check('Host rejection restores the first prompt in the new-session composer',
    'fixture.newSession.getState().open && !fixture.newSession.getState().creating && document.querySelector("textarea").value==="Keep draft when leaving new session" && fixture.telemetry.calls.some(x=>x.endpoint==="session/prompt" && x.args.request.sessionId.startsWith("qa-created-"))')
  await operation('fixture.telemetry.sendOutcome="success"')
  await enter()
  await check('retry sends the first prompt to the same newly created session',
    '(() => { const c=fixture.telemetry.calls.filter(x=>x.endpoint==="session/prompt" && JSON.stringify(x.args).includes("Keep draft when leaving")); return c.length===2 && c[0].args.request.sessionId===c[1].args.request.sessionId && fixture.remote.getState().activeSessionId===c[1].args.request.sessionId && !fixture.newSession.getState().open })()')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await openBy('More actions')
  await openBy('Skills')
  await openBy('Use in this session')
  await check('skill picker inserts into the selected session without sending',
    'document.querySelector("textarea").value==="/fixture-skill " && fixture.telemetry.calls.some(x=>x.endpoint==="skills/list" && x.args.request.sessionId==="qa-a")')
  await openBy('More actions')
  await openBy('Reference a file or session')
  await openBy('Insert reference')
  await check('file reference quotes workspace paths containing spaces',
    'document.querySelector("textarea").value.includes(\'@"notes with spaces.md"\') && fixture.telemetry.calls.some(x=>x.endpoint==="fileReferences/list" && x.args.agentId==="qa-a")')
  await openBy('More actions')
  await openBy('Reference a file or session')
  await changeInput('[role=dialog] select', 'sessions', 'change')
  await openBy('Insert reference')
  await check('session reference uses the Host-provided canonical mention',
    'document.querySelector("textarea").value.includes("@[Fixture conversation](dsh-session:InFhLWIi)")')
  await openBy('More actions')
  await openBy('Session goal')
  await openBy('Create goal')
  await changeInput('[role=dialog] form textarea', 'Verify fixture goal')
  await openBy('Save')
  await check('new goals read back from the original session', 'document.querySelector("[role=dialog]")?.textContent.includes("Verify fixture goal")')
  await openBy('Pause goal')
  await check('goal pause carries the current revision and selected agent id',
    'fixture.telemetry.calls.some(x=>x.endpoint==="goals/pause" && x.args.agentId==="qa-a" && x.args.ref.id==="fixture-goal" && x.args.ref.revision===1) && document.querySelector("[role=dialog]")?.textContent.includes("Paused")')
  await closeManagement()
  await operation('fixture.telemetry.showFeedbackReply=true; fixture.remote.getState().openSession("qa-b")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await openBy('Feedback')
  await openBy('Helpful')
  await check('feedback reads back the rating for this reply and session',
    'fixture.telemetry.calls.some(x=>x.endpoint==="messageFeedback/put" && x.args.request.sessionId==="qa-a" && x.args.request.messageId==="fixture-feedback-reply" && x.args.request.ifVersion===null) && document.querySelector("[role=dialog] button[aria-pressed=true]")?.textContent==="Helpful"')
  await openBy('Clear feedback')
  await check('clearing feedback includes the saved revision',
    'fixture.telemetry.calls.some(x=>x.endpoint==="messageFeedback/delete" && x.args.request.ifVersion==="fixture-revision-2") && !document.querySelector("[role=dialog] button[aria-pressed=true]")')
  await closeManagement()
  await captureDownloads()
  await openBy('More actions')
  await openBy('Export conversation')
  await openBy('Download Markdown')
  const markdown = (await readDownload('dsh-chat-qa-a.md')).toString()
  assert(markdown.includes('Fixture reply with feedback') && !markdown.includes('qa-b'))
  console.log('[PASS] Markdown download contains the selected conversation')
  await operation(`(() => {
    window.imageText = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      window.imageText.push(text);
      return fill.call(this, text, ...args);
    };
  })()`)
  await operation(`(() => {
    const fields = document.querySelectorAll('[role=dialog] input[type=number]');
    if (fields.length !== 2) throw new Error('Missing export range');
    const from = fields[0];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(from, fields[1].value);
    from.dispatchEvent(new Event('input', { bubbles:true }));
  })()`)
  await openBy('Download text as PNG')
  const png = await readDownload('dsh-chat-qa-a.png')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 900)
  assert(png.readUInt32BE(20) > 200 && png.readUInt32BE(20) < 330)
  await check('PNG export renders only the selected message',
    'imageText.includes("Fixture reply with feedback") && !imageText.some(x=>x.includes("Confirm this once"))')
  await changeInput('[role=dialog] input[type=number]', '1')
  await openBy('Replay conversation')
  await check('replay starts from the first selected message',
    'document.querySelector("[role=dialog] article")?.textContent.includes("Confirm this once") && !document.querySelector("[role=dialog]")?.textContent.includes("Fixture reply with feedback")')
  await openBy('Playback speed 1×')
  await openBy('Playback speed 2×')
  await openBy('Play replay')
  await sleep(1150)
  await check('faster replay reaches the assistant message',
    'document.querySelector("[role=dialog]")?.textContent.includes("Fixture reply with feedback")')
  await changeInput('[role=dialog] input[type=range]', '0', 'change')
  await check('replay position can seek back to the first message',
    'document.querySelectorAll("[role=dialog] article").length===1')
  await openBy('Back to export')
  await operation('window.__DS_NATIVE__ = true')
  await operation(`(() => {
    const items = fixture.remote.getState().items.slice();
    const prompt=items.findIndex(x=>x.kind==='message' && x.role==='user' && x.text.includes('Confirm this once'));
    const reply=items.findIndex(x=>x.kind==='message' && x.role==='assistant' && x.text.includes('Fixture reply with feedback'));
    items[prompt] = { ...items[prompt], images: [{ name:'Fixture pixel', sessionId:'qa-a', uri:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9lQAAAAASUVORK5CYII=' }] };
    items[reply] = { ...items[reply], reasoning:'Reviewed the fixture input' };
    items.splice(reply, 0, { id:'fixture-share-tool', sessionId:'qa-a', createdAt:items[reply].createdAt, kind:'tool', toolName:'Fixture tool', summary:'Exported one result', resultDetail:{text:'<script>escaped fixture</script>',format:'code'}, state:'finished' });
    fixture.remote.setState({items});
  })()`)
  await openBy('Share conversation')
  await check('share preview hides the synthetic API key',
    'document.querySelector("[role=dialog] pre")?.textContent.includes("API_KEY=••••••") && !document.querySelector("[role=dialog] pre")?.textContent.includes("test-secret-do-not-share")')
  await operation('[...document.querySelectorAll("[role=dialog] input[type=checkbox]")].forEach(box=>box.click())')
  await openBy('Download webpage')
  const htmlShare = (await readDownload('dsh-chat-qa-a.html')).toString()
  assert(htmlShare.includes('Reviewed the fixture input') && htmlShare.includes('Fixture tool') && htmlShare.includes('data:image/png;base64,')
    && htmlShare.includes('&lt;script&gt;escaped fixture&lt;/script&gt;') && !htmlShare.includes('test-secret-do-not-share'))
  console.log('[PASS] standalone webpage includes selected details and escapes tool output')
  await openBy('Download .dshgo conversation')
  const shareFile = await readDownload('dsh-chat-qa-a.dshgo')
  let decodedShare
  if (viewerPath) {
    runInThisContext(fs.readFileSync(viewerPath, 'utf8'))
    decodedShare = await globalThis.DshgoViewer.openFile(shareFile.toString())
    assert(decodedShare.conversation.entries.some((entry) => entry.text?.includes('Fixture reply with feedback')))
    assert(decodedShare.conversation.entries.every((entry) => !entry.text?.includes('test-secret-do-not-share')))
    assert(decodedShare.conversation.entries.some((entry) => entry.think === 'Reviewed the fixture input'))
    assert(decodedShare.conversation.entries.some((entry) => entry.type === 'tool' && entry.name === 'Fixture tool'))
    assert(decodedShare.conversation.entries.some((entry) => entry.images?.[0]?.id))
    console.log('[PASS] DSH Go viewer accepts the redacted .dshgo file')
  } else {
    console.log('[SKIP] DSH Go viewer accepts the redacted .dshgo file（缺少 dshgo-v130-share-viewer.src 夹具；AGPL 源码不入库）')
  }
  await changeInput('[role=dialog] select', '7d', 'change')
  await openBy('Create encrypted link')
  const linkField = 'document.querySelector(\'input[aria-label="Share conversation"]\')?.value'
  for (let attempt = 0; attempt < 40 && !await js(linkField); attempt++) await sleep(100)
  const shareHref = await js(linkField)
  assert(shareHref, await js('document.querySelector("[role=alert]")?.textContent'))
  const shareKey = new URLSearchParams(new URL(shareHref).hash.slice(1)).get('k')
  assert.equal(shareTtl, '7d')
  if (decodedShare) {
    const hostedFile = await globalThis.DshgoViewer.decryptHosted(shareBlob, shareKey)
    const hostedShare = await globalThis.DshgoViewer.openFile(hostedFile)
    assert.equal(hostedShare.conversation.title, decodedShare.conversation.title)
    assert.deepEqual(hostedShare.conversation.entries, decodedShare.conversation.entries)
    console.log('[PASS] DSH Go viewer decrypts the uploaded file and recovers the same redacted messages')
  } else {
    console.log('[SKIP] DSH Go viewer decrypts the uploaded file（同上，缺夹具）')
  }
  await openBy('Back to export')
  await openBy('Download Host snapshot ZIP')
  const files = unzipSync(await readDownload('dsh-chat-qa-a.zip'))
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString())
  assert.equal(manifest.rootSessionId, 'qa-a')
  assert.equal(manifest.sessions.length, 1)
  const entry = manifest.sessions[0]
  assert.equal(entry.sessionId, 'qa-a')
  assert.equal(createHash('sha256').update(files[entry.file]).digest('hex'), entry.sha256)
  assert.equal(JSON.parse(gunzipSync(files[entry.file]).toString()).sessionId, 'qa-a')
  console.log('[PASS] snapshot ZIP contains the selected session and matches its SHA-256')
  await operation('fixture.telemetry.snapshotWrongSession=true')
  await openBy('Download Host snapshot ZIP')
  await check('mismatched snapshot scope is rejected and released',
    'document.querySelector("[role=alert]")?.textContent && fixture.telemetry.snapshotClosed===2')
  assert.equal(await js('capturedDownloads.filter(item => item.name.endsWith(".zip")).length'), 1)
  await operation('fixture.telemetry.snapshotWrongSession=false; fixture.telemetry.snapshotDelay=500')
  await openBy('Download Host snapshot ZIP')
  await operation('fixture.remote.getState().openSession("qa-b")')
  await sleep(550)
  await check('changing sessions cancels an outstanding export', 'fixture.telemetry.snapshotClosed===3 && !document.querySelector("[role=dialog]")')
  assert.equal(await js('capturedDownloads.filter(item => item.name.endsWith(".zip")).length'), 1)
  await operation('fixture.remote.getState().openSession("qa-a")')
  await operation('fixture.openSettings("remote")')
  await openBy('Conversation shares and replay')
  await check('reopened share management loads the saved link', 'document.body.innerText.includes("Revoke link")', 4500)
  await changeInput('[role=dialog] input[maxlength="256"]', shareHref)
  await openBy('Open replay')
  await check('hosted conversation opens in read-only replay',
    '[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("article")?.textContent.includes("Confirm this once")')
  await openBy('Back to share management')
  await openBy('Revoke link')
  await operation('[...document.querySelectorAll("[role=dialog] button")].filter(button => button.textContent.trim()==="Revoke link").at(-1)?.click()')
  await check('revoked link is removed from local storage',
    '[...document.querySelectorAll("[role=dialog]")].at(-1)?.textContent.includes("No active shared links")')
  assert.equal(shareBlob, undefined)
  const fileData = shareFile.toString('base64')
  await operation(`(() => {
    const input = document.querySelector('[role=dialog] input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(fileData)}), character => character.charCodeAt(0))], 'qa.dshgo'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await check('local DSH Go file opens in read-only replay',
    '[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("article")?.textContent.includes("Confirm this once")')
  await closeManagement()
  await operation('[...document.querySelectorAll("summary")].find(x=>x.textContent==="Connection details")?.click()')
  await openBy('Export connection report')
  const report = JSON.parse((await readDownload('deepseek-chat-pad-connection.json')).toString())
  assert.equal(report.transport, 'relay')
  assert.equal(report.schemaVersion, 1)
  assert(Number.isFinite(report.connectMs) && Number.isFinite(report.secureChannelMs) &&
    Number.isFinite(report.capabilityProbeMs) && Number.isFinite(Date.parse(report.measuredAt)))
  assert(Object.keys(report).every((key) => ['schemaVersion', 'transport', 'connectMs', 'secureChannelMs',
    'capabilityProbeMs', 'hostRequestMs', 'measuredAt'].includes(key)))
  console.log('[PASS] connection report contains timing and transport fields only')
  await operation('fixture.openSettings("remote")')
  await openBy('Scheduled tasks')
  await openBy('New task')
  await changeInput('[role=dialog] form select', 'qa-b', 'change')
  await changeInput('[role=dialog] form > label input', 'Fixture new task')
  await changeInput('[role=dialog] form textarea', 'Deliver fixture task')
  await changeInput('[role=dialog] fieldset select', 'after', 'change')
  await openBy('Save')
  await check('schedule create addresses a chosen session without switching chats',
    'fixture.telemetry.calls.some(x=>x.endpoint==="schedule/create" && x.args.request.sessionId==="qa-b" && x.args.request.after_seconds===3600) && fixture.remote.getState().activeSessionId==="qa-a" && document.body.textContent.includes("Fixture new task")')
  await operation('[...document.querySelectorAll("[role=dialog] button")].filter(x=>x.textContent.trim()==="View details").at(-1)?.click()')
  await openBy('Edit task')
  await changeInput('[role=dialog] form > label input', 'Fixture renamed task')
  await openBy('Save')
  await check('schedule edit supplies the target task and its revision',
    'fixture.telemetry.calls.some(x=>x.endpoint==="schedule/edit" && x.args.request.id==="new-fixture-task" && x.args.request.action==="update" && x.args.request.expectedUpdatedAt && x.args.request.patch.title==="Fixture renamed task" && !("timing" in x.args.request.patch)) && document.body.textContent.includes("Fixture renamed task")')
  await openBy('Edit task')
  await changeInput('[role=dialog] fieldset select', 'every', 'change')
  await changeInput('[role=dialog] fieldset input[type=number]', '7200')
  await openBy('Save')
  await check('schedule timing edit updates only the rule with the target revision',
    'fixture.telemetry.calls.some(x=>x.endpoint==="schedule/edit" && x.args.request.id==="new-fixture-task" && x.args.request.expectedUpdatedAt && x.args.request.patch?.timing?.kind==="every" && x.args.request.patch.timing.every_seconds===7200 && Object.keys(x.args.request.patch).length===1)')
  await openBy('Delete task')
  await openBy('Delete task')
  await check('schedule deletion updates the catalog',
    'fixture.telemetry.calls.some(x=>x.endpoint==="schedule/edit" && x.args.request.id==="new-fixture-task" && x.args.request.action==="delete") && !document.body.textContent.includes("Fixture renamed task")')
  await operation('fixture.telemetry.scheduleCreateUnsupported=true; fixture.telemetry.sendOutcome="success"')
  await openBy('New task')
  await changeInput('[role=dialog] form > label input', 'Legacy fixture task')
  await changeInput('[role=dialog] form textarea', 'Legacy delivery')
  await openBy('Save')
  await check('legacy hosts get one queue request addressed to the selected session',
    'fixture.telemetry.calls.filter(x=>x.endpoint==="session/prompt" && x.args.request.sessionId==="qa-a" && JSON.stringify(x.args.request.content).includes("Legacy fixture task")).length===1')
  await closeManagement()
  await leaveSettings()
  await operation(`fixture.newSession.getState().openPanel()
    fixture.newSession.getState().addDraftFiles([
      new File(["first"], "first.txt", {type:"text/plain"}),
      new File(["second"], "second.txt", {type:"text/plain"})
    ])
    fixture.telemetry.failingUpload="second.txt"`)
  await enter()
  await check('a partial upload failure retains both attachment drafts and sends no prompt',
    'fixture.newSession.getState().open && fixture.newSession.getState().draftFiles.length===2 && fixture.newSession.getState().error?.includes("second.txt") && !fixture.telemetry.calls.some(x=>x.endpoint==="session/prompt" && x.args.request.content?.some(part=>part.type==="file"))')
  await operation('fixture.telemetry.failingUpload=""; fixture.telemetry.sendOutcome="reject"')
  await enter()
  await check('an explicitly rejected attachment-only first send keeps the composer open',
    'fixture.newSession.getState().open && fixture.newSession.getState().draftFiles.length===2 && !fixture.newSession.getState().creating')
  await operation('fixture.telemetry.sendOutcome="success"')
  await enter()
  await check('attachment-only retry keeps the original session and reuses its successful uploads', `(() => {
    const calls = fixture.telemetry.calls
    const uploads = calls.filter(x=>x.endpoint==="fileUploads/upload")
    const filePrompts = calls.filter(x=>x.endpoint==="session/prompt" && x.args.request.content?.some(part=>part.type==="file"))
    const sessionId = filePrompts[0]?.args.request.sessionId
    return uploads.length===3 && uploads.every(x=>x.args.agentId===sessionId) &&
      filePrompts.length===2 && filePrompts.every(x=>x.args.request.sessionId===sessionId &&
        x.args.request.content.length===2 && x.args.request.content.every(part=>part.type==="file" && part.receiptId.startsWith(sessionId+":"))) &&
      !fixture.newSession.getState().open && fixture.newSession.getState().draftFiles.length===0
  })()`)
  await operation('fixture.remote.getState().openSession("qa-a")')
  await changeInput('textarea', 'Draft only for the first Host')
  await operation('fixture.telemetry.sendOutcome="timeout"; fixture.remote.getState().send("Pending only for the first Host")')
  await operation('fixture.refreshInventory()')
  await operation(`fixture.telemetry.emitWorkspace({ type:'baseline', value:{ items:[
      {workspaceId:'folder', path:'/Project', title:'Tablet project', sessionIds:['qa-a']},
      {workspaceId:'other-folder', path:'/Other', title:'Other project', sessionIds:['qa-b']}
    ], archivedSessionIds:[], pinnedSessionIds:[] }})`)
  await check('Host workspaces appear in management', 'fixture.newSession.getState().hostWorkspaces.length === 2')
  await operation('fixture.openSettings("remote")')
  await openBy('Manage workspaces')
  await sleep(200)
  const chooseWorkspace = (id) => operation(`(() => { const s = [...document.querySelectorAll("[role=dialog]")].at(-1).querySelector("select"); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`)
  await chooseWorkspace('folder')
  await openBy('Pin workspace')
  await chooseWorkspace('other-folder')
  await openBy('Edit group')
  await changeInput('[role=dialog] input[list=remote-workspace-groups]', 'My project group')
  await openBy('Save')
  await check('settings saves workspace pins and groups to the originating Host', `(() => {
    const { pinned, groups } = fixture.newSession.getState().workspacePreferences;
    return pinned[0] === 'folder' && groups['other-folder'] === 'My project group';
  })()`)
  await closeManagement()
  await leaveSettings()
  await operation(`fixture.newSession.getState().openPanel();
    fixture.newSession.getState().openSheet('workspace');`)
  await check('new conversation chooser shows the pinned and grouped workspaces',
    'document.querySelector("[data-testid=workspace-sheet]").innerText.includes("Pinned") && document.querySelector("[data-testid=workspace-sheet]").innerText.includes("My project group")')
  await operation(`fixture.newSession.getState().openSheet('newWorkspace');
    fixture.newSession.getState().setPathDraft('/Recent folder');`)
  await openBy('Create workspace')
  await check('successfully created workspace remembers the chosen directory',
    'fixture.newSession.getState().workspacePreferences.recentDirectories[0] === "/Recent folder"')
  await operation(`fixture.newSession.getState().addDraftFiles([new File(['draft file for the new chat'], 'new-first-only.txt', {type:'text/plain'})]);
    fixture.newSession.getState().closePanel();`)
  await sleep(300)
  await operation('document.querySelector(\'[aria-controls="mobile-session-drawer"]\').click()')
  await operation('document.querySelector(\'#mobile-session-drawer button[aria-haspopup="dialog"]\').click()')
  await operation(`[...document.querySelectorAll('[role=dialog] button')].find(x => x.textContent.includes('Second Fixture Host')).click()`)
  await check('switches to another Host that contains the same session IDs',
    'fixture.remote.getState().phase==="ready" && fixture.remote.getState().hostId==="fixture-secondary" && fixture.remote.getState().sessions.some(x=>x.id==="qa-a")')
  await send('Page.reload')
  for (let attempt = 0; attempt < 70 && !await js('Boolean(window.fixture) && fixture.telemetry.calls.length===0').catch(() => false); attempt++) await sleep(90)
  await operation('window.__DS_NATIVE__ = true; fixture.remote.getState().retryAutoConnect()')
  await check('reload leaves the first Host selection and content out of the second Host',
    'fixture.remote.getState().hostId==="fixture-secondary" && !fixture.remote.getState().activeSessionId && !document.body.textContent.includes("Pending only for the first Host")')
  await operation('fixture.newSession.getState().openPanel(); fixture.refreshInventory()')
  await check('the second Host has no pinned, grouped, or recent workspaces from the first',
    'Object.keys(fixture.newSession.getState().workspacePreferences.groups).length===0 && fixture.newSession.getState().workspacePreferences.pinned.length===0 && fixture.newSession.getState().workspacePreferences.recentDirectories.length===0')
  await check('new chat does not restore the first Host file on the second Host', '!document.body.innerText.includes("new-first-only.txt")')
  await operation('fixture.newSession.getState().closePanel()')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('duplicate session IDs do not share the draft or the pending message',
    'fixture.remote.getState().activeSessionId==="qa-a" && document.querySelector("textarea").value==="" && !document.body.textContent.includes("Pending only for the first Host")')
  await recordVoice()
  await check('voice dictation inserts a draft without sending it to a Host',
    'document.querySelector("textarea").value==="Dictated only to this chat" && !fixture.telemetry.calls.some(x => x.endpoint==="session/prompt")', 4000)
  assert.equal(dictatedCount, 1)
  await changeInput('textarea', '')
  delayDictation = true
  await recordVoice()
  await operation('fixture.remote.getState().openSession("qa-b")')
  await sleep(530)
  await check('changing the active conversation discards the late dictation result',
    'fixture.remote.getState().activeSessionId==="qa-b" && document.querySelector("textarea").value===""')
  assert.equal(dictatedCount, 2)
  delayDictation = false
  await operation('fixture.telemetry.sendOutcome="success"; fixture.telemetry.voiceReply=true')
  await openBy('More actions')
  await openBy('Voice call')
  await recordVoice(true)
  await check('voice call sends only to its conversation and renders the matching reply',
    'fixture.telemetry.calls.some(x => x.endpoint==="session/prompt" && x.args.request.sessionId==="qa-b" && x.args.request.content[0].text==="Dictated only to this chat") && document.querySelector("[role=dialog]")?.innerText.includes("Only this call gets this reply")', 4000)
  for (let attempt = 0; attempt < 45 && !spoken; attempt++) await sleep(50)
  assert.equal(spoken, 'Only this call gets this reply')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('switching conversations ends voice capture and closes the call',
    '!document.querySelector("[role=dialog]") && document.querySelector("textarea").value===""')
  await operation('fixture.remote.getState().switchHost("fixture-host")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('reload recovers the first Host draft and pending message when it is reopened',
    'fixture.remote.getState().hostId==="fixture-host" && document.querySelector("textarea").value==="Draft only for the first Host" && fixture.remote.getState().items.some(x=>x.text==="Pending only for the first Host" && x.sendState==="unconfirmed")')
  await operation('fixture.refreshInventory(); fixture.newSession.getState().openPanel()')
  await check('first Host recovers new chat files and workspace preferences after reload',
    '(async () => { const file = fixture.newSession.getState().draftFiles.find(x=>x.name==="new-first-only.txt"); return (await file?.file.text())==="draft file for the new chat" && fixture.newSession.getState().workspacePreferences.groups["other-folder"]==="My project group" && fixture.newSession.getState().workspacePreferences.recentDirectories[0]==="/Recent folder"; })()')
  await operation('fixture.newSession.getState().closePanel()')
  await changeInput('textarea', '')
  await operation('fixture.workspace.getState().pickFiles([new File(["uploaded"], "ready-on-first-host.txt", {type:"text/plain"})])')
  await check('existing conversation shows its uploaded attachment',
    'fixture.workspace.getState().attachments.some(x=>x.name==="ready-on-first-host.txt" && x.status==="done") && document.body.innerText.includes("ready-on-first-host.txt")')
  await operation(`fixture.telemetry.slowUpload="interrupted.txt";
    void fixture.workspace.getState().pickFiles([new File(["draft"], "interrupted.txt", {type:"text/plain"})]);`)
  await check('attachment upload is in flight before disconnect',
    'fixture.workspace.getState().attachments.some(x=>x.name==="interrupted.txt" && x.status==="uploading") && fixture.telemetry.calls.some(x=>x.endpoint==="fileUploads/upload" && x.args.request.name==="interrupted.txt")')
  await operation('fixture.remote.getState().disconnect()')
  await operation('fixture.remote.getState().retryAutoConnect()')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await sleep(1400)
  await check('same Host restores receipt and interrupted file after reconnect and ignores the retired upload',
    'fixture.remote.getState().hostId==="fixture-host" && document.body.innerText.includes("ready-on-first-host.txt") && document.body.innerText.includes("interrupted.txt") && fixture.workspace.getState().attachments.some(x=>x.name==="interrupted.txt" && x.status==="error" && x.bytes?.length===5)')
  await operation('fixture.remote.getState().switchHost("fixture-secondary")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('duplicate session ID on another Host sees neither file',
    '!document.body.innerText.includes("ready-on-first-host.txt") && !document.body.innerText.includes("interrupted.txt")')
  await send('Page.reload')
  for (let attempt = 0; attempt < 70 && !await js('Boolean(window.fixture) && fixture.telemetry.calls.length===0').catch(() => false); attempt++) await sleep(90)
  await operation('window.__DS_NATIVE__ = true; fixture.remote.getState().retryAutoConnect()')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('reloading with the second Host does not restore the first Host attachments',
    'fixture.remote.getState().hostId==="fixture-secondary" && !document.body.innerText.includes("ready-on-first-host.txt") && !document.body.innerText.includes("interrupted.txt")')
  await operation('fixture.remote.getState().switchHost("fixture-host")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('reopening the original Host recovers the receipt and original interrupted file after reload',
    'fixture.workspace.getState().attachments.some(x=>x.name==="ready-on-first-host.txt" && x.status==="done" && x.receiptId==="qa-a:ready-on-first-host.txt") && fixture.workspace.getState().attachments.some(x=>x.name==="interrupted.txt" && x.status==="error" && x.file?.size===5)')
  await operation('fixture.telemetry.slowUpload=""; fixture.telemetry.sendOutcome="success"')
  await openBy('Retry upload')
  await check('retry in the originating conversation updates only the interrupted file',
    'fixture.workspace.getState().attachments.filter(x=>x.status==="done" && x.sessionId==="qa-a").length===2 && fixture.telemetry.calls.every(x=>x.endpoint!=="fileUploads/upload" || x.args.request.name!=="ready-on-first-host.txt")')
  await enter()
  await check('attachment-only send uses both receipts in the originating conversation',
    'fixture.telemetry.calls.some(x=>x.endpoint==="session/prompt" && x.args.request.sessionId==="qa-a" && x.args.request.content?.map(part=>part.receiptId).join(",")==="qa-a:ready-on-first-host.txt,qa-a:interrupted.txt") && fixture.workspace.getState().attachments.length===0')
  await operation('fixture.refreshInventory()')
  await operation(`fixture.remote.setState({ sessions: fixture.remote.getState().sessions.map(x => x.id==='qa-a' ? {...x, pinned:true, workspaceId:'private'} : x) });
    fixture.telemetry.emitWorkspace({ type:'baseline', value:{ items:[
      {workspaceId:'public', path:'/Public', title:'Public folder', sessionIds:['qa-b']},
      {workspaceId:'private', path:'/Private', title:'Private folder', sessionIds:['qa-a']}
    ], archivedSessionIds:[], pinnedSessionIds:['qa-a'] }})`)
  await check('workspace baseline updates the conversation drawer projections',
    'fixture.newSession.getState().workspaceSource==="follow" && fixture.newSession.getState().pinnedSessionIds[0]==="qa-a"')
  await operation(`fixture.telemetry.emitWorkspace({type:'order', workspaceIds:['private','public']});
    fixture.telemetry.emitWorkspace({type:'pinned', pinnedSessionIds:[]});
    fixture.telemetry.emitWorkspace({type:'archived', archivedSessionIds:['qa-b']})`)
  await check('workspace stream applies ordering, clears stale pins and applies archives',
    'fixture.newSession.getState().workspaces[0].workspaceId==="private" && fixture.newSession.getState().pinnedSessionIds.length===0 && fixture.newSession.getState().archivedSessionIds[0]==="qa-b"')
  await operation(`fixture.telemetry.emitWorkspace({type:'replace', value:{ items:[{workspaceId:'public', path:'/Public', title:'Public folder', sessionIds:['qa-b']}], archivedSessionIds:['qa-b'], pinnedSessionIds:[] }})`)
  await check('workspace replacement removes the previously accessible workspace',
    'fixture.newSession.getState().workspaces.map(x=>x.workspaceId).join(",")==="public"')
  await operation('fixture.workspace.setState({ refresh: fixture.workspaceRefresh }); fixture.workspace.getState().openPane()')
  await check('workspace opens with a directory watch scoped to the active chat',
    'document.body.innerText.includes("before.txt") && fixture.telemetry.calls.some(x=>x.endpoint==="workspaceFiles/changes" && x.args.workspaceFileScopeId==="qa-a" && x.args.path===".")')
  await operation('fixture.telemetry.workspaceFiles=["after.txt"]; fixture.telemetry.emitWorkspaceFile(".", {kind:"change",change:{absolutePath:"/project"}})')
  await sleep(250)
  await check('directory watch refreshes the visible listing',
    'document.body.innerText.includes("after.txt") && !document.body.innerText.includes("before.txt")')
  await operation('fixture.workspace.getState().openFile("after.txt")')
  await check('file preview subscribes to the opened file',
    'document.body.innerText.includes("Before change") && fixture.telemetry.calls.some(x=>x.endpoint==="workspaceFiles/changes" && x.args.path==="after.txt")')
  await operation('fixture.telemetry.workspaceText="After change"; fixture.telemetry.emitWorkspaceFile("after.txt", {kind:"change",change:{absolutePath:"/project/after.txt",version:"2"}})')
  await sleep(250)
  await check('visible preview reloads on a Host change', 'document.body.innerText.includes("After change")')
  await operation('fixture.workspace.getState().closePane()')
  await check('closing the workspace releases its file watch', 'fixture.telemetry.closed.filter(x=>x==="workspaceFiles/changes").length>=2')
  await operation('fixture.telemetry.historyEnabled=true; fixture.remote.getState().openSession("qa-b")')
  await openBy('Put text back in the composer')
  await check('an unanswered Host message restores into its own draft without sending',
    'document.querySelector("textarea").value==="Recover this older unanswered text" && !fixture.telemetry.calls.some(x=>x.endpoint==="session/prompt" && JSON.stringify(x.args.request.content).includes("Recover this older unanswered text"))')
  await operation('fixture.telemetry.historyDelay=350; void fixture.remote.getState().loadOlder()')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await sleep(360)
  await check('a late history page leaves the new conversation and its cursor untouched',
    'fixture.remote.getState().activeSessionId==="qa-a" && fixture.remote.getState().items.every(x=>x.sessionId==="qa-a") && !document.body.innerText.includes("Recover this older unanswered text")')
  await operation('fixture.telemetry.historyDelay=0; fixture.remote.getState().openSession("qa-b")')
  await openBy('Load earlier messages')
  await check('invisible events advance history without adding phantom messages',
    'fixture.telemetry.calls.filter(x=>x.endpoint==="session/page").at(-1)?.args.request.beforeSeq===12 && !document.body.innerText.includes("fixture/invisible")')
  await openBy('Load earlier messages')
  await check('next page follows the durable cursor and removes the paging button at the beginning',
    'fixture.telemetry.calls.filter(x=>x.endpoint==="session/page").at(-1)?.args.request.beforeSeq===11 && document.body.innerText.includes("An earlier prompt from this Host") && !document.body.innerText.includes("Load earlier messages")')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('earlier history and the recovered composer stay in the originating conversation',
    '!document.body.innerText.includes("An earlier prompt from this Host") && document.querySelector("textarea").value===""')
  await operation('fixture.remote.getState().openSession("qa-b")')
  await check('returning to a conversation restores its loaded history and draft',
    'document.body.innerText.includes("An earlier prompt from this Host") && !document.body.innerText.includes("Load earlier messages") && document.querySelector("textarea").value==="Recover this older unanswered text"')
  await operation('fixture.telemetry.forkFixture=true; fixture.telemetry.historyDelay=350; fixture.remote.getState().openSession("qa-a")')
  await check('the first prompt can be edited from a truncated visible window',
    'document.body.innerText.includes("Keep this first turn as a draft") && !document.querySelector("textarea").value')
  await openBy('Edit and resend')
  await check('first-prompt edit asks for contiguous durable history before the prompt',
    'fixture.telemetry.calls.some(x=>x.endpoint==="session/page" && x.args.request.beforeSeq===8 && x.args.request.throughSeq===7)')
  await operation('fixture.remote.getState().switchHost("fixture-secondary")')
  await sleep(420)
  await check('a delayed edit history page cannot fork on a different host',
    'fixture.remote.getState().hostId==="fixture-secondary" && !fixture.telemetry.calls.some(x=>x.endpoint==="session/fork")')
  await operation('fixture.telemetry.historyDelay=0; fixture.remote.getState().switchHost("fixture-host")')
  await check('the originating host is ready for the edit retry',
    'fixture.remote.getState().hostId==="fixture-host" && fixture.remote.getState().phase==="ready"')
  await operation('fixture.remote.getState().openSession("qa-a")')
  await openBy('Edit and resend')
  await check('first-prompt edit forks after startup settings and puts the original text in the fork draft',
    'fixture.remote.getState().activeSessionId==="qa-edited-first" && document.querySelector("textarea").value==="Keep this first turn as a draft" && fixture.telemetry.calls.some(x=>x.endpoint==="session/fork" && x.args.request.atSeq===2)')
  await operation('fixture.telemetry.forkFixture=false')
  await operation('fixture.remote.getState().switchHost("fixture-secondary")')
  changedHostIdentity = true
  await operation('fixture.remote.getState().switchHost("fixture-host")')
  await check('an unexpected Host key is rejected and the current Host stays isolated', `(() => {
    const state = fixture.remote.getState();
    return state.phase === 'ready' && state.hostId === 'fixture-secondary' &&
      state.hosts.some(host => host.deviceId === 'fixture-host' && host.identityMismatch) &&
      document.body.innerText.includes('已拒绝连接') &&
      !document.body.innerText.includes('Recover this older unanswered text') &&
      !document.body.innerText.includes('An earlier prompt from this Host');
  })()`)
  const rtcResult = await js('fixture.runRtcTransportQA()')
  console.log('WebRTC fixture', rtcResult)
  assert(['lan', 'p2p'].includes(rtcResult.transport) && rtcResult.roundTrip && rtcResult.chunks > 2
    && rtcResult.credentialsId === 'rtc-qa-connection' && !rtcResult.hostError
    && rtcResult.frames.indexOf('transport.selected') < rtcResult.frames.indexOf('secure.handshake')
    && !rtcResult.frames.includes('relay'), 'Chromium must exchange fragmented Noise ciphertext over a direct data channel')
  console.log('[PASS] Chromium peers exchange fragmented Noise ciphertext over a direct data channel')
  await operation(`fixture.openSettings('remote')`)
  await check('server relay remains the default for existing installations',
    'document.querySelector("select[aria-label=\'Connection path\']")?.value==="relay"')
  await changeInput('select[aria-label="Connection path"]', 'automatic', 'change')
  await operation(`fixture.telemetry.linkAttempts.length=0; fixture.telemetry.linkFailures=['WEBRTC_UNAVAILABLE','WEBRTC_UNAVAILABLE']; fixture.remote.getState().disconnect()`)
  await operation('fixture.remote.getState().retryAutoConnect()')
  await check('a failed direct and TURN path opens a fresh relay connection',
    'fixture.telemetry.linkAttempts.join(",")==="direct,turn,relay" && fixture.remote.getState().phase==="ready" && fixture.remote.getState().transport==="relay"')
  await operation(`window.dispatchEvent(new Event('online')); fixture.telemetry.linkAttempts.length=0; fixture.telemetry.linkFailures=['AUTH_REQUIRED']; fixture.remote.getState().disconnect()`)
  await operation('fixture.remote.getState().retryAutoConnect()')
  await check('a rejected authorization ends the attempt without trying another transport',
    'fixture.telemetry.linkAttempts.join(",")==="direct" && fixture.remote.getState().phase!=="ready"')
  await operation('fixture.remote.getState().retryAutoConnect()')
  await operation('fixture.refreshInventory()')
  await leaveSettings()
  await operation(`fixture.newSession.getState().openPanel(); fixture.newSession.getState().selectWorkspace(null);
    fixture.newSession.getState().addDraftFiles([
      new File(['done'], 'before-reload.txt', {type:'text/plain'}),
      new File(['retry'], 'after-reload.txt', {type:'text/plain'}),
    ]);
    fixture.telemetry.failingUpload='after-reload.txt';
    fixture.newSession.getState().createAndSend('Resume the first prompt')`)
  const resumeId = await js('fixture.telemetry.calls.find(x=>x.endpoint==="fileUploads/upload" && x.args.request.name==="before-reload.txt")?.args.agentId')
  assert(resumeId, 'The first relative upload must complete before reload')
  await send('Page.reload')
  for (let attempt = 0; attempt < 70 && !await js('Boolean(window.fixture) && fixture.telemetry.calls.length===0').catch(() => false); attempt++) await sleep(90)
  await operation('window.__DS_NATIVE__=true; fixture.remote.getState().retryAutoConnect()')
  await operation('fixture.refreshInventory()')
  await operation(`fixture.newSession.getState().openPanel(); fixture.newSession.getState().selectWorkspace(null);
    fixture.telemetry.sendOutcome='success'; fixture.newSession.getState().createAndSend('Resume the first prompt')`)
  await check('first delivery resumes the original new conversation and attachment receipt after reload', `(() => {
    const id=${JSON.stringify(resumeId)};
    const calls = fixture.telemetry.calls;
    return fixture.remote.getState().activeSessionId===id && !fixture.newSession.getState().open &&
      !calls.some(x=>x.endpoint==='session/create' || (x.endpoint==='fileUploads/upload' && x.args.request.name==='before-reload.txt')) &&
      calls.some(x=>x.endpoint==='session/prompt' && x.args.request.sessionId===id &&
        x.args.request.content.filter(part=>part.type==='file').map(part=>part.receiptId).join(',')===id+':before-reload.txt,'+id+':after-reload.txt');
  })()`)
  await operation(`fixture.newSession.getState().openPanel(); fixture.telemetry.voiceReply=true;
    fixture.telemetry.calls.length=0; fixture.telemetry.createDelay=1500`)
  await openBy('Voice call')
  await recordVoice(true)
  await check('new voice call begins creating a conversation only after recording',
    'fixture.telemetry.calls.some(x => x.endpoint === "session/create")', 1000)
  await openBy('End call')
  await sleep(1550)
  await check('ending a new call while creating sends nothing',
    'fixture.newSession.getState().open && !fixture.telemetry.calls.some(x => x.endpoint === "session/prompt")')
  spoken = ''
  await operation('fixture.telemetry.createDelay=0; fixture.telemetry.calls.length=0; fixture.telemetry.voiceStream=true')
  await openBy('Voice call')
  await recordVoice(true)
  await check('voice call starts reading a complete sentence while the turn is running',
    'fixture.remote.getState().streaming && typeof fixture.telemetry.finishVoice==="function" && document.querySelector("[role=dialog]")?.innerText.includes("I have a first sentence.")', 4000)
  for (let attempt = 0; attempt < 45 && !spoken; attempt++) await sleep(50)
  assert.equal(spoken, 'I have a first sentence.')
  await operation('fixture.telemetry.finishVoice()')
  await check('new voice call follows its new conversation and hears its first reply', `(() => {
    const id=fixture.remote.getState().activeSessionId;
    const calls=fixture.telemetry.calls;
    return id && id !== ${JSON.stringify(resumeId)} && !fixture.newSession.getState().open &&
      calls.filter(x=>x.endpoint==='session/prompt').length===1 &&
      calls.some(x=>x.endpoint==='session/prompt' && x.args.request.sessionId===id) &&
      document.querySelector('[role="dialog"]')?.innerText.includes('Only this call gets this reply');
  })()`)
  for (let attempt = 0; attempt < 45 && spoken !== 'Only this call gets this reply'; attempt++) await sleep(50)
  assert.equal(spoken, 'Only this call gets this reply')
  await openBy('End call')
  await openBy('More actions')
  await openBy('Conversation details')
  await check('conversation details exposes trace, changes, delivered files, progress, and context at split width',
    '["Trace","Changes","Delivered files","Progress","Context"].every(label=>[...document.querySelectorAll("[role=dialog] nav button")].some(x=>x.textContent===label))')
  await openBy('Context')
  await check('conversation context shows usage and scoped subagents',
    'document.querySelector("[role=dialog]")?.innerText.includes("Usage") && document.querySelector("[role=dialog]")?.innerText.includes("Subagents")')
  await openBy('Delivered files')
  await check('deliverables tab has its own empty state',
    'document.querySelector("[role=dialog]")?.innerText.includes("No delivered files in the loaded history.")')
  await operation('document.querySelector("[role=dialog] button[aria-label=Close]")?.click()')
  await operation('fixture.telemetry.workspaceFiles=["sample.pdf","sample.docx"]; fixture.workspace.getState().openPane()')
  await operation('fixture.workspace.getState().openFile("sample.pdf")')
  await check('PDF preview renders a workspace page on the canvas', `(() => {
    const canvas = document.querySelector('canvas[aria-label="Page 1 of 2"]');
    return canvas && !canvas.hidden && canvas.getContext('2d').getImageData(12, 12, 1, 1).data[0] < 100;
  })()`, 5000)
  await openBy('Next page')
  await check('PDF preview advances a page and uses its aspect ratio',
    'Boolean(document.querySelector(\'canvas[aria-label="Page 2 of 2"]:not([hidden])\')?.width > 300)', 5000)
  await operation('fixture.workspace.getState().openFile("sample.docx")')
  await check('Office preview verifies and renders the Host conversion for the active session', `(() => {
    const sessionId = fixture.remote.getState().activeSessionId;
    return document.querySelector('canvas[aria-label="Page 1 of 2"]:not([hidden])') &&
      document.body.innerText.includes('Fixture Sans') && fixture.telemetry.calls.some(x => x.endpoint === 'officeToPdf/render' &&
      x.args.workspaceFileScopeId === sessionId && x.args.path === 'sample.docx');
  })()`, 5000)
  await operation('fixture.workspace.getState().closePane(); fixture.openSettings("remote")')
  await openBy('Connect SSH host')
  await changeInput('input[name="host"]', 'tablet-ssh.test')
  await changeInput('input[name="user"]', 'fixture')
  await changeInput('input[name="fingerprint"]', 'SHA256:' + 'A'.repeat(43))
  await changeInput('input[name="password"]', 'fixture-ssh')
  await operation(`(() => { const select=document.querySelector('select option[value=attach]').parentElement;
    select.value='attach'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await changeInput('input[name="launchToken"]', 'fixture-launch')
  await operation('document.querySelector(\'form:has(input[name="host"]) button[type=submit]\').click()')
  await check('SSH uses the HTTP Host inventory and separates a duplicate session ID from previous relay Hosts',
    'fixture.remote.getState().transport==="ssh" && fixture.remote.getState().phase==="ready" && fixture.remote.getState().sessions[0]?.title==="SSH-only conversation"', 6000)
  await leaveSettings()
  await operation('fixture.remote.getState().openSession("qa-a")')
  await check('SSH stream renders the selected conversation and clears the previous Host draft',
    'fixture.remote.getState().items.some(x=>x.text==="SSH-only response") && document.querySelector("textarea").value===""', 5000)
  await operation('fixtureSshSocket.close()')
  await check('SSH reconnect reopens the same conversation after a lost stream',
    'fixture.remote.getState().transport==="ssh" && fixture.remote.getState().phase==="ready" && fixture.remote.getState().activeSessionId==="qa-a"', 7000)
  assert.equal(sshConnectCount, 2)
  await operation('fixture.openSettings("remote")')
  await openBy('Host plugin settings')
  await check('SSH loads the complete configuration and selects the active schema variant',
    'document.body.innerText.includes("Enable nested option")', 5000)
  await openBy('Edit')
  await operation(`(() => {
    const select = document.querySelector('[role=dialog] form select');
    select.value = 'true';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await openBy('Save')
  await check('SSH plugin settings recovers the detail at the next opaque revision',
    'document.body.innerText.includes("Enable nested option\\ntrue") && !document.querySelector("[role=dialog] form")', 5000)
  assert.equal(sshPluginRevision, 'opaque:plugin:changed')
  await operation('[...document.querySelectorAll("[role=dialog]")].at(-1)?.querySelector("button[aria-label=Close]")?.click()')
  await openBy('Host plugins')
  await openBy('Plugin marketplace')
  await check('market falls back to the official publication source and shows localized package metadata',
    'document.body.innerText.includes("Tablet notes plugin")', 5000)
  await openBy('Install')
  await check('market shows the exact package version and risk before installation',
    'document.body.innerText.includes("Install Tablet notes plugin 1.2.0 on this host?") && document.body.innerText.includes("filesystem")')
  assert.equal(installedSshPackage, false)
  await openBy('Install on host')
  await check('SSH market requires consent for the exact blocked build scripts',
    'document.body.innerText.includes("The host blocked build scripts for @tablet/dependency.")')
  assert.equal(installedSshPackage, false)
  await openBy('Allow build scripts and retry')
  await check('market refreshes the installed version after the host applies the change', 'document.body.innerText.includes("Installed 1.2.0")', 5000)
  assert.equal(installedSshPackage, true)
  await openBy('Installed plugins')
  await openBy('Remove package')
  await check('market package removal asks for confirmation',
    'document.body.innerText.includes("Remove @tablet/notes-plugin from this host?")')
  assert.equal(installedSshPackage, true)
  await openBy('Remove package')
  await check('market package removal refreshes the host inventory',
    'document.body.innerText.includes("Host result: applied") && !document.body.innerText.includes("@tablet/notes-plugin")')
  assert.equal(installedSshPackage, false)
  await operation('fixture.closeSettings(); fixture.newSession.getState().openPanel(); fixture.newSession.getState().openSheet("newWorkspace")')
  await openBy('Browse')
  await check('SSH shows the directory picker at the Host path',
    'fixture.newSession.getState().directory?.path === "/project" && document.querySelector("[data-testid=new-workspace-sheet]")?.textContent.includes("New folder")', 5000)
  await openBy('New folder')
  await changeInput('input[aria-label="Folder name"]', 'Tablet notes')
  await openBy('New folder')
  await check('SSH creates one folder and selects the returned path',
    'document.querySelector("#new-session-workspace-path")?.value === "/project/Tablet notes"', 5000)
  assert.equal(sshFolder, '/project/Tablet notes')
  await operation(`fixture.newSession.getState().closePanel();
    Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('SSH-only conversation'))?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));`)
  await openBy('Delete conversation permanently')
  await check('SSH asks for confirmation before deleting the selected conversation',
    'document.body.innerText.includes("Permanently delete")')
  assert.equal(sshDeleted, false)
  await openBy('Delete conversation permanently')
  await check('SSH confirms deletion and clears this Host conversation',
    'fixture.remote.getState().activeSessionId !== "qa-a" && !fixture.remote.getState().sessions.some(x => x.id === "qa-a")', 5000)
  assert.equal(sshDeleted, true)
  await send('Page.reload')
  await check('reloading after SSH startup does not connect to an earlier relay host',
    'Boolean(window.fixture) && !fixture.telemetry.linkAttempts.length && fixture.remote.getState().phase==="idle" && fixture.remote.getState().lastSession?.transport==="ssh"', 8000)
  await operation('fixture.openSettings("remote")')
  await openBy('Reconnect SSH host')
  await check('SSH restores non-secret connection form values',
    'document.querySelector("input[name=host]")?.value==="tablet-ssh.test" && document.querySelector("input[name=user]")?.value==="fixture" && document.querySelector("input[name=launchToken]")?.value==="" && document.querySelector("input[name=password]")?.value===""')
  await operation(`(() => { const key='dsp.remote.ssh.profiles.v2';
    const profiles=JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key,JSON.stringify([...profiles,{...profiles[0],host:'second-tablet-ssh.test',mode:'managed'}]));
    [...document.querySelectorAll('button')].find(x=>x.textContent==='Cancel')?.click();
  })()`)
  await openBy('Reconnect SSH host')
  await check('SSH picker lists two saved profiles without serializing their passwords or tokens',
    'document.body.innerText.includes("Saved SSH hosts") && document.querySelectorAll("select option").length>4 && !localStorage.getItem("dsp.remote.ssh.profiles.v2").includes("fixture-ssh") && !localStorage.getItem("dsp.remote.ssh.profiles.v2").includes("fixture-launch")')
  await operation(`(() => { const option=[...document.querySelectorAll('select option')].find(x=>x.textContent.includes('second-tablet-ssh.test'));
    option.parentElement.value=option.value; option.parentElement.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  await check('choosing another saved SSH profile refreshes its form and leaves credentials blank',
    'document.querySelector("input[name=host]")?.value==="second-tablet-ssh.test" && !document.querySelector("input[name=password]")?.value && !document.querySelector("input[name=launchToken]")')
  await openBy('Forget host')
  await check('forgetting an SSH profile asks for confirmation',
    'document.body.innerText.includes("Remove this SSH host and its saved credentials from this device?")')
  await openBy('Forget host')
  await check('forgetting an SSH profile leaves other saved hosts available',
    'JSON.parse(localStorage.getItem("dsp.remote.ssh.profiles.v2")).length===1 && document.querySelector("input[name=host]")?.value===""')
} catch (error) {
  annotate(error)
  throw error
} finally {
  socket?.close()
  child.kill()
  fs.closeSync(log)
  server.close()
}


