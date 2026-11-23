import assert from 'node:assert/strict'
import { claimPairing, inspectPairingScan, mobilePairingProof, parsePairingScan } from '../devicePairing.js'
import type { DeviceIdentity } from '../identity.js'

// Public test vector from DSH Remote fixtures/pairing/v1/proof.json.
const identity: DeviceIdentity = {
  v: 1,
  deviceId: '019a0000-0000-7000-8000-000000000002',
  privateKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  publicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
  createdAt: 0,
}
const server = { url: 'https://pairing.example' }
const host = { role: 'host' as const, deviceId: 'host', name: 'Computer', platform: 'desktop', identityKey: identity.publicKey }
const offer = {
  server, host, sessionId: '019a0000-0000-7000-8000-000000000001', expiresAt: Date.now() + 100_000,
  serverPublicKey: 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns', scanSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}
const statusPath = `/api/v1/device-pairing/sessions/${offer.sessionId}/mobile/status`
assert.equal(mobilePairingProof(offer, identity, statusPath, '{}'), '3izg2tEapIkukkVFqJc7cPhHHtGLUEgHzs8f_O0r-Ag')
assert.deepEqual(parsePairingScan(`${server.url}/pair#v1.${offer.scanSecret}`), { server, ticket: offer.scanSecret })
assert.throws(() => parsePairingScan(`https://name@pairing.example/pair#v1.${offer.scanSecret}`))
assert.throws(() => parsePairingScan(`${server.url}/pair?relay=another#v1.${offer.scanSecret}`))
assert.deepEqual(parsePairingScan(JSON.stringify({ v: 1, type: 'dsh.remote.pairing', serverUrl: server.url, ...offer })), { server, offer })

const mobile = { deviceId: identity.deviceId, identityKey: identity.publicKey, role: 'client', platform: 'web', name: 'Chat Pad' }
const tokenPair = {
  accessToken: 'public-fixture-access-token', refreshToken: 'public-fixture-refresh-token',
  accessTokenExpiresAt: Date.now() + 120_000, refreshTokenExpiresAt: Date.now() + 240_000,
}
let wrongHost = false
const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  assert.equal(url, '/__ds_proxy')
  assert.equal(options?.redirect, 'error')
  const encoded = new Headers(options?.headers)
  const target = new URL(Buffer.from(encoded.get('X-DS-Target') ?? '', 'base64url').toString())
  const headers = JSON.parse(Buffer.from(encoded.get('X-DS-Headers') ?? '', 'base64url').toString())
  assert.equal(target.origin, server.url)
  const body = String(options?.body)
  if (target.pathname.endsWith('/resolve')) {
    assert.deepEqual(JSON.parse(body), { ticket: offer.scanSecret })
    return Response.json({ ...offer, v: 1 })
  }
  assert.equal(headers['X-DSH-Pairing-Proof'], mobilePairingProof(offer, identity, target.pathname, body))
  if (target.pathname.endsWith('/claim')) {
    assert.deepEqual(JSON.parse(body), { device: mobile, scanSecret: offer.scanSecret })
    return Response.json({ state: 'claimed', verificationCode: '00123456', expiresAt: offer.expiresAt })
  }
  assert.equal(target.pathname, statusPath)
  return Response.json({
    v: 1, sessionId: offer.sessionId, state: 'completed', host: wrongHost ? { ...host, deviceId: 'another' } : host, mobile,
    credentials: {
      account: 'dsh-device:fixture', accountKind: 'device_only', device: mobile,
      inboundOnly: false, pairingRestricted: true, tokens: tokenPair,
    },
  })
}
try {
  assert.deepEqual(await inspectPairingScan({ server, ticket: offer.scanSecret }), offer)
  const pairing = await claimPairing(offer, identity)
  assert.equal(pairing.code, '00123456')
  const result = await pairing.status()
  assert.equal(result.state, 'complete')
  assert.equal(result.state === 'complete' && result.account.refreshToken, tokenPair.refreshToken)
  wrongHost = true
  await assert.rejects(pairing.status(), { code: 'PAIRING_IDENTITY_MISMATCH' })
} finally {
  globalThis.fetch = realFetch
}
console.log('10 PASS / 0 FAIL / 10 TOTAL')
