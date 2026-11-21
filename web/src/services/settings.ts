import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 整体界面缩放，1 为原始大小 */
  uiScale: number
  /** 思考强度档位：off / on / low / high / max…，与 thinking 双向同步 */
  thinkingEffort: string
  /** 启动时是否自动检查更新 */
  autoCheckUpdate: boolean
  /** 联网搜索后端：Exa 免费 MCP（默认）/ DeepSeek 官方接口 / 自己的 Tavily */
  searchBackend: 'exa' | 'deepseek' | 'tavily'
  /** Tavily API Key */
  tavilyKey: string
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  uiScale: 'chat-demo:ui-scale',
  thinkingEffort: 'chat-demo:thinking-effort',
  autoCheckUpdate: 'chat-demo:auto-check-update',
  searchBackend: 'chat-demo:search-backend',
  tavilyKey: 'chat-demo:tavily-key',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 缩放在 0.8–1.3 之间，超出范围按边界处理 */
export const SCALE_MIN = 0.8
export const SCALE_MAX = 1.3

const clampScale = (value: number) =>
  Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) : 1

const initialUiScale = (): number => clampScale(Number(read(KEYS.uiScale) ?? '1'))

/** 默认档位：沿用旧的开关状态，新用户默认关闭思考 */
const initialThinkingEffort = (): string => {
  const saved = read(KEYS.thinkingEffort)
  if (saved) {
    return saved
  }
  return read(KEYS.thinking) === 'true' ? 'high' : 'off'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  uiScale: initialUiScale(),
  thinkingEffort: initialThinkingEffort(),
  autoCheckUpdate: read(KEYS.autoCheckUpdate) !== 'false',
  searchBackend: readBackend(),
  tavilyKey: read(KEYS.tavilyKey) ?? '',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

/** 选择档位：'off' 等同关闭思考，其余等同开启 */
export const setThinkingEffort = (effort: string) => {
  write(KEYS.thinkingEffort, effort)
  write(KEYS.thinking, String(effort !== 'off'))
  useSettings.setState({ thinkingEffort: effort, thinking: effort !== 'off' })
}

export const setThinking = (thinking: boolean) => {
  const current = useSettings.getState().thinkingEffort
  const next = thinking ? (current === 'off' ? 'high' : current) : 'off'
  write(KEYS.thinking, String(thinking))
  write(KEYS.thinkingEffort, next)
  useSettings.setState({ thinking, thinkingEffort: next })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setUiScale = (uiScale: number) => {
  const next = clampScale(uiScale)
  write(KEYS.uiScale, String(next))
  useSettings.setState({ uiScale: next })
}

const readBackend = (): 'exa' | 'deepseek' | 'tavily' => {
  const stored = read(KEYS.searchBackend)
  if (stored === 'deepseek' || stored === 'tavily' || stored === 'exa') {
    return stored
  }
  // 没设置过：默认用免费的 Exa MCP，不需要任何 Key
  return 'exa'
}

export const setSearchBackend = (searchBackend: 'exa' | 'deepseek' | 'tavily') => {
  write(KEYS.searchBackend, searchBackend)
  useSettings.setState({ searchBackend })
}

export const setTavilyKey = (tavilyKey: string) => {
  write(KEYS.tavilyKey, tavilyKey)
  useSettings.setState({ tavilyKey })
}

export const setAutoCheckUpdate = (autoCheckUpdate: boolean) => {
  write(KEYS.autoCheckUpdate, String(autoCheckUpdate))
  useSettings.setState({ autoCheckUpdate })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
