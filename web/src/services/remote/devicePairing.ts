import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { fromBase64Url, isIdentityKey, toBase64Url, type DeviceIdentity } from './identity.js'
import { normalizeServerUrl, parseTokenPair, postMobilePairing, RemoteApiError, resolvePairingTicket } from './serverApi.js'
import type { RemoteAccount } from './storage.js'

interface PairingDevice {
  deviceId: string
  name: string
  platform: string
  role: 'client' | 'host'
  identityKey: string
}

export interface PairingOffer {
  server: { url: string }
  sessionId: string
  expiresAt: number
  serverPublicKey: string
  scanSecret: string
  host: PairingDevice
}

export type PairingScan = { server: { url: string }; ticket: string } | { server: { url: string }; offer: PairingOffer }
export type PairingStatus =
  | { state: 'waiting'; deadline: number }
  | { state: 'complete'; account: RemoteAccount }

const utf8 = new TextEncoder()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const invalid = () => new RemoteApiError('PAIRING_SCAN_INVALID', 'Invalid pairing code or offer.')

function readDevice(value: unknown, role: PairingDevice['role']): PairingDevice | undefined {
  if (!isRecord(value) || value.role !== role || !isIdentityKey(value.identityKey)
    || typeof value.deviceId !== 'string' || !value.deviceId || value.deviceId.length > 128
    || typeof value.name !== 'string' || value.name.length > 256
    || typeof value.platform !== 'string' || value.platform.length > 64) return undefined
  return { deviceId: value.deviceId, name: value.name, platform: value.platform, role, identityKey: value.identityKey }
}

function readOffer(value: unknown, server: PairingOffer['server'], ticket?: string): PairingOffer {
  if (!isRecord(value) || value.v !== 1 || typeof value.sessionId !== 'string' || !uuid.test(value.sessionId)
    || !validTime(value.expiresAt) || !isIdentityKey(value.serverPublicKey) || !isIdentityKey(value.scanSecret)
    || (ticket !== undefined && value.scanSecret !== ticket)) throw invalid()
  const host = readDevice(value.host, 'host')
  if (!host || host.identityKey === value.serverPublicKey) throw invalid()
  const now = Date.now()
  if (value.expiresAt <= now - 120_000 || value.expiresAt > now + 600_000) {
    throw new RemoteApiError('PAIRING_EXPIRED', 'The pairing offer expired.')
  }
  return {
    server, host, sessionId: value.sessionId, expiresAt: value.expiresAt,
    serverPublicKey: value.serverPublicKey, scanSecret: value.scanSecret,
  }
}

export function parsePairingScan(text: string): PairingScan {
  if (utf8.encode(text).length > 4096) throw invalid()
  const value = text.trim()
  if (value.startsWith('{')) {
    const body: unknown = JSON.parse(value)
    if (!isRecord(body) || body.type !== 'dsh.remote.pairing' || typeof body.serverUrl !== 'string') throw invalid()
    const url = normalizeServerUrl(body.serverUrl)
    if (url !== body.serverUrl) throw invalid()
    const server = { url }
    return { server, offer: readOffer(body, server) }
  }
  const parsed = new URL(value)
  const ticket = parsed.hash.slice(4)
  if (parsed.username || parsed.password || parsed.pathname !== '/pair' || parsed.search
    || !parsed.hash.startsWith('#v1.') || !isIdentityKey(ticket)) throw invalid()
  return { server: { url: normalizeServerUrl(parsed.origin) }, ticket }
}

export async function inspectPairingScan(scan: PairingScan): Promise<PairingOffer> {
  if ('offer' in scan) return scan.offer
  return readOffer(await resolvePairingTicket(scan.server, scan.ticket), scan.server, scan.ticket)
}

export function pairingFingerprint(offer: PairingOffer) {
  return bytesToHex(sha256(fromBase64Url(offer.host.identityKey)!)).match(/.{1,4}/g)?.join(' ') ?? ''
}

export function mobilePairingProof(offer: PairingOffer, identity: DeviceIdentity, path: string, body: string): string {
  const shared = x25519.getSharedSecret(fromBase64Url(identity.privateKey)!, fromBase64Url(offer.serverPublicKey)!)
  const key = hkdf(sha256, shared, utf8.encode(offer.sessionId), utf8.encode('dsh-pairing-v1/mobile'), 32)
  try {
    return toBase64Url(hmac(sha256, key, utf8.encode(`POST\n${path}\n${bytesToHex(sha256(utf8.encode(body)))}`)))
  } finally {
    shared.fill(0)
    key.fill(0)
  }
}

export async function claimPairing(offer: PairingOffer, identity: DeviceIdentity) {
  const mobile: PairingDevice = {
    deviceId: identity.deviceId, role: 'client', platform: 'web', name: 'Chat Pad', identityKey: identity.publicKey,
  }
  const path = `/api/v1/device-pairing/sessions/${offer.sessionId}`
  const body = JSON.stringify({ scanSecret: offer.scanSecret, device: mobile })
  const claim = await postMobilePairing(offer.server, `${path}/claim`, body, mobilePairingProof(offer, identity, `${path}/claim`, body))
  if (!isRecord(claim) || claim.state !== 'claimed' || typeof claim.verificationCode !== 'string'
    || !/^\d{8}$/.test(claim.verificationCode) || !validTime(claim.expiresAt)) throw invalid()

  const post = (route: string) =>
    postMobilePairing(offer.server, route, '{}', mobilePairingProof(offer, identity, route, '{}'))
  const deadline = claim.expiresAt + 120_000
  return {
    code: claim.verificationCode,
    deadline,
    async cancel() { await post(`${path}/mobile/cancel`) },
    async status(): Promise<PairingStatus> {
      const result = await post(`${path}/mobile/status`)
      if (!isRecord(result) || result.v !== 1 || result.sessionId !== offer.sessionId
        || !sameDevice(result.host, offer.host) || !sameDevice(result.mobile, mobile)) {
        throw new RemoteApiError('PAIRING_IDENTITY_MISMATCH', 'The pairing response reported another device.')
      }
      if (result.state === 'approved' || result.state === 'claimed') {
        return {
          state: 'waiting',
          deadline: validTime(result.recoverUntil) ? Math.min(deadline + 300_000, result.recoverUntil) : deadline,
        }
      }
      if (result.state !== 'completed') throw new RemoteApiError('PAIRING_ENDED', 'The Host declined, cancelled, or expired this pairing.')
      const credentials = result.credentials
      if (!isRecord(credentials) || !sameDevice(credentials.device, mobile) || credentials.inboundOnly !== false
        || (credentials.accountKind !== 'device_only' && credentials.accountKind !== 'standard')
        || typeof credentials.pairingRestricted !== 'boolean' || typeof credentials.account !== 'string'
        || !credentials.account.trim() || credentials.account.length > 320) throw invalid()
      const tokens = parseTokenPair(credentials.tokens)
      if (tokens.accessTokenExpiresAt <= Date.now() || tokens.refreshTokenExpiresAt <= Date.now()) {
        throw new RemoteApiError('PAIRING_EXPIRED', 'The paired credentials expired.')
      }
      return {
        state: 'complete',
        account: {
          ...tokens, email: credentials.account, deviceId: mobile.deviceId, deviceName: mobile.name,
          scope: 'device', loginMethod: 'pairing', serverUrl: offer.server.url,
        },
      }
    },
  }
}

function sameDevice(value: unknown, expected: PairingDevice) {
  const device = readDevice(value, expected.role)
  return device?.deviceId === expected.deviceId && device.identityKey === expected.identityKey
}
