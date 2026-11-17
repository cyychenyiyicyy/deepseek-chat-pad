#!/usr/bin/env node
/**
 * 生成离线模型目录。
 *
 * 数据源：
 *   - models.dev/api.json        全量 6.4MB / 324 厂商 / 9900+ 模型（元信息最全）
 *   - api.openmodels.run         54 厂商的权威 base URL 与兼容协议
 *
 * 为什么要裁剪：WebView 启动时解析 6.4MB JSON 会明显拖慢首屏，而我们实际只需要
 * 「常用厂商的模型元信息」+「全部厂商的端点目录」。实测裁剪后 gzip 只有 ~33KB。
 *
 * 产物（web/public/catalog/）：
 *   catalog.json  常用厂商 + 已裁剪的模型元信息（离线主力）
 *   providers.json 全部厂商的 id/name/api/compat 目录（端点匹配 + 自动填 Base URL）
 *   catalog.js    与 catalog.json 同内容，挂到 window.__MODEL_CATALOG__，省一次 fetch
 *
 * 用法：node tools/build-catalog.mjs [--offline]
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cacheDir = path.join(root, 'tmp', 'catalog-cache')
const outDir = path.join(root, 'web', 'public', 'catalog')
const offline = process.argv.includes('--offline')

const MODELS_URL = 'https://models.dev/api.json'
const PROVIDERS_URL = 'https://api.openmodels.run/api/providers'

/** 内置的常用厂商：覆盖国内用户绝大多数场景，其余走在线补全 */
const CORE_PROVIDERS = [
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'zhipuai',
  'z-ai',
  'alibaba',
  'alibaba-cn',
  'qwen',
  'opencode',
  'opencode-go',
  'openrouter',
  'xai',
  'mistral',
  'groq',
  'fireworks',
  'deepinfra',
  'together',
  'siliconflow',
  'volcengine',
  'stepfun',
  'stepfun-ai',
  'xiaomi',
  'nvidia',
  'perplexity',
  'cerebras',
  'sambanova',
  'novita',
  'baichuan',
  'sensenova',
  '01-ai',
  'vercel',
  'kilo',
  'requesty',
]

const log = (...a) => console.log(...a)

async function load(url, file) {
  const target = path.join(cacheDir, file)
  if (offline) return JSON.parse(await readFile(target, 'utf8'))
  log(`  ↓ ${url}`)
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const text = await res.text()
  await mkdir(cacheDir, { recursive: true })
  await writeFile(target, text)
  return JSON.parse(text)
}

async function loadProviders() {
  const all = []
  let page = 1
  let pages = 1
  do {
    const body = await load(`${PROVIDERS_URL}?page=${page}&limit=100`, `providers-p${page}.json`)
    all.push(...(body.items ?? []))
    pages = body.pagination?.total_pages ?? 1
    page += 1
  } while (page <= pages)
  return all
}

/** 只保留 UI 真正用到的字段；键名压短，体积能再降三成 */
const pruneModel = (m) => ({
  id: m.id,
  name: m.name,
  ctx: m.limit?.context ?? null,
  out: m.limit?.output ?? null,
  in: m.modalities?.input ?? ['text'],
  ...(m.attachment ? { attach: 1 } : {}),
  ...(m.reasoning ? { reason: 1 } : {}),
  ...(m.tool_call ? { tool: 1 } : {}),
  // 思考开关的类型：toggle=开关，effort=档位
  ...(m.reasoning_options?.length ? { ropt: m.reasoning_options.map((o) => o.type) } : {}),
  ...(m.temperature === false ? { noTemp: 1 } : {}),
  ...(m.cost ? { cost: [m.cost.input ?? 0, m.cost.output ?? 0] } : {}),
  ...(m.release_date ? { rel: m.release_date } : {}),
  ...(m.status ? { status: m.status } : {}),
  ...(m.open_weights ? { open: 1 } : {}),
})

const compatOf = (provider) =>
  (provider.npm ?? '').includes('anthropic') || /\/anthropic(\/|$)/.test(provider.api ?? '')
    ? 'anthropic'
    : 'openai'

async function main() {
  log('▶ 读取数据源')
  const [dev, openmodels] = await Promise.all([load(MODELS_URL, 'models-dev.json'), loadProviders()])
  log(`  models.dev ${Object.keys(dev).length} 厂商 / openmodels ${openmodels.length} 厂商`)

  const epById = new Map(openmodels.map((p) => [p.id, p]))
  const epByHost = new Map()
  for (const p of openmodels) {
    if (!p.api_base_url) continue
    try {
      epByHost.set(new URL(p.api_base_url).host, p)
    } catch {
      /* 忽略非法 URL */
    }
  }

  /** 端点目录：models.dev 的厂商 ∪ openmodels 的厂商 */
  const providers = []
  const seen = new Set()
  for (const [id, p] of Object.entries(dev)) {
    const ep = epById.get(id)
    let hostMatch = null
    if (!ep && p.api) {
      try {
        hostMatch = epByHost.get(new URL(p.api).host) ?? null
      } catch {
        /* ignore */
      }
    }
    const api = ep?.api_base_url ?? p.api ?? hostMatch?.api_base_url ?? ''
    providers.push({ id, name: p.name ?? id, api, compat: compatOf(p), models: Object.keys(p.models ?? {}).length })
    seen.add(id)
  }
  for (const ep of openmodels) {
    if (seen.has(ep.id) || !ep.api_base_url) continue
    providers.push({ id: ep.id, name: ep.name ?? ep.id, api: ep.api_base_url, compat: ep.compatibility === 'anthropic' ? 'anthropic' : 'openai', models: 0 })
    seen.add(ep.id)
  }
  providers.sort((a, b) => b.models - a.models || a.id.localeCompare(b.id))

  /** 常用厂商的完整模型元信息 */
  const core = []
  for (const id of CORE_PROVIDERS) {
    const p = dev[id]
    if (!p) {
      log(`  ! 跳过不存在的厂商 ${id}`)
      continue
    }
    const meta = providers.find((x) => x.id === id)
    core.push({
      id,
      name: p.name ?? id,
      api: meta?.api ?? p.api ?? '',
      compat: meta?.compat ?? compatOf(p),
      ...(p.env?.[0] ? { env: p.env[0] } : {}),
      models: Object.values(p.models ?? {}).map(pruneModel),
    })
  }

  const catalog = { version: 2, generatedAt: new Date().toISOString(), core }
  const directory = {
    version: 2,
    generatedAt: catalog.generatedAt,
    sources: { models: MODELS_URL, endpoints: PROVIDERS_URL },
    providers: providers.filter((p) => p.api),
  }

  await mkdir(outDir, { recursive: true })
  const coreJson = JSON.stringify(catalog)
  const dirJson = JSON.stringify(directory)
  // 只产出 JSON：页面按需 fetch，避免启动时解析一个近 400KB 的脚本
  await writeFile(path.join(outDir, 'catalog.json'), coreJson)
  await writeFile(path.join(outDir, 'providers.json'), dirJson)

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`
  const modelCount = core.reduce((n, p) => n + p.models.length, 0)
  log('\n▶ 产物')
  log(`  catalog.json   ${kb(Buffer.byteLength(coreJson))}  gzip ${kb(gzipSync(coreJson).length)}  (${core.length} 厂商 / ${modelCount} 模型)`)
  log(`  providers.json ${kb(Buffer.byteLength(dirJson))}  gzip ${kb(gzipSync(dirJson).length)}  (${directory.providers.length} 厂商)`)
  log(`  合计 gzip 约 ${kb(gzipSync(coreJson).length + gzipSync(dirJson).length)}`)
}

main().catch((e) => {
  console.error('✗ 生成失败：', e.message)
  process.exit(1)
})
