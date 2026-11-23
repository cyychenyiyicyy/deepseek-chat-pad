import { DSH_WEB_CAPABILITY, dshWebGrantSchema } from '../../vendor/dsh-remote/protocol/dsh-web.js'
import { RemoteApiError } from './serverApi.js'
import { lastRemoteTarget, newRequestId } from './sessionsApi.js'
import { useRemoteStore } from './store.js'

interface NativeDshWeb {
  open(id: string, root: string, grant: string, expiresAt: number): void
  close(id: string): void
}

const bridge = () => (window as Window & { DSNativeDshWeb?: NativeDshWeb }).DSNativeDshWeb
export const supportsDshWeb = () => typeof bridge()?.open === 'function'

const trustedTunnel = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hostc\.4ba\.io\/$/u
export function parseDshWebGrant(value: unknown, now = Date.now()) {
  const result = dshWebGrantSchema.safeParse(value)
  if (!result.success || !trustedTunnel.test(result.data.url) || result.data.expiresAt <= now) {
    throw new RemoteApiError('INVALID_RESPONSE', 'The host returned an invalid or expired DSH Web grant')
  }
  return result.data
}

let operation: Promise<void> | undefined

export async function openDshWeb(): Promise<void> {
  if (operation !== undefined) return operation
  const native = bridge()
  const target = lastRemoteTarget()
  const state = useRemoteStore.getState()
  if (!native || !target || state.phase !== 'ready' || !state.capabilities.includes(DSH_WEB_CAPABILITY)) {
    throw new RemoteApiError('FEATURE_NOT_SUPPORTED', 'DSH Web is unavailable for this host')
  }
  const current = () => lastRemoteTarget() === target && useRemoteStore.getState().phase === 'ready'
  const task = (async () => {
    const id = newRequestId()
    let displayed = false
    let unsubscribe = () => {}
    let retire = () => {}
    let onResult: EventListener | undefined
    try {
      const grant = parseDshWebGrant(await target.rpc('dsh.web.open', {}, { timeoutMs: 25_000 }))
      if (!current()) return
      await new Promise<void>((resolve, reject) => {
        retire = () => {
          if (displayed) native.close(id)
          resolve()
        }
        onResult = (event) => {
          const detail = (event as CustomEvent<{ id?: string; status?: string }>).detail
          if (detail?.id !== id) return
          if (detail.status === 'closed') resolve()
          else reject(new RemoteApiError(detail.status === 'busy' ? 'HTTP_429' : 'DSH_WEB_LOAD_FAILED',
            detail.status === 'busy' ? 'DSH Web is busy' : 'The host’s DSH Web page could not load'))
        }
        window.addEventListener('dsh-web-result', onResult)
        window.addEventListener('pagehide', retire, { once: true })
        unsubscribe = useRemoteStore.subscribe(() => {
          if (!current()) retire()
        })
        displayed = true
        native.open(id, grant.url, grant.browserGrant, grant.expiresAt)
      })
    } finally {
      if (onResult) window.removeEventListener('dsh-web-result', onResult)
      window.removeEventListener('pagehide', retire)
      unsubscribe()
      await target.rpc('dsh.web.close', {}, { timeoutMs: 10_000 }).catch(() => undefined)
    }
  })()
  operation = task
  try {
    await task
  } finally {
    if (operation === task) operation = undefined
  }
}
