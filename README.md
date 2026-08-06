# agentcall-hermes-bridge

A small Cloudflare Worker that closes the loop between AgentCall phone numbers and your AI agent. Pre-call: serves today's brief so the AI answers with fresh context. Post-call: queues the transcript so your agent can absorb what was decided on the call.

Drop-in template. Deploy on your own Cloudflare account, point your AgentCall number's `contextWebhook` at it, register a `call.transcript` webhook for the transcript queue, and have your agent (Hermes, or any agent platform you run) push briefs in and pull transcripts out on a schedule.

Walkthroughs with screenshots and Telegram-prompt examples:

- Pre-call context: **https://agentcall.co/docs/hermes**
- Post-call transcripts: **https://agentcall.co/docs/post-call-webhook**

## What it does

Ten endpoints, one always-on Cloudflare KV store:

### Pre-call (brief in)
- `POST /hermes/push` — your agent platform hits this whenever a new brief is ready. Auth via `X-Hermes-Push-Key` header. Stores the brief in KV (latest wins, 5000-char cap).
- `POST /agentcall/precall` — AgentCall hits this on every inbound call. Verifies an HMAC signature, reads the latest brief from KV, returns `{contextBlock}` so AgentCall can merge it onto the system prompt before the AI answers.

### Post-call (transcript out)
- `POST /agentcall/transcript` — AgentCall hits this after every inbound AI call ends with the full transcript and an LLM-extracted summary. Verifies an HMAC signature, appends to a bounded FIFO queue in KV (max 100, oldest dropped if your agent stops pulling).
- `POST /hermes/pull-transcripts` — your agent platform polls this to drain the queue. Same `X-Hermes-Push-Key` header auth. Returns all queued entries and atomically clears them so the next pull is empty until new transcripts arrive.

### Two-way SMS relay (text in, reply out)
- `POST /agentcall/sms` — with a number in `smsMode: "relay"`, AgentCall hits this on every inbound text. Verifies an HMAC signature (against `AGENTCALL_SMS_SIGNING_SECRET`, falling back to `AGENTCALL_SIGNING_SECRET`), dedups on message id, and appends the relay envelope to a bounded per-agent FIFO queue in KV (max 200). Lets your own agent — not AgentCall's managed AI — answer texts.
- `POST /hermes/pull-sms` — your agent platform polls this to **claim** inbound texts (at-least-once delivery). Same `X-Hermes-Push-Key` auth. Unlike the transcript pull, it does **not** delete on read: each returned text is hidden for a visibility window (default 120s) instead, so a canceled pull or a crashed/restarted consumer never loses a text. For each entry, reply via AgentCall `POST /v1/sms-conversations/:id/reply`, then ack it.
- `POST /hermes/ack-sms` — after you've replied to (or decided to drop) a text, ack it so it's removed for good. Body `{ "messageIds": ["..."] }`. Idempotent. If you never ack (crash/error), the claim expires and the text is redelivered on the next pull. Replies are idempotent on the message id, so redelivery can't double-text.

### Action bridge (the agent's hands)
- `POST /agentcall/action` — with tools + an `actionWebhook` declared on a number, AgentCall hits this when the AI agent invokes a tool mid-conversation (SMS or voice). Verifies an HMAC signature (against `AGENTCALL_ACTION_SIGNING_SECRET`, falling back to `AGENTCALL_SIGNING_SECRET`) and dispatches synchronously — the response `{"result": "..."}` is fed straight back to the LLM, so everything here must answer inside the tool timeout (max 8s). Two KV-backed tools ship with the template: `get_latest_brief` (returns the same brief `/agentcall/precall` serves, letting the agent refresh context mid-thread) and `save_note` (appends the note to a bounded per-agent FIFO queue, max 200, for your platform to pull). Unknown tools return an explanatory result string the LLM can relay instead of a bare error.
- `POST /hermes/pull-notes` — your agent platform polls this to read saved notes. Same `X-Hermes-Push-Key` auth. Does **not** delete on read: notes are returned on every poll until acked, so a crashed consumer never loses one. Dedup on note `id` if you see repeats.
- `POST /hermes/ack-notes` — after processing, ack with `{ "noteIds": ["..."] }` to remove notes for good. Idempotent.

### Health
- `GET /healthz` — liveness probe.

## Why a bridge?

Most self-hosted agent platforms (Hermes, n8n, custom Python jobs, etc.) run locally or on a VPS without a public HTTPS endpoint. AgentCall needs an always-on URL it can hit on every inbound call. The bridge decouples the two: your agent pushes when it has new context, the bridge serves whenever AgentCall asks.

## Quick start

```bash
git clone https://github.com/Kintupercy/agentcall-hermes-bridge.git
cd agentcall-hermes-bridge
npm install

# 1. Create a KV namespace, copy the ID into wrangler.jsonc
npx wrangler kv namespace create HERMES_CONTEXT

# 2. Edit wrangler.jsonc: replace
#    "hermes.YOUR-DOMAIN.com/*" with your real subdomain
#    "REPLACE_AFTER_WRANGLER_KV_NAMESPACE_CREATE" with the namespace ID from step 1

# 3. Set the two secrets the Worker needs
npx wrangler secret put AGENTCALL_SIGNING_SECRET
# paste a 32-byte hex string. Generate one with: openssl rand -hex 32
# Save this secret; you'll also set it on your AgentCall number's contextWebhook.signingSecret.

npx wrangler secret put HERMES_PUSH_KEY
# paste a different random secret. Save it; your agent platform uses this to authenticate pushes.

# 4. Deploy
npx wrangler deploy

# 5. Add a CNAME for your custom domain in Cloudflare DNS pointing at the Worker
```

## Verify the deploy

```bash
# Liveness
curl https://hermes.your-domain.com/healthz
# expect: ok

# Test push (replace with your real HERMES_PUSH_KEY)
curl -X POST https://hermes.your-domain.com/hermes/push \
  -H "X-Hermes-Push-Key: hpk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"contextBlock":"Test context. The phrase to confirm is Charlie Foxtrot Alpha 7."}'
# expect: {"status":"ok","storedLength":...}
```

## Wire it to AgentCall

In the AgentCall dashboard (or via the `configure_inbound_ai` MCP tool from your agent), set `contextWebhook` on your phone number:

```json
{
  "url": "https://hermes.your-domain.com/agentcall/precall",
  "signingSecret": "<the AGENTCALL_SIGNING_SECRET you set above>",
  "timeoutMs": 1200
}
```

Then call the number. The AI should answer with the test context loaded. Full walkthrough at [agentcall.co/docs/hermes](https://agentcall.co/docs/hermes).

## Auth model

- **`/agentcall/precall`** uses HMAC-SHA256 signing. AgentCall signs every request with your `AGENTCALL_SIGNING_SECRET`. The Worker rejects requests with a missing or mismatching `X-AgentCall-Signature` header. Constant-time comparison.
- **`/hermes/push`** uses a shared secret header (`X-Hermes-Push-Key`). Simpler than HMAC because you control both sides.

Neither secret is in the code or config. Both are Cloudflare Worker secrets set via `wrangler secret put`.

## Drain transcripts on your agent side

Once you've wired the post-call webhook on AgentCall (`call.transcript` event pointed at `https://hermes.your-domain.com/agentcall/transcript`), have your local agent platform pull the queue on a schedule:

```bash
# Cron or background loop on your agent's host
curl -X POST https://hermes.your-domain.com/hermes/pull-transcripts \
  -H "X-Hermes-Push-Key: hpk_xxx" \
  | jq '.transcripts[]'
```

Each entry in `transcripts` is the full `call.transcript` payload AgentCall fires (callId, duration, transcript array, summary). The pull is read-and-clear, so persist locally before processing or you'll lose entries on the next pull.

Cadence is up to you. Every minute is fine for low call volume; every 10 seconds if you want near-real-time follow-up. The bridge holds up to 100 transcripts between pulls, so polling every 5 minutes also works.

### Heads up for Python-based brains

Cloudflare blocks Python's default `urllib` User-Agent on this bridge with HTTP 403 (Error 1010, `browser_signature_banned`). The `/hermes/pull-transcripts` route will silently 403 every poll, your queue accumulates, and your loop may still log success on whatever wrapper you're using.

Two ways to fix it:

```python
# Option 1: shell out to curl
import subprocess, json
result = subprocess.run(
    ["curl", "-s", "-X", "POST",
     "https://hermes.your-domain.com/hermes/pull-transcripts",
     "-H", "X-Hermes-Push-Key: hpk_xxx"],
    capture_output=True, text=True, check=True,
)
transcripts = json.loads(result.stdout)["transcripts"]
```

```python
# Option 2: override the urllib User-Agent
import urllib.request, json
req = urllib.request.Request(
    "https://hermes.your-domain.com/hermes/pull-transcripts",
    method="POST",
    headers={
        "X-Hermes-Push-Key": "hpk_xxx",
        "User-Agent": "curl/8.0",
    },
)
with urllib.request.urlopen(req) as resp:
    transcripts = json.loads(resp.read())["transcripts"]
```

Node, Go, Rust, `requests`, `httpx`, and curl-based clients send their own User-Agent and are unaffected. Only Python's stdlib default (`Python-urllib/3.x`) trips the rule.

## Tests

```bash
npm test
```

80 unit tests cover HMAC verification, all ten endpoints, end-to-end push/pull loops for pre-call, post-call, SMS relay (push → claim → ack), and the action bridge (tool dispatch, notes queue pull → ack), and failure modes (missing signature, bad key, malformed JSON, queue overflow, oversize body, dedicated-secret isolation, per-tenant queueing, message-id dedup, claim visibility + redelivery after expiry, idempotent ack, unknown-tool handling, empty-note no-op, notes-queue eviction).

## License

MIT. Use it, modify it, ship your own bridge variant. See `LICENSE`.

## Links

- AgentCall: https://agentcall.co
- Hermes Agent (Nous Research): https://hermes-agent.nousresearch.com
- Integration walkthrough: https://agentcall.co/docs/hermes
