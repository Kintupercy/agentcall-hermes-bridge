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
 *  - POST /agentcall/sms          AgentCall calls this (relay / smsMode:'relay')
 *                                 on every inbound text to a relay-enabled
 *                                 number. Verifies HMAC, appends the relay
 *                                 envelope to a bounded per-agent SMS queue in
 *                                 KV. Mirrors /agentcall/transcript: AgentCall
 *                                 pushes, Hermes/Laura pulls and replies via
 *                                 AgentCall POST /v1/sms-conversations/:id/reply.
 *  - POST /hermes/pull-sms        Hermes/Laura polls this to CLAIM queued
 *                                 inbound relay texts (at-least-once): returned
 *                                 texts are hidden for SMS_VISIBILITY_MS, not
 *                                 deleted, so a canceled pull or crashed
 *                                 consumer never loses one. No soft-lock (claim
 *                                 is idempotent; the lock's 60s TTL caused stalls).
 *                                 X-Hermes-Push-Key protected.
 *  - POST /hermes/ack-sms         Consumer acks processed texts ({messageIds})
 *                                 so they're removed for good. The other half
 *                                 of at-least-once delivery. Idempotent.
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
  // Optional dedicated secret for the SMS relay webhook (/agentcall/sms). Lets
  // the relay use a different shared secret than precall/transcript so rotating
  // or compromising one channel never affects the other. Falls back to
  // AGENTCALL_SIGNING_SECRET when unset, so existing single-secret deployments
  // keep working unchanged.
  AGENTCALL_SMS_SIGNING_SECRET?: string
  HERMES_PUSH_KEY: string
}

const KV_KEY = 'current'
const TRANSCRIPT_QUEUE_PREFIX = 'transcript_queue:'
const SMS_QUEUE_PREFIX = 'sms_queue:'
const DEFAULT_TENANT = 'default'
const PULL_LOCK_KEY = 'transcript_queue_pull_lock'
// Cloudflare KV rejects any `expirationTtl` below 60 seconds and throws,
// which would crash the whole pull handler (Worker error 1101 / HTTP 500).
// 60 is the documented floor, so the lock cannot be shorter than this.
const PULL_LOCK_TTL_SECONDS = 60
const MAX_CONTEXT_CHARS = 5000
const MAX_QUEUED_TRANSCRIPTS_PER_TENANT = 100
// Inbound texts are tiny vs transcripts, and a burst of texts during a Laura
// outage shouldn't evict as readily, so allow a deeper FIFO. Still well under
// the 25MB KV value cap.
const MAX_QUEUED_SMS_PER_TENANT = 200
// At-least-once delivery: a pulled text is *claimed* (hidden) for this long
// rather than deleted. Only an explicit /hermes/ack-sms removes it. If the
// consumer crashes or a pull is canceled mid-flight, the claim expires and the
// text is redelivered instead of being silently lost. Must comfortably exceed
// the agent's worst-case think+reply time (the brain step). Dropped-text bugs
// in a customer-facing SMS agent are unacceptable, so we favor redelivery
// (duplicates are harmless: replies are idempotent on the message id).
// Measured: a memory-aware Hermes reply can take ~150s, so this must sit well
// above that or a slow brain gets the text redelivered and runs twice. 300s
// gives generous headroom; redelivery only kicks in on a genuine stall/crash.
const SMS_VISIBILITY_MS = 300000

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

/**
 * AgentCall relay push. Fired on every inbound text to a relay-enabled number
 * (smsMode:'relay'). The relay worker retries non-2xx up to 5 times, so this
 * dedups on the AgentCall message id and acks fast — it does NOT think or
 * reply. Laura's brain pulls via /hermes/pull-sms and replies through
 * AgentCall's POST /v1/sms-conversations/:id/reply, keeping the whole thread
 * (and STOP handling) inside AgentCall. Mirrors handleTranscript.
 *
 * Relay envelope shape (AgentCall sms.relay webhook):
 *   { message: {id,from,to,body,receivedAt},
 *     conversation: {id,contactPhone},
 *     context: {channel:'sms',numberId,agentId} }
 */
export async function handleAgentcallSms(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const signature = request.headers.get('X-AgentCall-Signature')
  const smsSecret = env.AGENTCALL_SMS_SIGNING_SECRET || env.AGENTCALL_SIGNING_SECRET
  const valid = await verifyHmacSignature(body, signature, smsSecret)
  if (!valid) {
    return jsonResponse({ error: 'invalid_signature' }, 401)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }

  const tenant = extractSmsTenant(parsed)
  const queueKey = `${SMS_QUEUE_PREFIX}${tenant}`

  const stored = await env.HERMES_CONTEXT.get(queueKey)
  const queue: unknown[] = stored ? safeParseArray(stored) : []
  // Dedup on the AgentCall message id so retry storms don't double-queue (and
  // Laura doesn't double-reply). 200 + status:'duplicate' stops the retry.
  const incomingId = extractMessageId(parsed)
  if (incomingId && queue.some((item) => extractMessageId(item) === incomingId)) {
    return jsonResponse({ status: 'duplicate', messageId: incomingId, queueDepth: queue.length, tenant })
  }
  queue.push(parsed)
  if (queue.length > MAX_QUEUED_SMS_PER_TENANT) {
    queue.splice(0, queue.length - MAX_QUEUED_SMS_PER_TENANT)
  }
  await env.HERMES_CONTEXT.put(queueKey, JSON.stringify(queue))
  return jsonResponse({ status: 'queued', queueDepth: queue.length, tenant })
}

/** Relay message id lives at `message.id`; tolerate a root `id` fallback. */
function extractMessageId(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null
  const e = envelope as { message?: { id?: unknown }; id?: unknown }
  if (e.message && typeof e.message === 'object' && typeof e.message.id === 'string') {
    return e.message.id
  }
  if (typeof e.id === 'string') return e.id
  return null
}

/**
 * Relay puts agentId/numberId under `context` (not root/`data` like the
 * transcript webhook), so read there first, then fall back to the generic
 * extractor. Percy's single-agent setup lands on its agentId; anything
 * unrecognized lands on 'default' and still works.
 */
function extractSmsTenant(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return DEFAULT_TENANT
  const e = envelope as { context?: { agentId?: unknown; numberId?: unknown } }
  const candidates = [e.context?.agentId, e.context?.numberId]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c.length <= 100) {
      return sanitizeTenantKey(c)
    }
  }
  return extractTenant(envelope)
}

/**
 * Claim queued inbound relay texts across all per-agent queues (at-least-once
 * delivery). Unlike the transcript pull, this does NOT delete on read: each
 * returned text is stamped with a claim time and hidden for SMS_VISIBILITY_MS.
 * Only /hermes/ack-sms removes it. So a canceled pull or a crashed/restarted
 * consumer never loses a text — the claim expires and it's redelivered. The
 * `_claimedAt` bookkeeping field is stripped before returning.
 *
 * NO soft-lock here (unlike the transcript pull). The claim model already makes
 * a double-pull harmless (both would re-claim the same already-claimed items,
 * and replies are idempotent on the message id), and the consumer is single.
 * The lock's 60s KV-TTL floor was actively harmful: if a pull was canceled
 * before releasing it, EVERY pull 409'd for up to 60s and the text sat
 * unprocessed — the exact ~55s SMS stall we measured. Dropping it makes pickup
 * bounded by the consumer's poll interval (~2s) instead of the lock TTL.
 * Reply to each via AgentCall POST /v1/sms-conversations/:id/reply, then ack.
 */
export async function handleHermesPullSms(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-Hermes-Push-Key')
  if (!key || !timingSafeEqualString(key, env.HERMES_PUSH_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  const now = Date.now()
  const list = await env.HERMES_CONTEXT.list({ prefix: SMS_QUEUE_PREFIX })
  const allMessages: unknown[] = []
  const tenantsDelivered: string[] = []

  for (const entry of list.keys) {
    const stored = await env.HERMES_CONTEXT.get(entry.name)
    if (!stored) continue
    const queue = safeParseArray(stored) as Array<Record<string, unknown>>
    if (queue.length === 0) continue

    let changed = false
    const delivered: unknown[] = []
    for (const item of queue) {
      const claimedAt = typeof item._claimedAt === 'number' ? item._claimedAt : null
      const visible = claimedAt === null || now - claimedAt > SMS_VISIBILITY_MS
      if (!visible) continue
      item._claimedAt = now // claim (hide) without deleting
      changed = true
      const { _claimedAt, ...clean } = item // strip bookkeeping before return
      void _claimedAt
      delivered.push(clean)
    }

    if (delivered.length > 0) {
      allMessages.push(...delivered)
      tenantsDelivered.push(entry.name.slice(SMS_QUEUE_PREFIX.length))
    }
    if (changed) await env.HERMES_CONTEXT.put(entry.name, JSON.stringify(queue))
  }

  return jsonResponse({ messages: allMessages, count: allMessages.length, tenantsDelivered })
}

/**
 * Acknowledge processed relay texts so they're removed for good. The consumer
 * calls this AFTER it has successfully replied (or decided to drop) each text.
 * Body: { messageIds: string[] }. Idempotent — acking an unknown/already-removed
 * id is a no-op. This is the other half of at-least-once delivery: claim on
 * pull, remove on ack. push-key auth.
 */
export async function handleHermesAckSms(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-Hermes-Push-Key')
  if (!key || !timingSafeEqualString(key, env.HERMES_PUSH_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
  const rawIds = (parsed as { messageIds?: unknown })?.messageIds
  const ids = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string') : []
  if (ids.length === 0) {
    return jsonResponse({ error: 'messageIds_required' }, 400)
  }
  const idSet = new Set(ids)

  const list = await env.HERMES_CONTEXT.list({ prefix: SMS_QUEUE_PREFIX })
  let removed = 0
  for (const entry of list.keys) {
    const stored = await env.HERMES_CONTEXT.get(entry.name)
    if (!stored) continue
    const queue = safeParseArray(stored)
    const kept = queue.filter((item) => {
      const id = extractMessageId(item)
      if (id && idSet.has(id)) {
        removed++
        return false
      }
      return true
    })
    if (kept.length !== queue.length) {
      await env.HERMES_CONTEXT.put(entry.name, JSON.stringify(kept))
    }
  }
  return jsonResponse({ status: 'ok', removed })
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
    if (url.pathname === '/agentcall/sms' && request.method === 'POST') {
      return handleAgentcallSms(request, env)
    }
    if (url.pathname === '/hermes/pull-sms' && request.method === 'POST') {
      return handleHermesPullSms(request, env)
    }
    if (url.pathname === '/hermes/ack-sms' && request.method === 'POST') {
      return handleHermesAckSms(request, env)
    }
    return new Response('Not found', { status: 404 })
  },
}
