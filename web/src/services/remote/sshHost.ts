import { DshHttpLink, httpFailure, type DshHttpBackend } from './core/httpLink.js'
import { RemoteApiError } from './serverApi.js'

const PREFIX = '/__ds_ssh/'
const MUX_PATH = '/__ds_remote/ssh-mux'
const PROFILE_KEY = 'dsp.remote.ssh.profiles.v2'
const LEGACY_PROFILE_KEY = 'dsp.remote.ssh.profile.v1'

export interface SshHostInput {
  host: string
  port: number
  user: string
  fingerprint: string
  password?: string
  privateKey?: string
  passphrase?: string
  mode: 'managed' | 'attach'
  remotePort?: number
  launchToken?: string
  rememberCredentials?: boolean
  useSavedCredentials?: boolean
}

export type SshProfile = Pick<SshHostInput, 'host' | 'port' | 'user' | 'fingerprint' | 'mode' | 'remotePort'> & {
  keyAuth: boolean
  savedCredentials?: boolean
}

export const sshProfileKey = (profile: SshProfile) =>
  JSON.stringify([profile.host, profile.port, profile.user, profile.fingerprint, profile.mode, profile.remotePort ?? null])

export function rememberSshProfile(input: SshHostInput) {
  const { host, port, user, fingerprint, mode, remotePort } = input
  const profile: SshProfile = { host, port, user, fingerprint, mode, ...(mode === 'attach' ? { remotePort } : {}), keyAuth: Boolean(input.privateKey) }
  const key = sshProfileKey(profile)
  const profiles = sshProfiles()
  const existing = profiles.find((row) => sshProfileKey(row) === key)
  if (input.useSavedCredentials && existing) profile.keyAuth = existing.keyAuth
  profile.savedCredentials = input.rememberCredentials || input.useSavedCredentials || existing?.savedCredentials
  writeProfiles([profile, ...profiles.filter((row) => sshProfileKey(row) !== key)])
}

function readProfile(value: unknown): SshProfile[] {
  if (value === null || typeof value !== 'object') return []
  const data = value as SshProfile
  try {
    if ((data.mode !== 'attach' && data.mode !== 'managed') || typeof data.keyAuth !== 'boolean') return []
    const checked = validateSshHost({ ...data, password: 'validation', launchToken: 'validation' })
    const { host, port, user, fingerprint, mode, remotePort } = checked
    return [{ host, port, user, fingerprint, mode, ...(mode === 'attach' ? { remotePort } : {}),
      keyAuth: data.keyAuth, savedCredentials: data.savedCredentials === true }]
  } catch {
    return []
  }
}

export function sshProfiles(): SshProfile[] {
  try {
    const saved = localStorage.getItem(PROFILE_KEY)
    const value: unknown = JSON.parse(saved ?? localStorage.getItem(LEGACY_PROFILE_KEY) ?? 'null')
    return Array.isArray(value) ? value.flatMap(readProfile) : readProfile(value)
  } catch { return [] }
}

function writeProfiles(profiles: SshProfile[]) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
    localStorage.removeItem(LEGACY_PROFILE_KEY)
  } catch { /* Storage may be unavailable. */ }
}

export async function forgetSshProfile(profile: SshProfile) {
  if (profile.savedCredentials) {
    const response = await fetch(PREFIX + 'forget', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new RemoteApiError('SSH_CREDENTIAL_STORAGE_FAILED', sshError('SSH_CREDENTIAL_STORAGE_FAILED'))
  }
  writeProfiles(sshProfiles().filter((row) => sshProfileKey(row) !== sshProfileKey(profile)))
}

export function validateSshHost(input: SshHostInput): SshHostInput {
  const details: SshHostInput = {
    ...input,
    host: input.host.trim().replace(/^\[(.+)\]$/u, '$1').toLowerCase(),
    user: input.user.trim(),
    fingerprint: input.fingerprint.trim().replace(/=$/u, ''),
  }
  const validPort = (port: number | undefined) => Number.isInteger(port) && port! >= 1 && port! <= 65_535
  const saved = details.useSavedCredentials === true
  if (!/^[A-Za-z0-9._:-]{1,253}$/u.test(details.host) || !/^[A-Za-z0-9._@-]{1,128}$/u.test(details.user) ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(details.fingerprint) || !validPort(details.port) ||
    (saved ? details.privateKey || details.password || details.launchToken : Boolean(details.privateKey) === Boolean(details.password)) ||
    (details.mode === 'attach' && (!validPort(details.remotePort) || (!saved && !details.launchToken?.trim())))) {
    throw new RemoteApiError('INVALID_SSH_REQUEST', 'Check the SSH address, credentials, and host fingerprint.')
  }
  return details
}

export async function supportsSshHost(): Promise<boolean> {
  try {
    const response = await fetch(PREFIX + 'health.json', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
    return response.ok && (await response.json()).version === 1
  } catch {
    return false
  }
}

export function createSshHost(input: SshHostInput, options: ConstructorParameters<typeof DshHttpLink>[1]): DshHttpLink {
  return new DshHttpLink(nativeBackend(validateSshHost(input)), options)
}

function nativeBackend(input: SshHostInput): DshHttpBackend {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const controller = new AbortController()
  const nativeHeaders = { 'X-Ds-Ssh-Id': id }
  let socket: WebSocket | undefined
  let closePosted = false
  const postClose = () => {
    if (closePosted) return
    closePosted = true
    void fetch(PREFIX + 'close', { method: 'POST', headers: nativeHeaders, keepalive: true }).catch(() => undefined)
  }
  return {
    async request(path, init, timeoutMs) {
      const signal = AbortSignal.any([
        controller.signal, AbortSignal.timeout(Math.min(300_000, Math.max(1, timeoutMs))),
        ...(init.signal ? [init.signal] : []),
      ])
      try {
        return await fetch(PREFIX + 'request', {
          method: 'POST',
          cache: 'no-store',
          body: init.body,
          headers: { ...nativeHeaders, 'X-Ds-Host-Path': path, 'X-Ds-Host-Method': init.method ?? 'GET' },
          signal,
        })
      } catch (error) {
        if (controller.signal.aborted || init.signal?.aborted) throw new RemoteApiError('RPC_ABORTED', 'The SSH connection closed.')
        if (signal.aborted) throw new RemoteApiError('RPC_TIMEOUT', 'The DSH Host request timed out.')
        throw new RemoteApiError('CONNECTION_FAILED', 'The DSH Host request did not complete.', undefined, true)
      }
    },
    async openMux(onFrame, onClose) {
      const response = await fetch(PREFIX + 'open', {
        method: 'POST',
        cache: 'no-store',
        headers: { ...nativeHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        if (typeof error?.code === 'string' && /^[A-Z_]{3,64}$/u.test(error.code)) {
          throw new RemoteApiError(error.code, sshError(error.code), response.status)
        }
        throw httpFailure(response.status)
      }
      controller.signal.throwIfAborted()
      const url = new URL(MUX_PATH, location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const local = new WebSocket(url)
      socket = local
      return await new Promise<Awaited<ReturnType<DshHttpBackend['openMux']>>>((resolve, reject) => {
        let ready = false
        const failOpen = () => reject(new RemoteApiError('SSH_MUX_UNAVAILABLE', sshError('SSH_MUX_UNAVAILABLE')))
        local.addEventListener('open', () => local.send(JSON.stringify({ type: 'connect', sshId: id })), { once: true })
        local.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') {
            local.close()
            return
          }
          if (ready) {
            onFrame(event.data)
            return
          }
          if (event.data !== '{"type":"open"}') {
            failOpen()
            return
          }
          ready = true
          resolve({
            send(frame) {
              if (local.readyState !== WebSocket.OPEN) throw new RemoteApiError('CONNECTION_FAILED', 'The SSH stream closed.')
              local.send(frame)
            },
            close: () => local.close(),
          })
        })
        local.addEventListener('close', () => {
          failOpen()
          if (ready) onClose()
        }, { once: true })
        local.addEventListener('error', failOpen, { once: true })
      })
    },
    close() {
      controller.abort()
      socket?.close()
      postClose()
    },
  }
}

function sshError(code: string): string {
  switch (code) {
    case 'PEER_IDENTITY_MISMATCH': return 'The SSH host key does not match the saved fingerprint.'
    case 'SSH_AUTH_FAILED': return 'The SSH host rejected these credentials.'
    case 'SSH_INVALID_KEY': return 'The SSH private key or its passphrase is invalid.'
    case 'SSH_DSH_LOGIN_FAILED': return 'DSH Web rejected the launch token.'
    case 'SSH_DSH_START_FAILED': return 'DSH Web did not start on the host.'
    case 'SSH_MUX_UNAVAILABLE': return 'DSH Web did not open the remote event stream.'
    case 'SSH_CREDENTIAL_STORAGE_FAILED': return 'Android could not read or save the SSH credentials.'
    default: return 'The SSH connection did not complete.'
  }
}
