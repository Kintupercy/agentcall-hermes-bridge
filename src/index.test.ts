import { describe, it, expect, beforeEach } from 'vitest'
import worker, {
  verifyHmacSignature,
  handlePrecall,
  handleHermesPush,
  handleTranscript,
  handleHermesPullTranscripts,
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

describe('handleTranscript', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  function transcriptPayload(callId: string): string {
    return JSON.stringify({
      callId,
      duration: 53,
      transcript: [
        { role: 'ai', text: 'Hey, what do you want to dig into?', timestamp: '2026-05-12T00:00:00Z' },
        { role: 'human', text: 'Walk me through this morning.', timestamp: '2026-05-12T00:00:05Z' },
      ],
      summary: {
        summary: 'David wanted a walkthrough of the morning brief.',
        callerName: 'David',
        intent: 'general_inquiry',
        urgency: 'medium',
        callbackBy: null,
        spam: false,
      },
    })
  }

  it('queues a transcript on valid HMAC', async () => {
    const body = transcriptPayload('call_1')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig, 'Content-Type': 'application/json' },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; queueDepth: number }
    expect(json.status).toBe('queued')
    expect(json.queueDepth).toBe(1)
  })

  it('appends transcripts in FIFO order without overwriting', async () => {
    for (const id of ['a', 'b', 'c']) {
      const body = transcriptPayload(id)
      const sig = await hmac(body, SIGNING_SECRET)
      const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
      const res = await handleTranscript(req, env)
      expect(res.status).toBe(200)
    }
    const stored = await env.HERMES_CONTEXT.get('transcript_queue')
    const queue = JSON.parse(stored!) as Array<{ callId: string }>
    expect(queue.map((t) => t.callId)).toEqual(['a', 'b', 'c'])
  })

  it('rejects an invalid HMAC signature', async () => {
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': 'sha256=0000' },
      body: transcriptPayload('call_1'),
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(401)
    expect(await env.HERMES_CONTEXT.get('transcript_queue')).toBeNull()
  })

  it('rejects invalid JSON even with valid HMAC', async () => {
    const body = 'not json'
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(400)
  })

  it('caps the queue at 100 entries and drops oldest', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({ callId: `old_${i}` }))
    await env.HERMES_CONTEXT.put('transcript_queue', JSON.stringify(existing))
    const body = transcriptPayload('newest')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(200)
    const stored = await env.HERMES_CONTEXT.get('transcript_queue')
    const queue = JSON.parse(stored!) as Array<{ callId: string }>
    expect(queue.length).toBe(100)
    expect(queue[0].callId).toBe('old_1') // oldest was dropped
    expect(queue[99].callId).toBe('newest')
  })
})

describe('handleHermesPullTranscripts', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('returns and clears the queue with valid push key', async () => {
    const seed = [{ callId: 'a' }, { callId: 'b' }]
    await env.HERMES_CONTEXT.put('transcript_queue', JSON.stringify(seed))
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { transcripts: Array<{ callId: string }>; count: number }
    expect(json.count).toBe(2)
    expect(json.transcripts.map((t) => t.callId)).toEqual(['a', 'b'])
    const stored = await env.HERMES_CONTEXT.get('transcript_queue')
    expect(stored).toBe('[]')
  })

  it('returns empty array when queue is unset', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { transcripts: unknown[]; count: number }
    expect(json.count).toBe(0)
    expect(json.transcripts).toEqual([])
  })

  it('rejects without push key', async () => {
    await env.HERMES_CONTEXT.put('transcript_queue', JSON.stringify([{ callId: 'should_not_leak' }]))
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', { method: 'POST' })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(401)
    // Queue remains intact after a rejected pull
    expect(await env.HERMES_CONTEXT.get('transcript_queue')).toBe(JSON.stringify([{ callId: 'should_not_leak' }]))
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

  it('routes POST /agentcall/transcript to handleTranscript', async () => {
    const body = JSON.stringify({ callId: 'call_route', duration: 1, transcript: [], summary: null })
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(200)
  })

  it('routes POST /hermes/pull-transcripts to handleHermesPullTranscripts', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(200)
  })

  it('end-to-end post-call loop: AgentCall pushes transcript → Hermes pulls → queue empty', async () => {
    // AgentCall pushes a transcript
    const body = JSON.stringify({
      callId: 'call_e2e',
      duration: 42,
      transcript: [{ role: 'ai', text: 'hello' }],
      summary: { summary: 'Hello.', callerName: null, intent: 'general_inquiry', urgency: 'low', callbackBy: null, spam: false },
    })
    const sig = await hmac(body, SIGNING_SECRET)
    const pushReq = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    expect((await worker.fetch(pushReq, env)).status).toBe(200)

    // Hermes pulls
    const pullReq = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const pullRes = await worker.fetch(pullReq, env)
    expect(pullRes.status).toBe(200)
    const json = (await pullRes.json()) as { transcripts: Array<{ callId: string }>; count: number }
    expect(json.count).toBe(1)
    expect(json.transcripts[0].callId).toBe('call_e2e')

    // Second pull is empty (queue was drained)
    const pullAgain = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const empty = await worker.fetch(pullAgain, env)
    expect(((await empty.json()) as { count: number }).count).toBe(0)
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
