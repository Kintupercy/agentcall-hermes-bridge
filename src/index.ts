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
 *  - POST /hermes/push            Hermes calls this on cron to update the
 *                                 stored pre-call context. Protected by
 *                                 X-Hermes-Push-Key header.
 *  - POST /hermes/pull-transcripts Hermes polls this to drain queued post-call
 *                                 transcripts. Returns all stored entries and
 *                                 clears the queue atomically per request.
 *                                 Protected by X-Hermes-Push-Key header.
 *  - GET  /healthz                Liveness probe.
 */

export interface Env {
  HERMES_CONTEXT: KVNamespace
  AGENTCALL_SIGNING_SECRET: string
  HERMES_PUSH_KEY: string
}

const KV_KEY = 'current'
const TRANSCRIPT_QUEUE_KEY = 'transcript_queue'
const MAX_CONTEXT_CHARS = 5000
const MAX_QUEUED_TRANSCRIPTS = 100

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
  if (expected.length !== provided.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
  }
  return diff === 0
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
  if (!key || key !== env.HERMES_PUSH_KEY) {
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
  const stored = await env.HERMES_CONTEXT.get(TRANSCRIPT_QUEUE_KEY)
  const queue: unknown[] = stored ? safeParseArray(stored) : []
  queue.push(parsed)
  // Bounded FIFO: drop oldest if Hermes hasn't pulled in a while. Prevents the
  // KV value from growing without bound during a Hermes outage. Cloudflare KV
  // values cap at 25MB; this keeps us well under it.
  if (queue.length > MAX_QUEUED_TRANSCRIPTS) {
    queue.splice(0, queue.length - MAX_QUEUED_TRANSCRIPTS)
  }
  await env.HERMES_CONTEXT.put(TRANSCRIPT_QUEUE_KEY, JSON.stringify(queue))
  return jsonResponse({ status: 'queued', queueDepth: queue.length })
}

export async function handleHermesPullTranscripts(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-Hermes-Push-Key')
  if (!key || key !== env.HERMES_PUSH_KEY) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  const stored = await env.HERMES_CONTEXT.get(TRANSCRIPT_QUEUE_KEY)
  const queue: unknown[] = stored ? safeParseArray(stored) : []
  if (queue.length > 0) {
    await env.HERMES_CONTEXT.put(TRANSCRIPT_QUEUE_KEY, '[]')
  }
  return jsonResponse({ transcripts: queue, count: queue.length })
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
