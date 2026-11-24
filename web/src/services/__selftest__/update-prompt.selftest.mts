/**
 * 更新弹窗判定自测（回归「每次启动都弹『已是最新版本』」）。
 *
 * 背景：网页包可以单独更新，APK 不跟着升。只比版本号的话，网页包更新完之后
 * 「最新版 > APK 版本」永远成立，于是每次启动都被判成有更新；但那一版根本没有
 * 可下载的资产（纯网页更新），弹窗就退化成只有「稍后」的「已是最新版本」。
 * 现在启动弹窗只认 resolveUpdateAction().actionable。
 */
import assert from 'node:assert/strict'
import {
  compareVersion,
  resolveUpdateAction,
  resolveUpdatePromptKind,
  type ReleaseInfo,
  type UpdateState,
} from '../update.js'

let passed = 0
const check = (name: string, run: () => void) => {
  try {
    run()
    passed += 1
  } catch (error) {
    console.log('[FAIL] ' + name + '：' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
}

const release = (patch: Partial<ReleaseInfo> & { version: string }): ReleaseInfo => ({
  apkUrl: null,
  apkSize: 0,
  webUrl: null,
  webSize: 0,
  notes: '',
  ...patch,
})

const state = (appVersion: string, webVersion: string | null): UpdateState => ({
  appVersion,
  webVersion,
  source: webVersion ? 'files' : 'assets',
})

/** v1.16.1 的线上形态：纯网页更新，只挂 web-v1.16.1.zip */
const webOnly = release({
  version: '1.16.1',
  webUrl: 'https://example.test/web-v1.16.1.zip',
  webSize: 5_063_721,
})

/** 本体更新：只挂 APK */
const native = release({
  version: '1.16.2',
  apkUrl: 'https://example.test/app-debug.apk',
  apkSize: 14_300_000,
})

// ---- 版本比较（原有规则，别被顺手改坏）
check('版本比较：v 前缀不影响结果', () => {
  assert.equal(compareVersion('v1.16.1', '1.16.1'), 0)
  assert.equal(compareVersion('v1.16.1', '1.16.0'), 1)
  assert.equal(compareVersion('1.16.1', 'v1.16.2'), -1)
})
check('版本比较：按段比较而不是按字符串', () => {
  assert.equal(compareVersion('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersion('1.9.9', '1.10.0'), -1)
  assert.equal(compareVersion('1.16.1', ''), 1)
})

// ---- 用户实际遇到的情况：网页包已是 1.16.1，APK 还是 1.16.0
check('网页包已更新、APK 落后 ⇒ 没有可执行动作（不再弹窗）', () => {
  const action = resolveUpdateAction(webOnly, state('1.16.0', '1.16.1'))
  assert.deepEqual(action, { hasWeb: false, hasApk: false, actionable: false })
})

// ---- 真有网页更新时仍然要弹
check('网页包落后 ⇒ 有网页可更', () => {
  const action = resolveUpdateAction(webOnly, state('1.16.0', '1.16.0'))
  assert.equal(action.hasWeb, true)
  assert.equal(action.hasApk, false)
  assert.equal(action.actionable, true)
})
check('没装过下载包时按内置网页版本算 ⇒ 有网页可更', () => {
  const action = resolveUpdateAction(webOnly, state('1.16.0', null))
  assert.equal(action.hasWeb, true)
  assert.equal(action.actionable, true)
})

// ---- 真有本体更新时仍然要弹
check('本体更新 ⇒ 有 APK 可下', () => {
  const action = resolveUpdateAction(native, state('1.16.0', '1.16.1'))
  assert.equal(action.hasWeb, false)
  assert.equal(action.hasApk, true)
  assert.equal(action.actionable, true)
})
check('CI 标明这次不用换 APK ⇒ 不催更', () => {
  const action = resolveUpdateAction({ ...native, apkRequired: false }, state('1.16.0', '1.16.1'))
  assert.equal(action.hasApk, false)
  assert.equal(action.actionable, false)
})

// ---- 全部最新 / 查不到 release 都不能弹
check('全部最新 ⇒ 没有可执行动作', () => {
  assert.deepEqual(resolveUpdateAction({ ...native, version: '1.16.2' }, state('1.16.2', '1.16.2')), {
    hasWeb: false,
    hasApk: false,
    actionable: false,
  })
})
check('查不到 release ⇒ 没有可执行动作', () => {
  assert.deepEqual(resolveUpdateAction(null, state('1.16.0', '1.16.1')), {
    hasWeb: false,
    hasApk: false,
    actionable: false,
  })
})
check('读不到原生状态时按保守口径判定（有资产就能更）', () => {
  assert.equal(resolveUpdateAction(native, null).actionable, true)
})

// ---- 弹窗标题口径：「已是最新版本」只在确实没事时出现
check('弹窗口径：能装 ⇒ 发现新版本', () => {
  assert.equal(resolveUpdatePromptKind(webOnly, state('1.16.0', '1.16.0'), null), 'update')
})
check('弹窗口径：没事但要提示重载 ⇒ 更新提示', () => {
  assert.equal(
    resolveUpdatePromptKind(webOnly, state('1.16.0', '1.16.1'), '网页包已更新到 1.16.1，重新加载后生效'),
    'notice',
  )
})
check('弹窗口径：确实没事 ⇒ 已是最新版本', () => {
  assert.equal(resolveUpdatePromptKind(webOnly, state('1.16.0', '1.16.1'), null), 'up-to-date')
})

console.log(`${passed} PASS / 0 FAIL / ${passed} TOTAL`)
