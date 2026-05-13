import { describe, it, expect, beforeEach } from 'vitest'
import worker, {
  verifyHmacSignature,
  handlePrecall,
  handleHermesPush,
  type Env,
} from './index'

const SIGNING_SECRET = 'whsec_test_agentcall_secret_for_unit_tests_only'
const PUSH_KEY = 'hermes_push_test_key_xyz'

function createEnv(): Env {
  const store = new Map<string, string>()
  const kv: KVNamespace = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace
  return {
    HERMES_CONTEXT: kv,
    AGENTCALL_SIGNING_SECRET: SIGNING_SECRET,
    HERMES_PUSH_KEY: PUSH_KEY,
  }
}

async function hmac(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return (
    'sha256=' +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

describe('verifyHmacSignature', () => {
  it('accepts a correctly-signed body', async () => {
    const body = '{"caller":"+13145551234"}'
    const sig = await hmac(body, SIGNING_SECRET)
    expect(await verifyHmacSignature(body, sig, SIGNING_SECRET)).toBe(true)
  })

  it('rejects a signature for the wrong body', async () => {
    const sig = await hmac('{"caller":"+13145551234"}', SIGNING_SECRET)
    expect(await verifyHmacSignature('{"caller":"+19999999999"}', sig, SIGNING_SECRET)).toBe(false)
  })

  it('rejects a signature signed with a different secret', async () => {
    const body = '{"caller":"+13145551234"}'
    const sig = await hmac(body, 'wrong_secret')
    expect(await verifyHmacSignature(body, sig, SIGNING_SECRET)).toBe(false)
  })

  it('rejects when no signature header is provided', async () => {
    expect(await verifyHmacSignature('any', null, SIGNING_SECRET)).toBe(false)
  })

  it('rejects when signature header is missing the sha256= prefix', async () => {
    expect(await verifyHmacSignature('any', 'deadbeef', SIGNING_SECRET)).toBe(false)
  })

  it('rejects truncated signatures (defense against length-trick attacks)', async () => {
    const body = '{}'
    const sig = await hmac(body, SIGNING_SECRET)
    expect(await verifyHmacSignature(body, sig.slice(0, 20), SIGNING_SECRET)).toBe(false)
  })
})

describe('handlePrecall', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('returns stored contextBlock on valid HMAC', async () => {
    await env.HERMES_CONTEXT.put('current', 'Latest brief: review pricing.')
    const body = '{"caller":"+13145551234","numberId":"num_1","callId":"call_1","timestamp":"2026-05-12T00:00:00Z"}'
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/precall', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig, 'Content-Type': 'application/json' },
      body,
    })
    const res = await handlePrecall(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { contextBlock: string }
    expect(json.contextBlock).toBe('Latest brief: review pricing.')
  })

  it('returns empty contextBlock when KV has no stored value', async () => {
    const body = '{}'
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/precall', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handlePrecall(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { contextBlock: string }
    expect(json.contextBlock).toBe('')
  })

  it('returns 401 when the signature is invalid', async () => {
    await env.HERMES_CONTEXT.put('current', 'secret context')
    const req = new Request('https://hermes.agentcall.co/agentcall/precall', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': 'sha256=0000' },
      body: '{}',
    })
    const res = await handlePrecall(req, env)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('invalid_signature')
  })

  it('returns 401 when no signature header is present', async () => {
    const req = new Request('https://hermes.agentcall.co/agentcall/precall', {
      method: 'POST',
      body: '{}',
    })
    const res = await handlePrecall(req, env)
    expect(res.status).toBe(401)
  })
})

describe('handleHermesPush', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('stores contextBlock with valid push key', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextBlock: 'New brief from Hermes.' }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(200)
    expect(await env.HERMES_CONTEXT.get('current')).toBe('New brief from Hermes.')
  })

  it('returns 401 without push key', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      body: JSON.stringify({ contextBlock: 'attempted' }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(401)
    expect(await env.HERMES_CONTEXT.get('current')).toBeNull()
  })

  it('returns 401 with wrong push key', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': 'wrong_key' },
      body: JSON.stringify({ contextBlock: 'attempted' }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: 'not json',
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(400)
  })

  it('returns 400 when contextBlock field is missing', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: JSON.stringify({ wrong: 'field' }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(400)
  })

  it('returns 400 when contextBlock is not a string', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: JSON.stringify({ contextBlock: 42 }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(400)
  })

  it('truncates contextBlock at 5000 chars', async () => {
    const huge = 'x'.repeat(10_000)
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: JSON.stringify({ contextBlock: huge }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(200)
    const stored = await env.HERMES_CONTEXT.get('current')
    expect(stored?.length).toBe(5000)
  })
})

describe('worker.fetch (routing)', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('GET /healthz returns 200', async () => {
    const req = new Request('https://hermes.agentcall.co/healthz')
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(200)
  })

  it('returns 404 for unknown paths', async () => {
    const req = new Request('https://hermes.agentcall.co/totally-unknown')
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(404)
  })

  it('returns 404 for GET on /agentcall/precall (only POST allowed)', async () => {
    const req = new Request('https://hermes.agentcall.co/agentcall/precall')
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(404)
  })

  it('end-to-end: Hermes pushes → AgentCall fetches → contextBlock matches', async () => {
    // Hermes pushes context
    const pushReq = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: JSON.stringify({ contextBlock: 'Brief from Hermes for the call.' }),
    })
    expect((await worker.fetch(pushReq, env)).status).toBe(200)

    // AgentCall fetches with valid HMAC
    const body =
      '{"caller":"+13145551234","numberId":"num_xyz","callId":"call_abc","timestamp":"2026-05-12T22:00:00Z"}'
    const sig = await hmac(body, SIGNING_SECRET)
    const precallReq = new Request('https://hermes.agentcall.co/agentcall/precall', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig, 'Content-Type': 'application/json' },
      body,
    })
    const res = await worker.fetch(precallReq, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { contextBlock: string }
    expect(json.contextBlock).toBe('Brief from Hermes for the call.')
  })
})
