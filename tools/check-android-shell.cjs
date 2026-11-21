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

const knownClasses = new Set([
  'MainActivity',
  'LocalServer',
  'AssetHandler',
  'ProxyHandler',
  'HttpUtil',
  'WebBundle',
  'UpdateHandler',
  'ApkUpdater',
  'ChatDatabase',
  'DbHandler',
  'RemoteDownloadHandler'
])
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
      if (dir.startsWith('values')) {
        if (!file.endsWith('.xml')) continue
        const text = fs.readFileSync(path.join(full, file), 'utf8')
        for (const m of text.matchAll(/<string\s+name="([^"]+)"/g)) defined.string.add(m[1])
        for (const m of text.matchAll(/<color\s+name="([^"]+)"/g)) defined.color.add(m[1])
        for (const m of text.matchAll(/<style\s+name="([^"]+)"/g)) defined.style.add(m[1])
        continue
      }
      // 非 values 目录：xml 与位图都算资源定义（自适应图标引用的 ic_launcher_foreground
      // 是 mipmap-*/ic_launcher_foreground.png，只收 .xml 会误报缺失）
      const base = file.replace(/(\.9)?\.(xml|png|webp|jpg|jpeg|gif)$/, '')
      if (base === file) continue
      if (dir.startsWith('drawable')) defined.drawable.add(base)
      else if (dir.startsWith('xml')) defined.xml.add(base)
      else if (dir.startsWith('mipmap')) defined.mipmap.add(base)
      else if (dir === 'layout') {
        /* 本项目不用 layout xml，视图全在代码里搭 */
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
  // 版本号不在 gradle 里写死：versionCode 由 CI 用 run number 覆盖（保证递增可覆盖安装），
  // versionName 来自 version.properties（发布时只改那一处）
  ['versionCode 接 CI 覆盖', /versionCode\s+ciVersionCode\b/],
  ["versionCode 读 -P 传入值", /findProperty\('versionCode'\)/],
  ['versionName 来自 version.properties', /versionName\s+ciVersionName\b/],
  ["versionName 读 -P 或文件", /findProperty\('versionName'\)/],
  ['buildConfig true', /buildConfig\s+true/],
  ['Java 17', /JavaVersion\.VERSION_17/],
  ['minifyEnabled false', /minifyEnabled\s+false/],
  ['androidx.core（FileProvider 来源）', /androidx\.core:core:1\.13\.1/],
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
// 版本号单一来源：android/version.properties，缺了或格式不对 CI 就打不出正确的包
const versionPropsPath = path.join(ROOT, 'version.properties')
const versionProps = fs.existsSync(versionPropsPath)
  ? fs.readFileSync(versionPropsPath, 'utf8')
  : null
if (!versionProps) gradleProblems.push('缺少 version.properties（versionName 的唯一来源）')
else if (!/^versionName=\d+\.\d+\.\d+$/m.test(versionProps)) {
  gradleProblems.push('version.properties 里没有合法的 versionName=x.y.z')
}
if (gradleProblems.length === 0) {
  ok('gradle.dsl', 'AGP 8.4 / compileSdk 34 / minSdk 28 / Java 17 / buildConfig / 版本号外部注入 均就位')
} else fail('gradle.dsl', gradleProblems.join('\n       '))

// 清单权限与安全配置
const manifest = fs.readFileSync(path.join(ROOT, 'app/src/main/AndroidManifest.xml'), 'utf8')
const manifestProblems = []
const declaredPermissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1])
const expected = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  // 分体式更新：下载完新包要能拉起系统安装器
  'android.permission.REQUEST_INSTALL_PACKAGES',
  // 后台保活前台服务（RemoteKeepAliveService）：服务本体 + Android 14 要求的 dataSync 类型权限
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  // 常驻通知（Android 13+ 运行时权限）
  'android.permission.POST_NOTIFICATIONS',
  // 只声明给页面临时申请，保活服务自己不开 WakeLock
  'android.permission.WAKE_LOCK',
  // 拉起系统「忽略电池优化」授权页（data=package:<pkg>）
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  // 保存到「下载」目录：只在 Android 9（API 28）需要，29+ 走 MediaStore.Downloads
  'android.permission.WRITE_EXTERNAL_STORAGE'
]
for (const permission of expected) {
  if (!declaredPermissions.includes(permission)) manifestProblems.push(`清单缺少权限 ${permission}`)
}
for (const permission of declaredPermissions) {
  if (!expected.includes(permission)) manifestProblems.push(`清单多了不该有的权限 ${permission}`)
}
// WRITE_EXTERNAL_STORAGE 必须带 maxSdkVersion="28"：29+ 声明它既没用又会触发
// 「访问所有照片/媒体」之类的敏感权限提示（/__ds_download/save 在 29+ 走 MediaStore）
if (
  !/android:name="android\.permission\.WRITE_EXTERNAL_STORAGE"\s*\n\s*android:maxSdkVersion="28"/.test(
    manifest
  )
) {
  manifestProblems.push('WRITE_EXTERNAL_STORAGE 没有 maxSdkVersion="28"（29+ 一律不允许声明它）')
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

// FileProvider：安装器进程读不到应用私有目录，必须靠它把 apk 包成可授权的 content:// URI
if (!/android:name="androidx\.core\.content\.FileProvider"/.test(manifest)) {
  manifestProblems.push('清单没有注册 androidx.core.content.FileProvider')
}
if (!/android:authorities="\$\{applicationId\}\.fileprovider"/.test(manifest)) {
  manifestProblems.push('FileProvider 的 authorities 不是 ${applicationId}.fileprovider')
}
if (!/android:grantUriPermissions="true"/.test(manifest)) {
  manifestProblems.push('FileProvider 缺少 grantUriPermissions="true"')
}
if (!/android:resource="@xml\/file_paths"/.test(manifest)) {
  manifestProblems.push('FileProvider 没有引用 @xml/file_paths')
}
const filePathsPath = path.join(ROOT, 'app/src/main/res/xml/file_paths.xml')
const filePaths = fs.existsSync(filePathsPath) ? fs.readFileSync(filePathsPath, 'utf8') : null
if (!filePaths) {
  manifestProblems.push('缺少 res/xml/file_paths.xml（FileProvider 的目录白名单）')
} else {
  // ApkUpdater 会先试 getExternalFilesDir(null)，拿不到退回 cacheDir，两边都要覆盖
  for (const tag of ['external-files-path', 'cache-path']) {
    if (!new RegExp(`<${tag}\\b`).test(filePaths)) {
      manifestProblems.push(`file_paths.xml 没有覆盖 ${tag}`)
    }
  }
}
if (manifestProblems.length === 0) {
  ok('manifest.security', '仅 INTERNET/ACCESS_NETWORK_STATE/REQUEST_INSTALL_PACKAGES + 保活那 5 项（FOREGROUND_SERVICE、FOREGROUND_SERVICE_DATA_SYNC、POST_NOTIFICATIONS、WAKE_LOCK、REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）+ 下载目录写入（WRITE_EXTERNAL_STORAGE，锁死 28），明文只放行回环，FileProvider 范围精确')
} else fail('manifest.security', manifestProblems.join('\n       '))

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
const update = readJava('UpdateHandler')
const webBundle = readJava('WebBundle')
const apkUpdater = readJava('ApkUpdater')
const keepAlive = readJava('KeepAliveHandler')
const keepAliveService = readJava('RemoteKeepAliveService')
const notify = readJava('RemoteNotifyHandler')
const download = readJava('RemoteDownloadHandler')
// R7 的 Web 侧落点：下载服务 + 两处挂点 + i18n 文案
const WEB_SRC = path.resolve(ROOT, '..', 'web', 'src')
const readWebFile = (relative) => {
  const file = path.join(WEB_SRC, relative)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
const webDownload = readWebFile('services/remote/download.ts')
// 两处挂点：抽屉顶部（WorkspacePane 的 IconButton，长按换来源在 AttachmentButton）与
// 工具卡全屏层（ToolCard 的 ImageViewer）
const workspacePaneSource = readWebFile('components/remote/workspace/WorkspacePane.tsx')
const attachmentButtonSource = readWebFile('components/remote/workspace/AttachmentButton.tsx')
const toolCardSource = readWebFile('components/remote/tool/ToolCard.tsx')
const zhMessages = readWebFile('i18n/zh.ts')
const enMessages = readWebFile('i18n/en.ts')
// 仓库名只允许出现在一处常量里，硬编码到多处会让换仓库变成手工对齐
const allJava = javaFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')

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
  ['路径穿越防护', /\.\./.test(asset) && /normalizePath/.test(asset)],

  // ---- 分体式更新（/__ds_update/*）：网页包单独更新，APK 再更新 ----
  ['更新路由排在静态资源之前', localServer.includes('updateHandler.handle(')
    && localServer.indexOf('updateHandler.handle(') < localServer.indexOf('assetHandler.handle(')],
  ['退出时取消在途更新', /updateHandler\.cancelAll\(\)/.test(localServer)],
  ['state：appVersion / webVersion / source', /\/__ds_update\/state/.test(update)
    && /BuildConfig\.VERSION_NAME/.test(update) && /webBundle\.currentVersion\(\)/.test(update)
    && /webBundle\.source\(\)/.test(update)],
  ['release：带 User-Agent 与 GitHub Accept', /DeepSeekChatPad\//.test(update)
    && /\.header\("User-Agent"/.test(update) && /application\/vnd\.github\+json/.test(update)],
  ['release：按文件名挑 apk 与 web-*.zip', /endsWith\("\.apk"\)/.test(update)
    && /web-"\)/.test(update) && /endsWith\("\.zip"\)/.test(update)],
  ['更新源只在一处常量里写死', /api\.github\.com\/repos\//.test(update)
    && (allJava.match(/cyychenyiyicyy/g) || []).length === 1],
  ['更新模块复用共享 OkHttpClient', (update.match(/new OkHttpClient/g) || []).length === 0
    && /call\.timeout\(\)\.timeout\(/.test(update)],
  ['SSE：text/event-stream + no-cache', /text\/event-stream/.test(update) && /no-cache/.test(update)
    && /Transfer-Encoding/.test(update)],
  ['SSE：每写一条事件就 flush', /HttpUtil\.writeChunk\(out, bytes, 0, bytes\.length\);\s*\n\s*out\.flush\(\);/.test(update)],
  ['apply-web 并发只允许一个（409）', /webInstallRunning\.compareAndSet\(false, true\)/.test(update)
    && /409/.test(update)],
  ['下载进度按字节数算百分比', /downloaded \* 100L \/ total/.test(update)],
  ['只允许 https:// 下载地址', /startsWith\("https:\/\/"\)/.test(update)],
  ['解压防路径穿越（.. / 绝对路径 / 反斜杠）', /isSafeEntryName/.test(webBundle)
    && /"\.\."\.equals\(segment\)/.test(webBundle) && /indexOf\('\\\\'\)/.test(webBundle)
    && /startsWith\("\/"\)/.test(webBundle)],
  ['解压流式写文件（ZipInputStream）', /new ZipInputStream/.test(webBundle) && /zip\.read\(buffer\)/.test(webBundle)],
  ['index.html 与 version.json 缺一不可', /new File\(stagingRoot, INDEX_FILE\)\.isFile/.test(webBundle)
    && /new File\(stagingRoot, VERSION_FILE\)\.isFile/.test(webBundle)],
  ['staging 校验通过才改名成 web', /if \(!stagingRoot\.renameTo\(webRoot\)\)/.test(webBundle)],
  ['网页包版本写 SharedPreferences', /preferences\.edit\(\)\.putString\(KEY_WEB_VERSION/.test(webBundle)],
  ['AssetHandler 优先用下载的网页包', /webBundle\.installedRoot\(\)/.test(asset) && /serveFromFiles/.test(asset)],
  ['两套来源共用同一套路径校验', /normalizePath\(rawPath\)/.test(asset) && /resolveInside/.test(asset)],
  ['APK 先写 .part 再改名', /PART_SUFFIX/.test(apkUpdater) && /renameTo/.test(update)],
  ['APK 目录 external-files 优先、cache 兜底', /getExternalFilesDir\(null\)/.test(apkUpdater)
    && /getCacheDir\(\)/.test(apkUpdater)],
  ['install-apk：FileProvider + 安装 Intent', /FileProvider\.getUriForFile/.test(apkUpdater)
    && /vnd\.android\.package-archive/.test(apkUpdater) && /ACTION_VIEW/.test(apkUpdater)
    && /FLAG_GRANT_READ_URI_PERMISSION/.test(apkUpdater)],
  ['install-apk：错误码 not_downloaded / no_installer', /"not_downloaded"/.test(apkUpdater)
    && /"no_installer"/.test(apkUpdater)],

  // ---- R3 通知中心（/__ds_notify/*）：权限判定不许假成功 + 三类通知 ----
  // 权限判定三层（A 段）：33+ 运行时权限 && 26+ 总开关 && 三条渠道都不是 NONE/缺失
  ['权限判定：三层都算（权限 + 总开关 + 渠道），不再只看总开关',
    /static boolean isNotificationVisible\(/.test(keepAlive)
    && /manager\.areNotificationsEnabled\(\)/.test(keepAlive)
    && /checkSelfPermission\(Manifest\.permission\.POST_NOTIFICATIONS\)/.test(keepAlive)
    && /getNotificationChannel\(channelId\)/.test(keepAlive)
    && /IMPORTANCE_NONE/.test(keepAlive)
    && /Build\.VERSION_CODES\.TIRAMISU/.test(keepAlive)],
  ['权限判定：不再用反射调 areNotificationsEnabled',
    !/getMethod\("areNotificationsEnabled"\)/.test(keepAlive)],
  ['canRequest：33+ 且未授予，且不是「拒绝且不再询问」（看 rationale + 落盘标志）',
    /canRequestCore\(/.test(keepAlive)
    && /shouldShowRequestPermissionRationale/.test(keepAlive)
    && /hasAskedNotificationPermission/.test(keepAlive)
    && /markNotificationPermissionAsked/.test(keepAlive)
    && /PREFS_NOTIFY = "dsp\.notify\.v1"/.test(keepAlive)],
  ['MainActivity 真的发起 requestPermissions（等窗口焦点、只问一次、回调记真值）',
    /requestPermissions\(new String\[\] \{Manifest\.permission\.POST_NOTIFICATIONS\}/.test(mainActivity)
    && /onRequestPermissionsResult/.test(mainActivity)
    && /hasWindowFocus\(\)/.test(mainActivity)
    && /markNotificationPermissionAsked/.test(mainActivity)
    && /scheduleNotificationPermissionRequest/.test(mainActivity)],
  ['通知中心：三条路由 + 带扩展名的探测别名',
    /PATH_PREFIX = "\/__ds_notify\/"/.test(notify)
    && /"\/__ds_notify\/work"/.test(notify)
    && /"\/__ds_notify\/clear"/.test(notify)
    && /"\/__ds_notify\/state\.json"/.test(notify)],
  ['通知中心：两个渠道 chatpad.work(LOW) / chatpad.alert(HIGH) + 同一通知组 chatpad',
    /CHANNEL_WORK = "chatpad\.work"/.test(notify)
    && /CHANNEL_ALERT = "chatpad\.alert"/.test(notify)
    && /IMPORTANCE_LOW/.test(notify) && /IMPORTANCE_HIGH/.test(notify)
    && /GROUP_KEY = "chatpad"/.test(notify)
    && /setGroup\(RemoteNotifyHandler\.GROUP_KEY\)/.test(keepAliveService)],
  ['进行中：InboxStyle 汇总 + setNumber + 超过 3 条只留 3 条「等 N 个」',
    /Notification\.InboxStyle/.test(notify)
    && /setNumber\(total\)/.test(notify)
    && /MAX_RUNNING_LINES = 3/.test(notify)
    && /"等 " \+ total \+ " 个任务"/.test(notify)],
  ['完成/出错：独立通知 + autoCancel；待审批：ongoing + 高优先级，且**不用** fullScreenIntent',
    /setAutoCancel\(true\)/.test(notify)
    && /setOngoing\(true\)/.test(notify)
    && /CATEGORY_REMINDER/.test(notify)
    && !/\.setFullScreenIntent\(/.test(notify)],
  ['点通知回 App：PendingIntent FLAG_IMMUTABLE + sessionId extra + 按会话区分 requestCode',
    /PendingIntent\.FLAG_IMMUTABLE/.test(notify)
    && /EXTRA_SESSION_ID/.test(notify)
    && /putExtra\(EXTRA_SESSION_ID/.test(notify)
    && /REQUEST_OPEN_BASE/.test(notify)],
  ['通知 id 与前台服务 id 不重叠，/clear 不会撤掉常驻通知',
    /ID_SUMMARY = 0x44530101/.test(notify)
    && /ID_EVENT_BASE = 0x44531000/.test(notify)
    && /ID_APPROVAL_BASE = 0x44532000/.test(notify)
    && /NOTIFICATION_ID = 0x44530001/.test(keepAliveService)],
  ['Android 9 兼容：不用 12+ 的 setForegroundServiceBehavior、渠道先建后发',
    !/\.setForegroundServiceBehavior\(/.test(notify)
    && !/\.setForegroundServiceBehavior\(/.test(keepAliveService)
    && /static void ensureChannels\(Context context\)/.test(notify)
    && /createNotificationChannel/.test(notify)
    && /NotificationChannel channel = manager\.getNotificationChannel/.test(notify)],
  ['常驻通知带上任务数（「正在保持远程连接 · N 个任务」）',
    /WORK_SUFFIX_FORMAT = " · %d 个任务"/.test(keepAliveService)
    && /setActiveWorkCount/.test(keepAliveService)
    && /setActiveWorkCount\(app, running\.size\(\)\)/.test(notify)],
  ['通知中心挂在静态资源之前，且退出时不清工作通知',
    localServer.includes('notifyHandler.handle(')
    && localServer.indexOf('notifyHandler.handle(') < localServer.indexOf('assetHandler.handle(')
    && !/notifyHandler\.cancelAll\(\)/.test(localServer)],

  // ---- R7 附件上传的来源面板（系统文件 / MT 管理器 / 其他应用） ----
  ['来源面板：平台 AlertDialog 三选一（系统 / MT / 其他）',
    /new AlertDialog\.Builder\(this\)/.test(mainActivity)
    && /SOURCE_SYSTEM = "system"/.test(mainActivity)
    && /SOURCE_MT = "mt"/.test(mainActivity)
    && /SOURCE_CHOOSER = "chooser"/.test(mainActivity)
    && /builder\.setItems\(/.test(mainActivity)
    && /R\.string\.pick_source_other/.test(mainActivity)],
  ['系统文件：ACTION_OPEN_DOCUMENT + EXTRA_ALLOW_MULTIPLE',
    /new Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/.test(mainActivity)
    && /document\.addCategory\(Intent\.CATEGORY_OPENABLE\)/.test(mainActivity)
    && /Intent\.EXTRA_ALLOW_MULTIPLE, true/.test(mainActivity)],
  ['MT 管理器：GET_CONTENT + setType("*/*") + setPackage("bin.mt.plus")，先 resolveActivity 再跳',
    /MT_PACKAGE = "bin\.mt\.plus"/.test(mainActivity)
    && /intent\.setPackage\(MT_PACKAGE\)/.test(mainActivity)
    && /intent\.resolveActivity\(getPackageManager\(\)\) == null/.test(mainActivity)
    && /MT 管理器没有注册 GET_CONTENT，不硬跳/.test(mainActivity)],
  ['其他应用：createChooser(GET_CONTENT)，且**不**加 CATEGORY_OPENABLE（否则 MT 进不了候选）',
    /launchOtherAppsPicker/.test(mainActivity)
    && /return startForFileChooser\(Intent\.createChooser\(intent, getString\(R\.string\.pick_file\)\)\)/.test(mainActivity)
    && !/new Intent\(Intent\.ACTION_GET_CONTENT\)[\s\S]{0,400}?CATEGORY_OPENABLE/.test(mainActivity)],
  ['来源记忆落 SharedPreferences（下次直接走上次那个）',
    /PREFS_PICKER = "dsp\.picker\.v1"/.test(mainActivity)
    && /rememberPickerSource\(/.test(mainActivity)
    && /rememberedPickerSource\(\)/.test(mainActivity)
    && /\.putString\(KEY_PICKER_SOURCE, source\)/.test(mainActivity)],
  ['长按换来源：DSNativePicker.reset() 原生桥',
    /addJavascriptInterface\(new PickerBridge\(\), "DSNativePicker"\)/.test(mainActivity)
    && /public void reset\(\)/.test(mainActivity)
    && /forgetPickerSource\(\)/.test(mainActivity)],
  ['取消选择回 null（空数组会让页面「+」一直挂住），且 onDestroy 收尾',
    /callback\.onReceiveValue\(null\)/.test(mainActivity)
    && /cancelFileChooser\(\);\s*\n\s*if \(server != null\)/m.test(mainActivity)],
  ['只收 content://（WebView 关着 allowFileAccess，file:// 进去等于没反应）',
    /isReadablePickedUri/.test(mainActivity)
    && /"content"\.equalsIgnoreCase\(scheme\)/.test(mainActivity)
    && /pick_source_unreadable/.test(mainActivity)],

  // ---- R7 保存到系统「下载」目录（/__ds_download/*） ----
  ['下载路由：save / state(.json 探测) / permission 三条都在',
    /PATH_SAVE = "\/__ds_download\/save"/.test(download)
    && /PATH_STATE = "\/__ds_download\/state"/.test(download)
    && /PATH_STATE_PROBE = "\/__ds_download\/state\.json"/.test(download)
    && /PATH_PERMISSION = "\/__ds_download\/permission"/.test(download)],
  ['下载路由挂在静态资源之前（否则会被当成页面路径）',
    localServer.includes('downloadHandler.handle(')
    && localServer.indexOf('downloadHandler.handle(') < localServer.indexOf('assetHandler.handle(')],
  ['Android 10+：MediaStore.Downloads + RELATIVE_PATH + IS_PENDING',
    /MediaStore\.Downloads\.getContentUri\(MediaStore\.VOLUME_EXTERNAL_PRIMARY\)/.test(download)
    && /MediaStore\.MediaColumns\.RELATIVE_PATH/.test(download)
    && /MediaStore\.MediaColumns\.IS_PENDING/.test(download)
    && /Environment\.DIRECTORY_DOWNLOADS/.test(download)],
  ['Android 9：直接写公共下载目录 + MediaScanner 扫描',
    /getExternalStoragePublicDirectory/.test(download)
    && /MediaScannerConnection\.scanFile/.test(download)
    && /mkdirs\(\)/.test(download)],
  ['单文件 32 MiB 上限（超限 413 too_large），请求体另设上限',
    /MAX_FILE_BYTES = 32 \* 1024 \* 1024/.test(download)
    && /MAX_BODY_BYTES = 48 \* 1024 \* 1024/.test(download)
    && /new HttpError\(413, "too_large"\)/.test(download)],
  ['文件名净化：去路径分隔符 / 去 .. / 去控制字符 / 限长保留扩展名',
    /sanitizeName\(/.test(download)
    && /name\.lastIndexOf\('\\\\'\)/.test(download)
    && /replace\("\.\.", "\."\)/.test(download)
    && /MAX_NAME_CHARS/.test(download)],
  ['可读错误码：bad_name / bad_body / too_large / permission_denied / io_error',
    /"bad_name"/.test(download) && /"bad_body"/.test(download)
    && /"permission_denied"/.test(download) && /"io_error"/.test(download)],
  ['state 回 canWrite / dir / sdkInt，28 上 canWrite 看运行时权限',
    /json\.put\("canWrite", canWrite\(\)\)/.test(download)
    && /"sdkInt", Build\.VERSION\.SDK_INT/.test(download)
    && /checkSelfPermission\(Manifest\.permission\.WRITE_EXTERNAL_STORAGE\)/.test(download)],
  ['Android 9 运行时权限申请（靠 ActivityLifecycleCallbacks 找当前 Activity）',
    /REQ_WRITE_STORAGE = 4714/.test(download)
    && /requestPermissions\(\s*\n?\s*new String\[\] \{Manifest\.permission\.WRITE_EXTERNAL_STORAGE\}/.test(download)
    && /ActivityLifecycleCallbacks/.test(download)
    && /resumedActivity\(\)/.test(download)],
  ['32 MiB 的 base64 不走 String 解析（按字节定位字段，避免两份 UTF-16 副本）',
    /findStringField\(body, "dataBase64"\)/.test(download)
    && /Base64\.decode\(body, range\[0\], length, Base64\.DEFAULT\)/.test(download)],
  ['Web：services/remote/download.ts 调 save + state，成功/失败都给 toast',
    /\/__ds_download\/save/.test(webDownload) && /\/__ds_download\/state\.json/.test(webDownload)
    && /saveToDownloads/.test(webDownload)
    && /showToast/.test(webDownload)
    && /\/__ds_download\/permission/.test(webDownload)],
  ['Web：预览与工具卡都挂上了下载按钮（只加挂点，不动布局）',
    /downloadAction/.test(workspacePaneSource)
    && /downloadWorkspacePath|downloadFromUrl/.test(workspacePaneSource)
    && /downloadAction/.test(toolCardSource)
    && /downloadFromUrl/.test(toolCardSource)
    && /DSNativePicker/.test(attachmentButtonSource)
    && /downloadSaved/.test(zhMessages) && /downloadSaved/.test(enMessages)]
]
const featureProblems = featureChecks.filter(([, pass]) => !pass).map(([label]) => label)
if (featureProblems.length === 0) ok('features', `${featureChecks.length} 项需求断言全部命中`)
else fail('features', `未命中: ${featureProblems.join(', ')}`)

// ---------------------------------------------------------------- 6. 原生 SQLite 存储（/__ds_db/*）
//
// 这一块是「会话存储从 IndexedDB 搬到原生 SQLite」的验收要点：
// 表结构、事务与幂等写、10 条路由、挂载顺序、二进制回传、异常兜底，
// 以及 Web 侧的探测/迁移/校验是否真的写了。契约见
// work/2026-11-17-deepseek-tablet/native-sqlite-design.md。

const WEB_CHAT_DIR = path.resolve(ROOT, '..', 'web', 'src', 'services', 'chat')
function readWebChat(name) {
  const file = path.join(WEB_CHAT_DIR, name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
const chatDatabase = readJava('ChatDatabase')
const dbHandler = readJava('DbHandler')
const chatDbTs = readWebChat('db.ts')
const dbNativeTs = readWebChat('dbNative.ts')

const dbChecks = []

// 1. 四张表 + 消息索引 + 外键级联
const sqliteTables = ['sessions', 'messages', 'files', 'meta']
const missingTables = sqliteTables.filter(
  (table) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`).test(chatDatabase)
)
dbChecks.push([
  '4 张表 sessions/messages/files/meta（含 messages 主键、索引、外键级联）',
  missingTables.length === 0 &&
    /PRIMARY KEY \(session_id, seq\)/.test(chatDatabase) &&
    /CREATE INDEX IF NOT EXISTS idx_messages_session ON messages\(session_id, seq\)/.test(
      chatDatabase
    ) &&
    /FOREIGN KEY \(session_id\) REFERENCES sessions\(id\) ON DELETE CASCADE/.test(chatDatabase),
  `缺表: ${missingTables.join(', ')}；messages 结构不完整`
])

// 2. SQLiteOpenHelper / 库名 / 版本
dbChecks.push([
  'SQLiteOpenHelper + chat.db + 版本 1',
  /extends SQLiteOpenHelper/.test(chatDatabase) &&
    /static final String DB_NAME = "chat\.db"/.test(chatDatabase) &&
    /static final int VERSION = 1/.test(chatDatabase),
  '库名或版本不对'
])

// 3. 写操作在事务里 + 幂等（INSERT OR REPLACE + 先删旧消息行）
dbChecks.push([
  '写入全部在事务里，且按 id upsert 幂等',
  (chatDatabase.match(/beginTransaction\(\)/g) || []).length >= 4 &&
    (chatDatabase.match(/setTransactionSuccessful\(\)/g) || []).length >= 4 &&
    (chatDatabase.match(/CONFLICT_REPLACE/g) || []).length >= 2 &&
    /db\.delete\(TABLE_MESSAGES/.test(chatDatabase),
  '事务或幂等写法缺失'
])

// 4. 契约要求的公开操作都在
const chatDbApi = [
  'JSONArray summaries(',
  'JSONObject loadSession(',
  'void saveSession(',
  'boolean rename(',
  'boolean delete(',
  'void putFile(',
  'byte[] getFile(',
  'int importSessions(',
  'JSONObject counts(',
  'boolean isMigrated(',
  'void markMigrated('
]
const missingApi = chatDbApi.filter((signature) => !chatDatabase.includes(signature))
dbChecks.push([
  'ChatDatabase 提供 summaries/loadSession/saveSession/rename/delete/putFile/getFile/importSession/counts/isMigrated/markMigrated',
  missingApi.length === 0,
  `缺: ${missingApi.join(', ')}`
])

// 5. 路由前缀 + 8 条路径
const dbPaths = [
  '/__ds_db/state',
  '/__ds_db/summaries',
  '/__ds_db/session',
  '/__ds_db/rename',
  '/__ds_db/delete',
  '/__ds_db/file',
  '/__ds_db/import',
  '/__ds_db/reset'
]
const missingPaths = dbPaths.filter((route) => !dbHandler.includes(`"${route}"`))
dbChecks.push([
  '前缀 /__ds_db/ 与 8 条路径常量都在',
  /static final String PATH_PREFIX = "\/__ds_db\/"/.test(dbHandler) && missingPaths.length === 0,
  `缺: ${missingPaths.join(', ')}`
])

// 6. 10 条 method+path 路由各自接到数据操作上
const dbRouteCalls = [
  'stateJson(',
  'summariesJson(',
  'database.loadSession(',
  'database.saveSession(',
  'database.rename(',
  'database.delete(',
  'database.putFile(',
  'database.getFile(',
  'database.importSessions(',
  'database.reset('
]
const missingRoutes = dbRouteCalls.filter((call) => !dbHandler.includes(call))
dbChecks.push([
  '10 条路由（含 session/file 的 GET+POST）都接到数据操作上',
  missingRoutes.length === 0 && /requireReadOnly\(method\)/.test(dbHandler),
  `缺: ${missingRoutes.join(', ')}`
])

// 7. 挂载顺序：/__ds_db/* 必须在静态资源之前，且把请求体流传进去
dbChecks.push([
  'DbHandler 挂在静态资源之前并传请求体',
  localServer.includes('dbHandler.handle(') &&
    /dbHandler\.handle\(method, target, path, headers, in, out, keepAlive\)/.test(localServer) &&
    localServer.indexOf('dbHandler.handle(') < localServer.indexOf('assetHandler.handle('),
  '挂载顺序或参数不对'
])
dbChecks.push([
  'handle 签名带 InputStream 请求体',
  /boolean handle\(String method, String target, String path, HttpUtil\.Headers headers,\s+InputStream in, OutputStream out, boolean keepAlive\)/.test(
    dbHandler
  ),
  'handle 参数列表与契约不一致'
])

// 8. 附件走二进制：Content-Type octet-stream + Content-Length
dbChecks.push([
  'GET /file 回二进制（octet-stream + Content-Length）',
  /application\/octet-stream/.test(dbHandler) &&
    /Content-Length", String\.valueOf\(data\.length\)/.test(dbHandler),
  '二进制响应头缺失'
])

// 9. 请求体上限 + 异常兜底成 JSON（不让异常把连接打死）
dbChecks.push([
  '请求体限 32MB（413）、异常转 {"ok":false} + 500',
  /MAX_BODY_BYTES = 32 \* 1024 \* 1024/.test(dbHandler) &&
    /new HttpError\(413/.test(dbHandler) &&
    /HttpUtil\.sendJson\(out, 500/.test(dbHandler) &&
    dbHandler.includes('\\"ok\\":false,\\"error\\"'),
  '上限或异常兜底缺失'
])

// 10. Web 侧迁移：探测 → 分批 → 校验条数 → 才写标记
dbChecks.push([
  'dbNative 有 probe/migrate（含超时），分批导入并校验会话数与 3 个抽查会话的消息数',
  /export const probe = async \(\)/.test(dbNativeTs) &&
    /export const migrate = async \(\s*source: MigrationSource/.test(dbNativeTs) &&
    /DEFAULT_TIMEOUT_MS/.test(dbNativeTs) &&
    /timeoutMs: 3000/.test(dbNativeTs) &&
    /const SESSION_BATCH = 20/.test(dbNativeTs) &&
    /const SAMPLE_SESSIONS = 3/.test(dbNativeTs) &&
    /state\.sessions < total/.test(dbNativeTs) &&
    /session\.messages\.length !== count/.test(dbNativeTs) &&
    /MIGRATED_KEY = 'chat-demo:native-migrated'/.test(dbNativeTs),
  '迁移实现不完整'
])

// 11. db.ts 对外 API 一个不少，暂存仍走 IndexedDB，commitStaging 额外写原生
const dbExports = [
  'loadSessionSummaries',
  'loadSession',
  'saveSession',
  'renameSession',
  'deleteSession',
  'saveFiles',
  'loadFile',
  'clearStaging',
  'addStagingSession',
  'saveStagingFiles',
  'updateStagingFileTypes',
  'commitStaging',
  'reportStorageError'
]
const missingExports = dbExports.filter(
  (name) => !new RegExp(`export const ${name}\\b`).test(chatDbTs)
)
dbChecks.push([
  'db.ts 仍导出全部 13 个函数（+ currentBackend），暂存走 IDB，commitStaging 同步原生',
  missingExports.length === 0 &&
    /export const currentBackend = \(\): StorageBackend \| 'pending' => backend/.test(chatDbTs) &&
    /export const clearStaging = idbClearStaging/.test(chatDbTs) &&
    /export const addStagingSession = idbAddStagingSession/.test(chatDbTs) &&
    /export const saveStagingFiles = idbSaveStagingFiles/.test(chatDbTs) &&
    /export const updateStagingFileTypes = idbUpdateStagingFileTypes/.test(chatDbTs) &&
    /await dbNative\.probe\(\)/.test(chatDbTs) &&
    // 迁移必须在后台跑：启动不能等它（否则原生一不返回就永久卡在加载界面）
    /migrateInBackground/.test(chatDbTs) &&
    /dbNative\s*\.migrate\(/.test(chatDbTs),
  `缺: ${missingExports.join(', ')}`
])

const dbProblems = dbChecks
  .filter(([, pass]) => !pass)
  .map(([label, , detail]) => `${label}${detail ? `（${detail}）` : ''}`)
if (dbProblems.length === 0) ok('sqlite.native', `${dbChecks.length} 项原生 SQLite 断言全部命中`)
else fail('sqlite.native', `未命中: ${dbProblems.join('; ')}`)

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
