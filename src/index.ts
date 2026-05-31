/**
 * hermes-bridge: a Cloudflare Worker that bridges AgentCall's pre-call and
 * post-call webhooks to Hermes (Percy's agent platform). Decouples the
 * always-on bridge from Hermes itself, which runs in a local Docker container.
 *
 * Endpoints:
 *  - POST /agentcall/precall      AgentCall calls this on inbound call connect.
 *                                 Verifies HMAC signature, reads `current` from
 *                                 KV, returns {contextBlock: ...}.
 *  - POST /agentcall/transcript   AgentCall calls this after a call ends with
 *                                 the full transcript + LLM summary. Verifies
 *                                 HMAC signature, appends to a bounded queue
 *                                 in KV for Hermes to pull on its own schedule.
 *                                 Queue is keyed per-agent so a multi-agent
 *                                 fork of this template doesn't let one agent's
 *                                 flood evict another's transcripts.
 *  - POST /hermes/push            Hermes calls this on cron to update the
 *                                 stored pre-call context. Protected by
 *                                 X-Hermes-Push-Key header (constant-time
 *                                 comparison).
 *  - POST /hermes/pull-transcripts Hermes polls this to drain queued post-call
 *                                 transcripts across all per-agent queues.
 *                                 Returns all stored entries and clears each
 *                                 queue. Protected by a KV soft-lock so two
 *                                 concurrent pulls can't both clear the queue
 *                                 and drop in-flight transcripts. Protected by
 *                                 X-Hermes-Push-Key header (constant-time).
 *  - GET  /healthz                Liveness probe.
 *
 * Known gaps tracked for follow-up PRs:
 *  - HMAC replay protection (X-AgentCall-Timestamp + max-age window) requires
 *    a coordinated change on AgentCall's signer side to avoid breaking other
 *    customers using legacy verification. Will land in a separate PR with
 *    customer-notice rollout.
 */

export interface Env {
  HERMES_CONTEXT: KVNamespace
  AGENTCALL_SIGNING_SECRET: string
  HERMES_PUSH_KEY: string
}

const KV_KEY = 'current'
const TRANSCRIPT_QUEUE_PREFIX = 'transcript_queue:'
const DEFAULT_TENANT = 'default'
const PULL_LOCK_KEY = 'transcript_queue_pull_lock'
// Cloudflare KV rejects any `expirationTtl` below 60 seconds and throws,
// which would crash the whole pull handler (Worker error 1101 / HTTP 500).
// 60 is the documented floor, so the lock cannot be shorter than this.
const PULL_LOCK_TTL_SECONDS = 60
const MAX_CONTEXT_CHARS = 5000
const MAX_QUEUED_TRANSCRIPTS_PER_TENANT = 100

/**
 * Constant-time string comparison. Returns true iff a === b after comparing
 * every character. Used for HMAC + push-key checks so an attacker can't
 * use response-time measurements to learn the expected value byte-by-byte.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export async function verifyHmacSignature(
  body: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const provided = signatureHeader.slice(7)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return timingSafeEqualString(expected, provided)
}

export async function handlePrecall(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const signature = request.headers.get('X-AgentCall-Signature')
  const valid = await verifyHmacSignature(body, signature, env.AGENTCALL_SIGNING_SECRET)
  if (!valid) {
    return jsonResponse({ error: 'invalid_signature' }, 401)
  }
  const stored = await env.HERMES_CONTEXT.get(KV_KEY)
  return jsonResponse({ contextBlock: stored ?? '' })
}

export async function handleHermesPush(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-Hermes-Push-Key')
  // Constant-time compare so an attacker can't measure response time to
  // learn the expected push key byte-by-byte. The HMAC path already did
  // this; the push-key path was using `!==` and leaking length info.
  if (!key || !timingSafeEqualString(key, env.HERMES_PUSH_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { contextBlock?: unknown }).contextBlock !== 'string'
  ) {
    return jsonResponse({ error: 'contextBlock_required' }, 400)
  }
  const contextBlock = (parsed as { contextBlock: string }).contextBlock.slice(
    0,
    MAX_CONTEXT_CHARS,
  )
  await env.HERMES_CONTEXT.put(KV_KEY, contextBlock)
  return jsonResponse({ status: 'ok', storedLength: contextBlock.length })
}

export async function handleTranscript(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const signature = request.headers.get('X-AgentCall-Signature')
  const valid = await verifyHmacSignature(body, signature, env.AGENTCALL_SIGNING_SECRET)
  if (!valid) {
    return jsonResponse({ error: 'invalid_signature' }, 401)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }

  // Per-tenant queue keying. Forks of this template that serve multiple
  // AgentCall agents (one shared signing secret across tenants) get
  // independent FIFOs per agent — a chatty agent can't evict another
  // agent's transcripts out of the bounded queue. Percy's single-agent
  // deployment lands on 'default' and is functionally identical to the
  // pre-fix global key.
  const tenant = extractTenant(parsed)
  const queueKey = `${TRANSCRIPT_QUEUE_PREFIX}${tenant}`

  const stored = await env.HERMES_CONTEXT.get(queueKey)
  const queue: unknown[] = stored ? safeParseArray(stored) : []
  // Dedup on callId. AgentCall's webhook worker retries up to 5 times on any
  // non-2xx response, so a transient KV write blip would cause the same call
  // to land in the queue more than once. Returning 200 + status:'duplicate'
  // tells the worker the delivery succeeded so it stops retrying.
  const incomingCallId = extractCallId(parsed)
  if (incomingCallId && queue.some((item) => extractCallId(item) === incomingCallId)) {
    return jsonResponse({ status: 'duplicate', callId: incomingCallId, queueDepth: queue.length, tenant })
  }
  queue.push(parsed)
  // Bounded FIFO: drop oldest if Hermes hasn't pulled in a while. Prevents
  // the per-tenant KV value from growing without bound during a Hermes
  // outage. Cloudflare KV values cap at 25MB; this keeps us well under it.
  if (queue.length > MAX_QUEUED_TRANSCRIPTS_PER_TENANT) {
    queue.splice(0, queue.length - MAX_QUEUED_TRANSCRIPTS_PER_TENANT)
  }
  await env.HERMES_CONTEXT.put(queueKey, JSON.stringify(queue))
  return jsonResponse({ status: 'queued', queueDepth: queue.length, tenant })
}

function extractCallId(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null
  const env = envelope as { data?: { callId?: unknown }; callId?: unknown }
  if (env.data && typeof env.data === 'object' && typeof env.data.callId === 'string') {
    return env.data.callId
  }
  if (typeof env.callId === 'string') return env.callId
  return null
}

/**
 * Extract the tenant key (agentId, falling back to numberId) from an
 * incoming envelope. The bridge accepts the field at either the envelope
 * root or under `data` so it tolerates both shapes AgentCall has used.
 * Returns 'default' when nothing usable is present — Percy's single-agent
 * setup hits this branch and continues to work without code changes.
 */
function extractTenant(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return DEFAULT_TENANT
  const env = envelope as {
    agentId?: unknown
    numberId?: unknown
    data?: { agentId?: unknown; numberId?: unknown }
  }
  const candidates = [env.agentId, env.data?.agentId, env.numberId, env.data?.numberId]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c.length <= 100) {
      return sanitizeTenantKey(c)
    }
  }
  return DEFAULT_TENANT
}

/**
 * Strip anything that isn't a sensible KV-key character. KV allows almost
 * anything but we keep keys URL-safe so logs / queries are predictable.
 */
function sanitizeTenantKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
}

export async function handleHermesPullTranscripts(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-Hermes-Push-Key')
  if (!key || !timingSafeEqualString(key, env.HERMES_PUSH_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  // Soft lock to prevent two concurrent pulls from racing the
  // read-then-clear and dropping transcripts that land between them.
  // KV has no CAS so there's a small read-then-write window where two
  // pullers can both see "no lock" — acceptable given Hermes is the
  // sole legitimate caller (single-threaded) and the lock's `expirationTtl`
  // means a crashed pull releases it automatically. Full closure requires
  // a Durable Object; tracked as a follow-up.
  const existingLock = await env.HERMES_CONTEXT.get(PULL_LOCK_KEY)
  if (existingLock) {
    return jsonResponse(
      { error: 'pull_in_progress', retryAfterSeconds: PULL_LOCK_TTL_SECONDS },
      409,
    )
  }
  await env.HERMES_CONTEXT.put(PULL_LOCK_KEY, '1', { expirationTtl: PULL_LOCK_TTL_SECONDS })

  try {
    // List all per-tenant queues. For typical fork deployments (a handful
    // of agents) one list call is enough; KV returns up to 1000 keys per
    // page. Multi-thousand-tenant forks would need pagination — tracked
    // as a follow-up but not relevant for any current deployment.
    const list = await env.HERMES_CONTEXT.list({ prefix: TRANSCRIPT_QUEUE_PREFIX })
    const allTranscripts: unknown[] = []
    const tenantsDrained: string[] = []

    for (const entry of list.keys) {
      const stored = await env.HERMES_CONTEXT.get(entry.name)
      if (!stored) continue
      const queue = safeParseArray(stored)
      if (queue.length === 0) continue
      allTranscripts.push(...queue)
      tenantsDrained.push(entry.name.slice(TRANSCRIPT_QUEUE_PREFIX.length))
      // Empty the per-tenant queue. The push-during-pull window (a new
      // transcript lands between the read above and the clear below) is
      // small but real; closing it fully requires Durable Objects. Worst
      // case today is one stray transcript per tenant per concurrent
      // pull, and the lock above prevents the more damaging case of
      // concurrent pulls each clearing the same queue.
      await env.HERMES_CONTEXT.put(entry.name, '[]')
    }

    return jsonResponse({
      transcripts: allTranscripts,
      count: allTranscripts.length,
      tenantsDrained,
    })
  } finally {
    await env.HERMES_CONTEXT.delete(PULL_LOCK_KEY).catch(() => {
      // Best-effort. The lock has expirationTtl so it will release on its
      // own even if the delete fails. Logging the error inside the worker
      // would just add noise.
    })
  }
}

function safeParseArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', { status: 200 })
    }
    if (url.pathname === '/agentcall/precall' && request.method === 'POST') {
      return handlePrecall(request, env)
    }
    if (url.pathname === '/agentcall/transcript' && request.method === 'POST') {
      return handleTranscript(request, env)
    }
    if (url.pathname === '/hermes/push' && request.method === 'POST') {
      return handleHermesPush(request, env)
    }
    if (url.pathname === '/hermes/pull-transcripts' && request.method === 'POST') {
      return handleHermesPullTranscripts(request, env)
    }
    return new Response('Not found', { status: 404 })
  },
}
