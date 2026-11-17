#!/usr/bin/env node
/**
 * Android 壳工程静态自检（本机没有 JDK/SDK，无法真正编译）。
 *
 * 覆盖：
 *  1. Java：剥掉注释与字符串/字符字面量后，检查 {} () [] 是否配平、字面量是否闭合、
 *     package 声明、类名与文件名一致、每个 import 的简单名在正文里确实出现过。
 *  2. Java：同一文件内声明的类型/方法名的方法调用无法静态验证，只做粗粒度交叉引用检查
 *     （用到的自定义类是否在工程里存在）。
 *  3. XML：井号/标签配平（用 Node 侧简单校验）+ 资源引用是否都有定义。
 *  4. Gradle：关键 DSL 字面量检查（namespace / buildConfig / compileSdk / minSdk / targetSdk）。
 *
 * 退出码：0 全绿，1 有 FAIL。报告写到同目录 report.json。
 * 开跑先删旧报告：崩在半路不会留下上一次的结论骗人。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', 'android')
const REPORT_PATH = path.join(__dirname, 'check-android-shell.report.json')

try {
  fs.unlinkSync(REPORT_PATH)
} catch {
  /* 没有旧报告 */
}

const checks = []
function ok(name, detail) {
  checks.push({ level: 'PASS', name, detail })
}
function fail(name, detail) {
  checks.push({ level: 'FAIL', name, detail })
}
function info(name, detail) {
  checks.push({ level: 'INFO', name, detail })
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === '.gradle' || entry.name === 'node_modules') continue
      walk(full, filter, out)
    } else if (filter(entry.name)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/')

// ---------------------------------------------------------------- 1. Java 结构检查

/**
 * 逐字符扫描，产出“代码骨架上每个字符是否处于注释/字面量之外”，
 * 用来做括号配平与未闭合字面量检测。
 */
function javaSkeleton(source, file) {
  const problems = []
  let brace = 0
  let paren = 0
  let bracket = 0
  const stack = []
  let i = 0
  let line = 1
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++
        i++
      }
      if (i >= n) problems.push(`${file}:${line} 块注释未闭合`)
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      i++
      let closed = false
      while (i < n) {
        const c = source[i]
        if (c === '\\') {
          if (source[i + 1] === '\n') line++
          i += 2
          continue
        }
        if (c === '\n') break // Java 里双引号字符串不能跨行（无 \ 续行）
        if (c === quote) {
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) problems.push(`${file}:${startLine} 字面量未闭合`)
      continue
    }
    if (ch === '{') {
      brace++
      stack.push({ ch, line })
    } else if (ch === '}') {
      brace--
      if (brace < 0) problems.push(`${file}:${line} 多余的 '}'`)
      const top = stack.pop()
      if (top && top.ch !== '{') problems.push(`${file}:${line} '}' 与第 ${top.line} 行的 '${top.ch}' 不匹配`)
    } else if (ch === '(') {
      paren++
      stack.push({ ch, line })
    } else if (ch === ')') {
      paren--
      if (paren < 0) problems.push(`${file}:${line} 多余的 ')'`)
      const top = stack.pop()
      if (top && top.ch !== '(') problems.push(`${file}:${line} ')' 与第 ${top.line} 行的 '${top.ch}' 不匹配`)
    } else if (ch === '[') {
      bracket++
    } else if (ch === ']') {
      bracket--
      if (bracket < 0) problems.push(`${file}:${line} 多余的 ']'`)
    }
    i++
  }
  if (brace !== 0) problems.push(`${file} 结束时 {} 差 ${brace}`)
  if (paren !== 0) problems.push(`${file} 结束时 () 差 ${paren}`)
  if (bracket !== 0) problems.push(`${file} 结束时 [] 差 ${bracket}`)
  return problems
}

const javaFiles = walk(path.join(ROOT, 'app/src/main/java'), (name) => name.endsWith('.java'))
if (javaFiles.length === 0) fail('java.files', '没找到任何 .java 文件')

const knownClasses = new Set(['MainActivity', 'LocalServer', 'AssetHandler', 'ProxyHandler', 'HttpUtil'])
const javaProblems = []
const stringCollisions = []

for (const file of javaFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const name = path.basename(file, '.java')
  javaProblems.push(...javaSkeleton(source, rel(file)))

  if (!source.includes('package ai.deepseek.tablet;')) {
    javaProblems.push(`${rel(file)} 缺少 package ai.deepseek.tablet;`)
  }
  const classDecl = new RegExp(`(class|interface|enum)\\s+${name}\\b`)
  if (!classDecl.test(source)) {
    javaProblems.push(`${rel(file)} 里没有与文件名同名的类型 ${name}`)
  }

  // import 的简单名必须真的在正文里用到（只查我们自己的类之外的显式 import）
  const importRe = /^import\s+(static\s+)?([\w.]+);/gm
  let match
  while ((match = importRe.exec(source)) !== null) {
    const fqcn = match[2]
    const simple = fqcn.split('.').pop()
    if (!simple || simple === '*') continue
    const body = source.replace(/^import[^\n]*$/gm, '')
    const used = new RegExp(`\\b${simple}\\b`).test(body)
    if (!used) stringCollisions.push(`${rel(file)} import ${simple} 但正文里没用到（只是整洁性问题）`)
  }

  // 引用了工程内其他类：确认存在
  for (const cls of knownClasses) {
    if (cls === name) continue
    const otherFile = javaFiles.find((candidate) => path.basename(candidate, '.java') === cls)
    if (!otherFile && new RegExp(`\\b${cls}\\b`).test(source)) {
      javaProblems.push(`${rel(file)} 引用了不存在的类 ${cls}`)
    }
  }
}

if (javaProblems.length === 0) ok('java.structure', `${javaFiles.length} 个 Java 文件括号/字面量全部配平`)
else fail('java.structure', javaProblems.join('\n       '))

if (stringCollisions.length === 0) ok('java.imports', 'import 全部被正文使用')
else info('java.unused-imports', stringCollisions.join('\n       '))

// ---------------------------------------------------------------- 2. 资源引用交叉校验

function collectDefinedResources() {
  const defined = { string: new Set(), color: new Set(), style: new Set(), drawable: new Set(), xml: new Set(), mipmap: new Set() }
  const resDir = path.join(ROOT, 'app/src/main/res')
  for (const dir of fs.existsSync(resDir) ? fs.readdirSync(resDir) : []) {
    const full = path.join(resDir, dir)
    if (!fs.statSync(full).isDirectory()) continue
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.xml')) continue
      if (dir.startsWith('values')) {
        const text = fs.readFileSync(path.join(full, file), 'utf8')
        for (const m of text.matchAll(/<string\s+name="([^"]+)"/g)) defined.string.add(m[1])
        for (const m of text.matchAll(/<color\s+name="([^"]+)"/g)) defined.color.add(m[1])
        for (const m of text.matchAll(/<style\s+name="([^"]+)"/g)) defined.style.add(m[1])
      } else {
        const base = file.replace(/\.xml$/, '')
        if (dir.startsWith('drawable')) defined.drawable.add(base)
        else if (dir.startsWith('xml')) defined.xml.add(base)
        else if (dir.startsWith('mipmap')) defined.mipmap.add(base)
        else if (dir === 'layout') {
          /* 本项目不用 layout xml，视图全在代码里搭 */
        }
      }
    }
  }
  return defined
}

const defined = collectDefinedResources()
const resourceProblems = []
const resourceRefRe = /@(string|color|style|drawable|xml|mipmap|android:color)\/([A-Za-z0-9_.]+)/g
const xmlFiles = walk(path.join(ROOT, 'app/src/main'), (name) => name.endsWith('.xml'))
for (const file of xmlFiles) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(resourceRefRe)) {
    const kind = m[1]
    const name = m[2]
    if (kind.startsWith('android:')) continue // 框架资源不校验
    const bucket = defined[kind]
    if (!bucket) {
      resourceProblems.push(`${rel(file)} 引用了未校验的类型 @${kind}/${name}`)
      continue
    }
    if (!bucket.has(name)) resourceProblems.push(`${rel(file)} 引用了不存在的资源 @${kind}/${name}`)
  }
}
// 代码里的 R.xxx.yyy
const rRefRe = /\bR\.(string|color|style|drawable|xml|mipmap)\.([A-Za-z0-9_]+)/g
for (const file of javaFiles) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(rRefRe)) {
    const bucket = defined[m[1]]
    if (bucket && !bucket.has(m[2])) resourceProblems.push(`${rel(file)} 引用了不存在的资源 R.${m[1]}.${m[2]}`)
  }
}
if (resourceProblems.length === 0) {
  ok('res.references', `${xmlFiles.length} 个 XML 的资源引用全部有定义`)
} else {
  fail('res.references', resourceProblems.join('\n       '))
}

// ---------------------------------------------------------------- 3. XML 标签配平

const tagProblems = []
for (const file of xmlFiles) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.trimStart().startsWith('<?xml')) tagProblems.push(`${rel(file)} 缺少 XML 声明`)
  if (/<manifest[\s\S]*?\spackage=/.test(text)) tagProblems.push(`${rel(file)} manifest 里还留着 package 属性（AGP 8 用 namespace）`)
  const stack = []
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '')
  for (const m of stripped.matchAll(/<(\/?)([A-Za-z0-9_:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const closing = m[1] === '/'
    const tag = m[2]
    const selfClosing = m[4] === '/'
    if (closing) {
      const top = stack.pop()
      if (top !== tag) tagProblems.push(`${rel(file)} 闭合标签 </${tag}> 与 <${top}> 不匹配`)
    } else if (!selfClosing) {
      stack.push(tag)
    }
  }
  if (stack.length > 0) tagProblems.push(`${rel(file)} 未闭合标签: ${stack.join(', ')}`)
}
if (tagProblems.length === 0) ok('xml.wellformed', `${xmlFiles.length} 个 XML 标签全部配平`)
else fail('xml.wellformed', tagProblems.join('\n       '))

// ---------------------------------------------------------------- 4. Gradle / 清单关键项

function readGradle(relPath) {
  const file = path.join(ROOT, relPath)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

const appGradle = readGradle('app/build.gradle')
const gradleExpectations = [
  ["namespace 'ai.deepseek.tablet'", /namespace\s+'ai\.deepseek\.tablet'/],
  ['compileSdk 34', /compileSdk\s+34\b/],
  ['minSdk 28', /minSdk\s+28\b/],
  ['targetSdk 34', /targetSdk\s+34\b/],
  ["applicationId 'ai.deepseek.tablet'", /applicationId\s+'ai\.deepseek\.tablet'/],
  ['versionCode 1', /versionCode\s+1\b/],
  ["versionName '1.0.0'", /versionName\s+'1\.0\.0'/],
  ['buildConfig true', /buildConfig\s+true/],
  ['Java 17', /JavaVersion\.VERSION_17/],
  ['minifyEnabled false', /minifyEnabled\s+false/],
  ['okhttp 4.12.0', /com\.squareup\.okhttp3:okhttp:4\.12\.0/],
  ['无遗留 package 属性写法', /^(?![\s\S]*^\s*package\s+'ai\.deepseek\.tablet'\s*$)/m]
]
const gradleProblems = []
if (!appGradle) gradleProblems.push('缺少 app/build.gradle')
else {
  for (const [label, re] of gradleExpectations) {
    if (!re.test(appGradle)) gradleProblems.push(`app/build.gradle 未满足: ${label}`)
  }
}
const rootGradle = readGradle('build.gradle')
if (!rootGradle || !/com\.android\.application'?\s+version\s+'8\.4\.\d+'/.test(rootGradle)) {
  gradleProblems.push("根 build.gradle 缺少 AGP 8.4.x 版本声明")
}
if (gradleProblems.length === 0) ok('gradle.dsl', 'AGP 8.4 / compileSdk 34 / minSdk 28 / Java 17 / buildConfig 均就位')
else fail('gradle.dsl', gradleProblems.join('\n       '))

// 清单权限与安全配置
const manifest = fs.readFileSync(path.join(ROOT, 'app/src/main/AndroidManifest.xml'), 'utf8')
const manifestProblems = []
const declaredPermissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1])
const expected = ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE']
for (const permission of expected) {
  if (!declaredPermissions.includes(permission)) manifestProblems.push(`清单缺少权限 ${permission}`)
}
for (const permission of declaredPermissions) {
  if (!expected.includes(permission)) manifestProblems.push(`清单多了不该有的权限 ${permission}`)
}
if (!/android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest)) {
  manifestProblems.push('清单没有引用 networkSecurityConfig')
}
if (/@android:style|android:theme="@android:style/.test(manifest)) {
  manifestProblems.push('清单用了框架主题，AppCompatActivity 需要 AppCompat 主题')
}
const nsc = fs.readFileSync(path.join(ROOT, 'app/src/main/res/xml/network_security_config.xml'), 'utf8')
if (!/<base-config\s+cleartextTrafficPermitted="false"/.test(nsc)) manifestProblems.push('NSC 没有默认禁止明文')
for (const host of ['127.0.0.1', 'localhost']) {
  if (!nsc.includes(`>${host}<`)) manifestProblems.push(`NSC 没有放行 ${host}`)
}
if (manifestProblems.length === 0) ok('manifest.security', '仅 INTERNET/ACCESS_NETWORK_STATE，明文只放行回环')
else fail('manifest.security', manifestProblems.join('\n       '))

// ---------------------------------------------------------------- 5. 关键实现断言（防止写漏需求点）

function readJava(name) {
  const file = path.join(ROOT, 'app/src/main/java/ai/deepseek/tablet', `${name}.java`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
const mainActivity = readJava('MainActivity')
const localServer = readJava('LocalServer')
const proxy = readJava('ProxyHandler')
const asset = readJava('AssetHandler')
const httpUtil = readJava('HttpUtil')

const featureChecks = [
  ['端口由系统分配', /new ServerSocket\(0\b/.test(localServer)],
  ['只监听 127.0.0.1', /127\.0\.0\.1/.test(localServer)],
  ['健康检查 /__ds_health', localServer.includes('/__ds_health') && localServer.includes('BuildConfig.VERSION_NAME')],
  ['代理路由 /__ds_proxy', localServer.includes('/__ds_proxy')],
  ['代理只允许 https', /https_required/.test(proxy) && /startsWith\("https:\/\/"\)/.test(proxy)],
  ['响应 chunked 分块', /Transfer-Encoding/.test(proxy) && httpUtil.includes('writeChunk')],
  ['每块立即 flush（真流式）', /writeChunk\(out, buffer, 0, read\);\s*\n\s*out\.flush\(\);/.test(proxy)],
  ['SSE no-cache', /text\/event-stream/.test(proxy) && /no-cache/.test(proxy)],
  ['共享 OkHttpClient（不是每请求新建）', (proxy.match(/new OkHttpClient/g) || []).length === 0 && (mainActivity.match(/new OkHttpClient/g) || []).length === 1],
  ['textZoom 固定 100', /setTextZoom\(100\)/.test(mainActivity)],
  ['媒体无需手势', /setMediaPlaybackRequiresUserGesture\(false\)/.test(mainActivity)],
  ['关闭 overscroll', /OVER_SCROLL_NEVER/.test(mainActivity)],
  ['WebView 背景 0xFF0F1115', /0xFF0F1115/.test(mainActivity)],
  ['file access 关闭', /setAllowFileAccess\(false\)/.test(mainActivity)],
  ['DOM Storage 开启', /setDomStorageEnabled\(true\)/.test(mainActivity)],
  ['文件选择 onShowFileChooser', /onShowFileChooser/.test(mainActivity) && /ACTION_GET_CONTENT/.test(mainActivity)],
  ['文件选择取消返回空数组', /new Uri\[0\]/.test(mainActivity)],
  ['外链交给系统浏览器', /ACTION_VIEW/.test(mainActivity)],
  ['返回键 OnBackPressedCallback', /OnBackPressedCallback/.test(mainActivity) && /canGoBack\(\)/.test(mainActivity)],
  ['setDecorFitsSystemWindows', /setDecorFitsSystemWindows\(window, false\)/.test(mainActivity)],
  ['渲染进程兜底', /onRenderProcessGone/.test(mainActivity)],
  ['后台线程起服务器', /new Thread\(\(\) ->/.test(mainActivity) && /mainHandler\.post/.test(mainActivity)],
  ['退出关闭服务器', /server\.stop\(\)/.test(mainActivity) && /serverSocket = null/.test(localServer)],
  ['静态 MIME 映射', /image\/svg\+xml/.test(asset) && /application\/wasm/.test(asset) && /font\/woff2/.test(asset)],
  ['static/ 长缓存 + html no-cache', /immutable/.test(asset) && /no-cache/.test(asset)],
  ['路径穿越防护', /\.\./.test(asset) && /normalizePath/.test(asset)]
]
const featureProblems = featureChecks.filter(([, pass]) => !pass).map(([label]) => label)
if (featureProblems.length === 0) ok('features', `${featureChecks.length} 项需求断言全部命中`)
else fail('features', `未命中: ${featureProblems.join(', ')}`)

// ---------------------------------------------------------------- 汇总

const failures = checks.filter((c) => c.level === 'FAIL')
const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  summary: {
    pass: checks.filter((c) => c.level === 'PASS').length,
    fail: failures.length,
    info: checks.filter((c) => c.level === 'INFO').length
  },
  checks
}
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')

for (const check of checks) {
  const tag = check.level === 'PASS' ? 'PASS' : check.level === 'FAIL' ? 'FAIL' : 'INFO'
  process.stdout.write(`[${tag}] ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`)
}
process.stdout.write(
  `\n合计: ${report.summary.pass} PASS / ${report.summary.fail} FAIL / ${report.summary.info} INFO\n`
)
process.exit(failures.length === 0 ? 0 : 1)
