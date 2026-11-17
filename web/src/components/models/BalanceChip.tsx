import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { fetchBalance, type Balance } from '../../services/api/deepseek.js'
import styles from './BalanceChip.module.css'

/** 余额缓存 60 秒，避免每次回到新对话页都打一次接口 */
let cached: { at: number; value: Balance } | null = null
const CACHE_TTL = 60_000

const symbolOf = (currency: string) => (currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `)

/**
 * 新对话页的 DeepSeek 余额胶囊。
 * 余额走 DeepSeek 账号级接口，与当前选择的对话模型无关；没有填 Key 时不显示。
 */
export const BalanceChip = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [balance, setBalance] = useState<Balance | null>(cached?.value ?? null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')

  const load = useCallback(
    async (force = false) => {
      if (!apiKey) return
      if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
        setBalance(cached.value)
        return
      }
      setState('loading')
      try {
        const value = await fetchBalance(apiKey)
        cached = { at: Date.now(), value }
        setBalance(value)
        setState('idle')
      } catch {
        setState('error')
      }
    },
    [apiKey]
  )

  useEffect(() => {
    void load()
  }, [load])

  if (!apiKey) return null

  const info = balance?.balance_infos?.[0]
  const text =
    state === 'error'
      ? t('balanceFailed')
      : state === 'loading' && !info
        ? t('balanceLoading')
        : info
          ? t('balanceLabel', { amount: `${symbolOf(info.currency)}${info.total_balance}` })
          : t('balanceLoading')

  const insufficient = balance ? !balance.is_available : false

  return (
    <button
      type="button"
      className={clsx(styles.chip, insufficient && styles.danger)}
      title={t('balanceRefresh')}
      onClick={() => void load(true)}
    >
      <span className={styles.dot} aria-hidden />
      {insufficient ? t('balanceInsufficient') : text}
    </button>
  )
}
