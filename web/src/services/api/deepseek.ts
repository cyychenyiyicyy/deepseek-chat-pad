/**
 * DeepSeek 账号级接口（与对话模型无关，始终用 DeepSeek 的 Key）：
 *   GET /user/balance   余额，用于新对话页展示
 *   GET /models         校验 Key，不产生费用
 */
import { ApiError } from './client.js'
import { apiFetch } from './transport.js'

export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'

export type BalanceInfo = {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}
export type Balance = { is_available: boolean; balance_infos: BalanceInfo[] }

const readError = async (res: Response): Promise<ApiError> => {
  const text = await res.text().catch(() => '')
  let message = text || res.statusText
  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    if (body.error?.message) message = body.error.message
  } catch {
    /* 非 JSON 错误体保留原文 */
  }
  return new ApiError('http', message, res.status)
}

/** 账户余额 */
export const fetchBalance = async (apiKey: string, signal?: AbortSignal): Promise<Balance> => {
  const res = await apiFetch(`${DEEPSEEK_ORIGIN}/user/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as Balance
}

/** 校验 Key（GET /models 不产生费用） */
export const verifyDeepseekKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const res = await apiFetch(`${DEEPSEEK_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!res.ok) throw await readError(res)
}
