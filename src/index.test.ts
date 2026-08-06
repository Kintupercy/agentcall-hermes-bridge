import { describe, it, expect, beforeEach } from 'vitest'
import worker, {
  verifyHmacSignature,
  handlePrecall,
  handleHermesPush,
  handleTranscript,
  handleHermesPullTranscripts,
  handleAgentcallSms,
  handleHermesPullSms,
  handleHermesAckSms,
  timingSafeEqualString,
  type Env,
} from './index'

const SIGNING_SECRET = 'whsec_test_agentcall_secret_for_unit_tests_only'
const PUSH_KEY = 'hermes_push_test_key_xyz'

function createEnv(): Env {
  const store = new Map<string, string>()
  const kv: KVNamespace = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      // Mirror real Cloudflare KV: it rejects expirationTtl < 60 with a 400 and
      // the Worker throws (HTTP 500 / error 1101) if it isn't caught. The old
      // mock silently ignored the option, so a 30s lock TTL passed every test
      // but crashed the live pull endpoint. Enforce the floor here.
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${options.expirationTtl}. ` +
            `Expiration TTL must be at least 60.`,
        )
      }
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? ''
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name, expiration: null, metadata: null }))
      return { keys, list_complete: true, cacheStatus: null }
    },
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

describe('timingSafeEqualString', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true)
  })

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualString('abc', 'abd')).toBe(false)
  })

  it('returns false for strings of different length (early-out on length is safe — no info leak)', () => {
    // The expected value's length is a public constant from env, so length
    // mismatch can short-circuit without leaking secret material.
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualString('', 'abc')).toBe(false)
  })

  it('handles empty strings', () => {
    expect(timingSafeEqualString('', '')).toBe(true)
  })
})

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

  it('returns 401 with wrong push key (constant-time compare path)', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': 'wrong_key' },
      body: JSON.stringify({ contextBlock: 'attempted' }),
    })
    const res = await handleHermesPush(req, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 with same-length wrong push key (length is not a side-channel)', async () => {
    // PUSH_KEY = 'hermes_push_test_key_xyz' (24 chars). Same length, different content.
    const attempt = 'XXXXXX_XXXX_XXXX_XXX_XXX'
    expect(attempt.length).toBe(PUSH_KEY.length)
    const req = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': attempt },
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

describe('handleTranscript — back-compat (no agentId in envelope)', () => {
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

  it('queues under the default tenant when no agentId is present', async () => {
    const body = transcriptPayload('call_1')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig, 'Content-Type': 'application/json' },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; queueDepth: number; tenant: string }
    expect(json.status).toBe('queued')
    expect(json.queueDepth).toBe(1)
    expect(json.tenant).toBe('default')
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).not.toBeNull()
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
    const stored = await env.HERMES_CONTEXT.get('transcript_queue:default')
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
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBeNull()
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

  it('caps the queue at 100 entries per tenant and drops oldest', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({ callId: `old_${i}` }))
    await env.HERMES_CONTEXT.put('transcript_queue:default', JSON.stringify(existing))
    const body = transcriptPayload('newest')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(200)
    const stored = await env.HERMES_CONTEXT.get('transcript_queue:default')
    const queue = JSON.parse(stored!) as Array<{ callId: string }>
    expect(queue.length).toBe(100)
    expect(queue[0].callId).toBe('old_1') // oldest was dropped
    expect(queue[99].callId).toBe('newest')
  })
})

describe('handleTranscript — per-tenant queue (#23)', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  function payload(callId: string, agentId?: string): string {
    return JSON.stringify({
      callId,
      duration: 1,
      transcript: [],
      summary: null,
      ...(agentId ? { agentId } : {}),
    })
  }

  it('keys the queue by agentId when present at envelope root', async () => {
    const body = payload('call_1', 'agent_aaa')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handleTranscript(req, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { tenant: string }).tenant).toBe('agent_aaa')
    expect(await env.HERMES_CONTEXT.get('transcript_queue:agent_aaa')).not.toBeNull()
    // default tenant queue is untouched
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBeNull()
  })

  it('isolates two different agents into separate per-tenant queues', async () => {
    for (const [callId, agentId] of [
      ['c1', 'agent_aaa'],
      ['c2', 'agent_bbb'],
      ['c3', 'agent_aaa'],
    ] as const) {
      const body = payload(callId, agentId)
      const sig = await hmac(body, SIGNING_SECRET)
      const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
      await handleTranscript(req, env)
    }
    const aaaQueue = JSON.parse(
      (await env.HERMES_CONTEXT.get('transcript_queue:agent_aaa'))!,
    ) as Array<{ callId: string }>
    const bbbQueue = JSON.parse(
      (await env.HERMES_CONTEXT.get('transcript_queue:agent_bbb'))!,
    ) as Array<{ callId: string }>
    expect(aaaQueue.map((t) => t.callId)).toEqual(['c1', 'c3'])
    expect(bbbQueue.map((t) => t.callId)).toEqual(['c2'])
  })

  it('one agent flooding the queue cannot evict another agents transcripts', async () => {
    // Seed agent_quiet with 1 important transcript.
    await env.HERMES_CONTEXT.put(
      'transcript_queue:agent_quiet',
      JSON.stringify([{ callId: 'important_call' }]),
    )
    // agent_chatty floods to the per-tenant cap + 1.
    for (let i = 0; i <= 100; i++) {
      const body = payload(`flood_${i}`, 'agent_chatty')
      const sig = await hmac(body, SIGNING_SECRET)
      const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
      await handleTranscript(req, env)
    }
    // agent_quiet's transcript is still there — the per-tenant cap protected it.
    const quietStored = await env.HERMES_CONTEXT.get('transcript_queue:agent_quiet')
    const quietQueue = JSON.parse(quietStored!) as Array<{ callId: string }>
    expect(quietQueue).toEqual([{ callId: 'important_call' }])
  })

  it('sanitizes tenant key — strips non-URL-safe chars', async () => {
    const body = payload('c1', 'agent/with spaces and stuff')
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    const res = await handleTranscript(req, env)
    const json = (await res.json()) as { tenant: string }
    expect(json.tenant).not.toContain('/')
    expect(json.tenant).not.toContain(' ')
    expect(await env.HERMES_CONTEXT.get(`transcript_queue:${json.tenant}`)).not.toBeNull()
  })

  it('dedup-by-callId is scoped per-tenant (same callId on two agents both queue)', async () => {
    for (const agentId of ['agent_aaa', 'agent_bbb']) {
      const body = payload('shared_call_id', agentId)
      const sig = await hmac(body, SIGNING_SECRET)
      const req = new Request('https://hermes.agentcall.co/agentcall/transcript', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
      const res = await handleTranscript(req, env)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { status: string }).status).toBe('queued')
    }
    expect(await env.HERMES_CONTEXT.get('transcript_queue:agent_aaa')).not.toBeNull()
    expect(await env.HERMES_CONTEXT.get('transcript_queue:agent_bbb')).not.toBeNull()
  })
})

describe('handleHermesPullTranscripts', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('returns and clears the default-tenant queue with valid push key (back-compat)', async () => {
    const seed = [{ callId: 'a' }, { callId: 'b' }]
    await env.HERMES_CONTEXT.put('transcript_queue:default', JSON.stringify(seed))
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      transcripts: Array<{ callId: string }>
      count: number
      tenantsDrained: string[]
    }
    expect(json.count).toBe(2)
    expect(json.transcripts.map((t) => t.callId)).toEqual(['a', 'b'])
    expect(json.tenantsDrained).toEqual(['default'])
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBe('[]')
  })

  it('returns empty array when no queues exist', async () => {
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
    await env.HERMES_CONTEXT.put('transcript_queue:default', JSON.stringify([{ callId: 'should_not_leak' }]))
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', { method: 'POST' })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(401)
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBe(
      JSON.stringify([{ callId: 'should_not_leak' }]),
    )
  })

  it('rejects wrong push key (constant-time path)', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': 'definitely_not_the_key' },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(401)
  })

  it('merges transcripts across all per-tenant queues (#23 multi-tenant pull)', async () => {
    await env.HERMES_CONTEXT.put(
      'transcript_queue:agent_aaa',
      JSON.stringify([{ callId: 'aaa_1' }, { callId: 'aaa_2' }]),
    )
    await env.HERMES_CONTEXT.put(
      'transcript_queue:agent_bbb',
      JSON.stringify([{ callId: 'bbb_1' }]),
    )
    await env.HERMES_CONTEXT.put(
      'transcript_queue:default',
      JSON.stringify([{ callId: 'default_1' }]),
    )
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      transcripts: Array<{ callId: string }>
      count: number
      tenantsDrained: string[]
    }
    expect(json.count).toBe(4)
    // All four transcripts should be returned regardless of tenant ordering.
    const callIds = json.transcripts.map((t) => t.callId).sort()
    expect(callIds).toEqual(['aaa_1', 'aaa_2', 'bbb_1', 'default_1'])
    expect(json.tenantsDrained.sort()).toEqual(['agent_aaa', 'agent_bbb', 'default'])
    // All three queues cleared
    expect(await env.HERMES_CONTEXT.get('transcript_queue:agent_aaa')).toBe('[]')
    expect(await env.HERMES_CONTEXT.get('transcript_queue:agent_bbb')).toBe('[]')
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBe('[]')
  })

  it('returns 409 when a pull lock is already held (#21 concurrent pull guard)', async () => {
    // Simulate an in-flight pull by manually holding the lock.
    await env.HERMES_CONTEXT.put('transcript_queue_pull_lock', '1', { expirationTtl: 60 })
    await env.HERMES_CONTEXT.put(
      'transcript_queue:default',
      JSON.stringify([{ callId: 'must_not_drain' }]),
    )
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string; retryAfterSeconds: number }
    expect(json.error).toBe('pull_in_progress')
    expect(json.retryAfterSeconds).toBeGreaterThan(0)
    // The queue was NOT drained because the request was rejected.
    expect(await env.HERMES_CONTEXT.get('transcript_queue:default')).toBe(
      JSON.stringify([{ callId: 'must_not_drain' }]),
    )
  })

  it('releases the pull lock after a successful pull so the next caller can proceed', async () => {
    await env.HERMES_CONTEXT.put(
      'transcript_queue:default',
      JSON.stringify([{ callId: 'first_pull' }]),
    )
    const req1 = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res1 = await handleHermesPullTranscripts(req1, env)
    expect(res1.status).toBe(200)
    // Lock should be released
    expect(await env.HERMES_CONTEXT.get('transcript_queue_pull_lock')).toBeNull()
    // Next pull should NOT 409
    const req2 = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res2 = await handleHermesPullTranscripts(req2, env)
    expect(res2.status).toBe(200)
  })

  it('writes the pull lock with a KV-legal expirationTtl (>= 60s) — regression for error 1101', async () => {
    // The lock TTL used to be 30s. Cloudflare KV rejects any expirationTtl below
    // 60s and throws, which crashed every pull with HTTP 500 / error 1101 and
    // froze post-call transcripts from ever reaching Hermes. The strict mock KV
    // now throws on a sub-60 TTL, so a successful (non-throwing) pull proves the
    // lock TTL is legal. Seed a queue so the handler takes the full drain path.
    await env.HERMES_CONTEXT.put(
      'transcript_queue:default',
      JSON.stringify([{ callId: 'must_drain' }]),
    )
    const req = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullTranscripts(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { count: number }
    expect(json.count).toBe(1)
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

    const pullReq = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const pullRes = await worker.fetch(pullReq, env)
    expect(pullRes.status).toBe(200)
    const json = (await pullRes.json()) as { transcripts: Array<{ callId: string }>; count: number }
    expect(json.count).toBe(1)
    expect(json.transcripts[0].callId).toBe('call_e2e')

    const pullAgain = new Request('https://hermes.agentcall.co/hermes/pull-transcripts', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const empty = await worker.fetch(pullAgain, env)
    expect(((await empty.json()) as { count: number }).count).toBe(0)
  })

  it('end-to-end: Hermes pushes → AgentCall fetches → contextBlock matches', async () => {
    const pushReq = new Request('https://hermes.agentcall.co/hermes/push', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      body: JSON.stringify({ contextBlock: 'Brief from Hermes for the call.' }),
    })
    expect((await worker.fetch(pushReq, env)).status).toBe(200)

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

function relayPayload(
  messageId: string,
  opts: { agentId?: string; numberId?: string; body?: string } = {},
): string {
  return JSON.stringify({
    message: {
      id: messageId,
      from: '+13146006254',
      to: '+13146970472',
      body: opts.body ?? 'hey laura',
      receivedAt: '2026-06-07T16:00:00Z',
    },
    conversation: { id: `smsconv_${messageId}`, contactPhone: '+13146006254' },
    context: {
      channel: 'sms',
      numberId: opts.numberId ?? 'num_laura',
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    },
  })
}

describe('handleAgentcallSms', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('queues under the tenant from context.agentId', async () => {
    const body = relayPayload('msg_1', { agentId: 'agent_abc' })
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig, 'Content-Type': 'application/json' },
      body,
    })
    const res = await handleAgentcallSms(req, env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; queueDepth: number; tenant: string }
    expect(json.status).toBe('queued')
    expect(json.queueDepth).toBe(1)
    expect(json.tenant).toBe('agent_abc')
    expect(await env.HERMES_CONTEXT.get('sms_queue:agent_abc')).not.toBeNull()
  })

  it('falls back to numberId then default when agentId is absent', async () => {
    const byNumber = relayPayload('msg_n', {})
    const sig = await hmac(byNumber, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body: byNumber,
    })
    const res = await handleAgentcallSms(req, env)
    const json = (await res.json()) as { tenant: string }
    expect(json.tenant).toBe('num_laura')
  })

  it('dedups on message.id (retry storm does not double-queue)', async () => {
    const body = relayPayload('msg_dup', { agentId: 'a1' })
    const sig = await hmac(body, SIGNING_SECRET)
    const mk = () =>
      new Request('https://hermes.agentcall.co/agentcall/sms', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
    const first = (await (await handleAgentcallSms(mk(), env)).json()) as { status: string }
    const second = (await (await handleAgentcallSms(mk(), env)).json()) as {
      status: string
      queueDepth: number
    }
    expect(first.status).toBe('queued')
    expect(second.status).toBe('duplicate')
    expect(second.queueDepth).toBe(1)
  })

  it('appends in FIFO order', async () => {
    for (const id of ['a', 'b', 'c']) {
      const body = relayPayload(id, { agentId: 'a1' })
      const sig = await hmac(body, SIGNING_SECRET)
      const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
        method: 'POST',
        headers: { 'X-AgentCall-Signature': sig },
        body,
      })
      expect((await handleAgentcallSms(req, env)).status).toBe(200)
    }
    const stored = await env.HERMES_CONTEXT.get('sms_queue:a1')
    const queue = JSON.parse(stored!) as Array<{ message: { id: string } }>
    expect(queue.map((m) => m.message.id)).toEqual(['a', 'b', 'c'])
  })

  it('rejects an invalid HMAC signature and stores nothing', async () => {
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': 'sha256=0000' },
      body: relayPayload('msg_x', { agentId: 'a1' }),
    })
    const res = await handleAgentcallSms(req, env)
    expect(res.status).toBe(401)
    expect(await env.HERMES_CONTEXT.get('sms_queue:a1')).toBeNull()
  })

  it('rejects invalid JSON even with a valid HMAC', async () => {
    const body = 'not json'
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    expect((await handleAgentcallSms(req, env)).status).toBe(400)
  })

  it('caps the queue at 200 entries per tenant and drops oldest', async () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({ message: { id: `old_${i}` } }))
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify(existing))
    const body = relayPayload('newest', { agentId: 'a1' })
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    expect((await handleAgentcallSms(req, env)).status).toBe(200)
    const stored = await env.HERMES_CONTEXT.get('sms_queue:a1')
    const queue = JSON.parse(stored!) as Array<{ message: { id: string } }>
    expect(queue.length).toBe(200)
    expect(queue[0].message.id).toBe('old_1')
    expect(queue[199].message.id).toBe('newest')
  })

  it('uses the dedicated SMS signing secret when set (channels isolated)', async () => {
    const smsSecret = 'sms_only_secret_for_relay_unit_test'
    env.AGENTCALL_SMS_SIGNING_SECRET = smsSecret
    // Signed with the dedicated SMS secret -> accepted.
    const good = relayPayload('msg_sep', { agentId: 'a1' })
    const goodReq = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': await hmac(good, smsSecret) },
      body: good,
    })
    expect((await handleAgentcallSms(goodReq, env)).status).toBe(200)
    // Signed with the shared precall/transcript secret -> rejected once the
    // dedicated secret is set.
    const bad = relayPayload('msg_sep2', { agentId: 'a1' })
    const badReq = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': await hmac(bad, SIGNING_SECRET) },
      body: bad,
    })
    expect((await handleAgentcallSms(badReq, env)).status).toBe(401)
  })
})

describe('handleHermesPullSms', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('rejects a missing/invalid push key', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/pull-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': 'wrong' },
    })
    expect((await handleHermesPullSms(req, env)).status).toBe(401)
  })

  function pullReq() {
    return new Request('https://hermes.agentcall.co/hermes/pull-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
  }

  it('claims all per-tenant queues (returns them) without deleting', async () => {
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify([{ message: { id: 'm1' } }]))
    await env.HERMES_CONTEXT.put('sms_queue:a2', JSON.stringify([{ message: { id: 'm2' } }]))
    const res = await handleHermesPullSms(pullReq(), env)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { messages: unknown[]; count: number; tenantsDelivered: string[] }
    expect(json.count).toBe(2)
    expect(json.tenantsDelivered.sort()).toEqual(['a1', 'a2'])
    // NOT deleted — still present in KV, now claimed (so a canceled pull can't lose them).
    expect(JSON.parse((await env.HERMES_CONTEXT.get('sms_queue:a1'))!)).toHaveLength(1)
  })

  it('strips the _claimedAt bookkeeping field from returned messages', async () => {
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify([{ message: { id: 'm1' }, body: 'hi' }]))
    const res = await handleHermesPullSms(pullReq(), env)
    const json = (await res.json()) as { messages: Array<Record<string, unknown>> }
    expect(json.messages[0]).not.toHaveProperty('_claimedAt')
    // but the stored copy is stamped
    const stored = JSON.parse((await env.HERMES_CONTEXT.get('sms_queue:a1'))!) as Array<Record<string, unknown>>
    expect(typeof stored[0]._claimedAt).toBe('number')
  })

  it('does not redeliver a still-claimed message on the next pull', async () => {
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify([{ message: { id: 'm1' } }]))
    const first = (await (await handleHermesPullSms(pullReq(), env)).json()) as { count: number }
    expect(first.count).toBe(1)
    const second = (await (await handleHermesPullSms(pullReq(), env)).json()) as { count: number }
    expect(second.count).toBe(0) // hidden within the visibility window
  })

  it('redelivers a message whose claim has expired (consumer crashed before ack)', async () => {
    // Seed with an ancient claim timestamp so it's past SMS_VISIBILITY_MS.
    await env.HERMES_CONTEXT.put(
      'sms_queue:a1',
      JSON.stringify([{ message: { id: 'm1' }, _claimedAt: 1 }]),
    )
    const res = (await (await handleHermesPullSms(pullReq(), env)).json()) as {
      count: number
      messages: Array<{ message: { id: string } }>
    }
    expect(res.count).toBe(1)
    expect(res.messages[0].message.id).toBe('m1')
  })

  it('does not drain the transcript queues (prefix isolation)', async () => {
    await env.HERMES_CONTEXT.put('transcript_queue:default', JSON.stringify([{ callId: 'c1' }]))
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify([{ message: { id: 'm1' } }]))
    const req = new Request('https://hermes.agentcall.co/hermes/pull-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    const res = await handleHermesPullSms(req, env)
    const json = (await res.json()) as { count: number }
    expect(json.count).toBe(1)
    // transcript queue untouched
    expect(JSON.parse((await env.HERMES_CONTEXT.get('transcript_queue:default'))!)).toHaveLength(1)
  })
})

describe('handleHermesAckSms', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  function ackReq(body: unknown, key = PUSH_KEY) {
    return new Request('https://hermes.agentcall.co/hermes/ack-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects a missing/invalid push key', async () => {
    expect((await handleHermesAckSms(ackReq({ messageIds: ['m1'] }, 'wrong'), env)).status).toBe(401)
  })

  it('400s when messageIds is missing or empty', async () => {
    expect((await handleHermesAckSms(ackReq({}), env)).status).toBe(400)
    expect((await handleHermesAckSms(ackReq({ messageIds: [] }), env)).status).toBe(400)
  })

  it('removes acked messages from their queue', async () => {
    await env.HERMES_CONTEXT.put(
      'sms_queue:a1',
      JSON.stringify([{ message: { id: 'm1' } }, { message: { id: 'm2' } }]),
    )
    const res = await handleHermesAckSms(ackReq({ messageIds: ['m1'] }), env)
    expect(res.status).toBe(200)
    expect((await res.json() as { removed: number }).removed).toBe(1)
    const remaining = JSON.parse((await env.HERMES_CONTEXT.get('sms_queue:a1'))!) as Array<{ message: { id: string } }>
    expect(remaining.map((m) => m.message.id)).toEqual(['m2'])
  })

  it('is idempotent — acking an unknown id is a no-op (removed: 0)', async () => {
    await env.HERMES_CONTEXT.put('sms_queue:a1', JSON.stringify([{ message: { id: 'm1' } }]))
    const res = await handleHermesAckSms(ackReq({ messageIds: ['nope'] }), env)
    expect((await res.json() as { removed: number }).removed).toBe(0)
    expect(JSON.parse((await env.HERMES_CONTEXT.get('sms_queue:a1'))!)).toHaveLength(1)
  })
})

describe('worker.fetch (SMS relay routing + e2e)', () => {
  let env: Env

  beforeEach(() => {
    env = createEnv()
  })

  it('routes POST /agentcall/sms to handleAgentcallSms', async () => {
    const body = relayPayload('route_1', { agentId: 'a1' })
    const sig = await hmac(body, SIGNING_SECRET)
    const req = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    expect((await worker.fetch(req, env)).status).toBe(200)
  })

  it('routes POST /hermes/pull-sms to handleHermesPullSms', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/pull-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY },
    })
    expect((await worker.fetch(req, env)).status).toBe(200)
  })

  it('routes POST /hermes/ack-sms to handleHermesAckSms', async () => {
    const req = new Request('https://hermes.agentcall.co/hermes/ack-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: ['x'] }),
    })
    expect((await worker.fetch(req, env)).status).toBe(200)
  })

  it('end-to-end relay: push → claim → ack → gone', async () => {
    const body = relayPayload('e2e_sms', { agentId: 'a1', body: 'what is on my plate today?' })
    const sig = await hmac(body, SIGNING_SECRET)
    const pushReq = new Request('https://hermes.agentcall.co/agentcall/sms', {
      method: 'POST',
      headers: { 'X-AgentCall-Signature': sig },
      body,
    })
    expect((await worker.fetch(pushReq, env)).status).toBe(200)

    const mkPull = () =>
      new Request('https://hermes.agentcall.co/hermes/pull-sms', {
        method: 'POST',
        headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      })

    // Claim it.
    const pullRes = await worker.fetch(mkPull(), env)
    const json = (await pullRes.json()) as {
      messages: Array<{ message: { id: string }; conversation: { id: string } }>
      count: number
    }
    expect(json.count).toBe(1)
    expect(json.messages[0].message.id).toBe('e2e_sms')
    expect(json.messages[0].conversation.id).toBe('smsconv_e2e_sms')

    // Still claimed → next pull sees nothing (no double-processing).
    const claimed = await worker.fetch(mkPull(), env)
    expect(((await claimed.json()) as { count: number }).count).toBe(0)

    // Ack it → removed for good.
    const ackReq = new Request('https://hermes.agentcall.co/hermes/ack-sms', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: ['e2e_sms'] }),
    })
    expect((await worker.fetch(ackReq, env)).status).toBe(200)
    expect(JSON.parse((await env.HERMES_CONTEXT.get('sms_queue:a1'))!)).toEqual([])
  })
})

describe('handleAgentcallAction', () => {
  const actionUrl = 'https://hermes.agentcall.co/agentcall/action'

  async function signedActionRequest(payload: unknown, secret = SIGNING_SECRET) {
    const body = JSON.stringify(payload)
    return new Request(actionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentCall-Signature': await hmac(body, secret),
      },
      body,
    })
  }

  it('rejects an unsigned request', async () => {
    const env = createEnv()
    const req = new Request(actionUrl, { method: 'POST', body: '{}' })
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(401)
  })

  it('prefers the dedicated action secret when set (shared secret then fails)', async () => {
    const env = createEnv()
    env.AGENTCALL_ACTION_SIGNING_SECRET = 'dedicated_action_secret_for_tests'
    const sharedSigned = await signedActionRequest({ tool: 'get_latest_brief' }, SIGNING_SECRET)
    expect((await worker.fetch(sharedSigned, env)).status).toBe(401)
    const dedicatedSigned = await signedActionRequest(
      { tool: 'get_latest_brief' },
      'dedicated_action_secret_for_tests',
    )
    expect((await worker.fetch(dedicatedSigned, env)).status).toBe(200)
  })

  it('get_latest_brief returns the stored context block', async () => {
    const env = createEnv()
    await env.HERMES_CONTEXT.put('current', 'Priorities: ship the demo.')
    const res = await worker.fetch(
      await signedActionRequest({ tool: 'get_latest_brief', arguments: {} }),
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: string }).result).toBe('Priorities: ship the demo.')
  })

  it('get_latest_brief degrades gracefully when no brief is stored', async () => {
    const env = createEnv()
    const res = await worker.fetch(await signedActionRequest({ tool: 'get_latest_brief' }), env)
    const { result } = (await res.json()) as { result: string }
    expect(result).toContain('No brief is available')
  })

  it('save_note queues the note per tenant with id, timestamp, and context', async () => {
    const env = createEnv()
    const res = await worker.fetch(
      await signedActionRequest({
        tool: 'save_note',
        arguments: { note: 'Follow up with the spa lead Friday.' },
        context: { channel: 'sms', agentId: 'agentX', contact: { phone: '+13146006254' } },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: string }).result).toContain('Note saved')
    const queue = JSON.parse((await env.HERMES_CONTEXT.get('notes_queue:agentX'))!) as Array<{
      id: string
      note: string
      savedAt: string
      channel: string
      contactPhone: string
    }>
    expect(queue).toHaveLength(1)
    expect(queue[0].note).toBe('Follow up with the spa lead Friday.')
    expect(queue[0].id).toMatch(/^note_/)
    expect(queue[0].channel).toBe('sms')
    expect(queue[0].contactPhone).toBe('+13146006254')
  })

  it('save_note with empty note text replies without writing', async () => {
    const env = createEnv()
    const res = await worker.fetch(
      await signedActionRequest({
        tool: 'save_note',
        arguments: { note: '   ' },
        context: { channel: 'sms', agentId: 'agentX' },
      }),
      env,
    )
    expect(((await res.json()) as { result: string }).result).toContain('empty')
    expect(await env.HERMES_CONTEXT.get('notes_queue:agentX')).toBeNull()
  })

  it('caps the per-tenant notes queue (oldest evicted)', async () => {
    const env = createEnv()
    const existing = Array.from({ length: 200 }, (_, i) => ({ id: `note_old_${i}`, note: 'x' }))
    await env.HERMES_CONTEXT.put('notes_queue:agentX', JSON.stringify(existing))
    await worker.fetch(
      await signedActionRequest({
        tool: 'save_note',
        arguments: { note: 'newest' },
        context: { channel: 'sms', agentId: 'agentX' },
      }),
      env,
    )
    const queue = JSON.parse((await env.HERMES_CONTEXT.get('notes_queue:agentX'))!) as Array<{
      id: string
      note: string
    }>
    expect(queue).toHaveLength(200)
    expect(queue[0].id).toBe('note_old_1')
    expect(queue[199].note).toBe('newest')
  })

  it('unknown tool returns 200 with an explanatory result (LLM-readable, not fail-soft)', async () => {
    const env = createEnv()
    const res = await worker.fetch(
      await signedActionRequest({ tool: 'send_rocket', arguments: {} }),
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: string }).result).toContain("Unknown tool 'send_rocket'")
  })
})

describe('notes pull + ack', () => {
  it('pull requires the push key', async () => {
    const env = createEnv()
    const res = await worker.fetch(
      new Request('https://hermes.agentcall.co/hermes/pull-notes', { method: 'POST' }),
      env,
    )
    expect(res.status).toBe(401)
  })

  it('pull returns notes without deleting; ack removes them for good', async () => {
    const env = createEnv()
    await env.HERMES_CONTEXT.put(
      'notes_queue:agentX',
      JSON.stringify([{ id: 'note_1', note: 'a' }, { id: 'note_2', note: 'b' }]),
    )
    const mkPull = () =>
      new Request('https://hermes.agentcall.co/hermes/pull-notes', {
        method: 'POST',
        headers: { 'X-Hermes-Push-Key': PUSH_KEY },
      })

    const first = (await (await worker.fetch(mkPull(), env)).json()) as { notes: unknown[]; count: number }
    expect(first.count).toBe(2)
    const second = (await (await worker.fetch(mkPull(), env)).json()) as { count: number }
    expect(second.count).toBe(2)

    const ack = new Request('https://hermes.agentcall.co/hermes/ack-notes', {
      method: 'POST',
      headers: { 'X-Hermes-Push-Key': PUSH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_1'] }),
    })
    const ackJson = (await (await worker.fetch(ack, env)).json()) as { removed: number }
    expect(ackJson.removed).toBe(1)
    const remaining = (await (await worker.fetch(mkPull(), env)).json()) as {
      notes: Array<{ id: string }>
      count: number
    }
    expect(remaining.count).toBe(1)
    expect(remaining.notes[0].id).toBe('note_2')
  })

  it('ack with no ids is a 400; unknown ids are a no-op', async () => {
    const env = createEnv()
    await env.HERMES_CONTEXT.put('notes_queue:agentX', JSON.stringify([{ id: 'note_1', note: 'a' }]))
    const mkAck = (body: unknown) =>
      new Request('https://hermes.agentcall.co/hermes/ack-notes', {
        method: 'POST',
        headers: { 'X-Hermes-Push-Key': PUSH_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await worker.fetch(mkAck({}), env)).status).toBe(400)
    const unknown = (await (await worker.fetch(mkAck({ noteIds: ['nope'] }), env)).json()) as {
      removed: number
    }
    expect(unknown.removed).toBe(0)
    expect(JSON.parse((await env.HERMES_CONTEXT.get('notes_queue:agentX'))!)).toHaveLength(1)
  })
})
