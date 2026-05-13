/**
 * hermes-bridge: a Cloudflare Worker that bridges AgentCall's pre-call context
 * webhook to Hermes (Percy's agent platform). Decouples the always-on bridge
 * from Hermes itself, which runs in a local Docker container.
 *
 * Endpoints:
 *  - POST /agentcall/precall  AgentCall calls this on inbound call connect.
 *                             Verifies HMAC signature, reads `current` from KV,
 *                             returns {contextBlock: ...}.
 *  - POST /hermes/push        Hermes calls this on cron to update the stored
 *                             context. Protected by X-Hermes-Push-Key header.
 *  - GET  /healthz            Liveness probe.
 */

export interface Env {
  HERMES_CONTEXT: KVNamespace
  AGENTCALL_SIGNING_SECRET: string
  HERMES_PUSH_KEY: string
}

const KV_KEY = 'current'
const MAX_CONTEXT_CHARS = 5000

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
    if (url.pathname === '/hermes/push' && request.method === 'POST') {
      return handleHermesPush(request, env)
    }
    return new Response('Not found', { status: 404 })
  },
}
