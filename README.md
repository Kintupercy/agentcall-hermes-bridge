# agentcall-hermes-bridge

A small Cloudflare Worker that lets you call your AI agent on the phone and have it speak with today's context loaded.

Drop-in template. Deploy on your own Cloudflare account, point your AgentCall number's `contextWebhook` at it, and have your agent (Hermes, or any agent platform you run) push briefs to it on a schedule.

Walkthrough with screenshots and Telegram-prompt examples: **https://agentcall.co/docs/hermes**

## What it does

Two endpoints, one always-on Cloudflare KV store:

- `POST /agentcall/precall` — AgentCall hits this on every inbound call. Verifies an HMAC signature, reads the latest brief from KV, returns `{contextBlock}` so AgentCall can merge it onto the system prompt before the AI answers.
- `POST /hermes/push` — your agent platform hits this whenever a new brief is ready. Auth via `X-Hermes-Push-Key` header. Stores the brief in KV (latest wins, 5000-char cap).
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

## Tests

```bash
npm test
```

21 unit tests cover HMAC verification, both endpoints, end-to-end push → fetch, and failure modes (missing signature, bad key, malformed JSON, oversize body).

## License

MIT. Use it, modify it, ship your own bridge variant. See `LICENSE`.

## Links

- AgentCall: https://agentcall.co
- Hermes Agent (Nous Research): https://hermes-agent.nousresearch.com
- Integration walkthrough: https://agentcall.co/docs/hermes
