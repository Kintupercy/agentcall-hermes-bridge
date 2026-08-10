# agentcall-hermes-bridge

Two pieces that close the loop between AgentCall phone numbers and your AI agent:

- **`src/`** — a small Cloudflare Worker. The always-on public endpoint AgentCall can hit: serves today's brief on inbound calls, queues transcripts after them, queues inbound texts for the relay.
- **`consumer/`** — a standard-library Python service that runs next to your agent, drains the SMS queue, asks your agent what to say, and sends the reply in-thread. One command to install, systemd or Docker to keep it up. See **[consumer/README.md](consumer/README.md)**.

Deploy the Worker on your own Cloudflare account, point your AgentCall number at it, install the consumer beside your agent, and texting the number reaches **your** agent — memory, tools, and all.

Walkthroughs with screenshots and Telegram-prompt examples:

- Pre-call context: **https://agentcall.co/docs/hermes**
- Post-call transcripts: **https://agentcall.co/docs/post-call-webhook**
- Two-way SMS: **https://agentcall.co/docs/agent-sms**

## What it does

Eleven endpoints, one always-on Cloudflare KV store:

### Pre-call (brief in)
- `POST /hermes/push` — your agent platform hits this whenever a new brief is ready. Auth via `X-Hermes-Push-Key` header. Stores the brief in KV (latest wins, 5000-char cap).
- `POST /agentcall/precall` — AgentCall hits this on every inbound call. Verifies an HMAC signature, reads the latest brief from KV, returns `{contextBlock}` so AgentCall can merge it onto the system prompt before the AI answers.

### Post-call (transcript out)
- `POST /agentcall/transcript` — AgentCall hits this after every inbound AI call ends with the full transcript and an LLM-extracted summary. Verifies an HMAC signature, appends to a bounded FIFO queue in KV (max 100, oldest dropped if your agent stops pulling).
- `POST /hermes/pull-transcripts` — your agent platform polls this to drain the queue. Same `X-Hermes-Push-Key` header auth. Returns all queued entries and atomically clears them so the next pull is empty until new transcripts arrive.

### Two-way SMS relay (text in, reply out)
- `POST /agentcall/sms` — with a number in `smsMode: "relay"`, AgentCall hits this on every inbound text. Verifies an HMAC signature (against `AGENTCALL_SMS_SIGNING_SECRET`, falling back to `AGENTCALL_SIGNING_SECRET`), dedups on message id, and appends the relay envelope to a bounded per-agent FIFO queue in KV (max 200). Lets your own agent — not AgentCall's managed AI — answer texts.
- `POST /hermes/pull-sms` — your agent platform polls this to **claim** inbound texts (at-least-once delivery). Same `X-Hermes-Push-Key` auth. Unlike the transcript pull, it does **not** delete on read: each returned text is hidden for a visibility window (300s) instead, so a canceled pull or a crashed/restarted consumer never loses a text. For each entry, reply via AgentCall `POST /v1/sms-conversations/:id/reply`, then ack it. `consumer/` implements this half for you.
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

## Connect my number to Hermes (two-way SMS)

The end state: you text a number, **your** agent answers, in thread, with its
memory and tools. Not a hosted persona reading a prompt.

First, make sure that is what you want. There are two SMS products and picking
the wrong one wastes an hour:

| You want | Set | Bridge + consumer? |
| --- | --- | --- |
| An assistant that answers texts from a prompt you write | `smsMode: "ai"` with `smsSystemPrompt` | No. AgentCall runs the whole thing. |
| Texts to reach **your** agent, with its memory and actions | `smsMode: "relay"` | Yes. This is what follows. |

Relay is processed on the Pro plan. On Free the text arrives and is dropped.

> **Read this before you wire it to a powerful agent.**
>
> You are giving a phone number the ability to type into your agent. Whatever
> that agent can do, a text message can now attempt — including shell commands,
> spending money, and reading your files, if those are on the table. There is no
> sandbox between the message and the agent; that is the feature.
>
> The sender allowlist is a speed bump, not a wall: caller ID is a claim, not a
> credential. If your agent can execute code or take irreversible actions, put a
> narrower agent on the SMS channel instead of your full one.
>
> Full threat model: [consumer/README.md](consumer/README.md#threat-model).

### 1. Deploy the bridge

The [Quick start](#quick-start) above. The SMS endpoints are already in the
Worker, so if you already run this bridge for pre-call context, skip ahead.

Keep both secrets: `AGENTCALL_SIGNING_SECRET` (AgentCall signs with it) and
`HERMES_PUSH_KEY` (the consumer authenticates with it). Neither is recoverable
after `wrangler secret put`.

### 2. Write the brain

Copy `consumer/brains/hermes_brain.sh.example` to `hermes_brain.sh` and replace
the one marked block with however you invoke your agent. It reads the text on
stdin as JSON and prints the reply on stdout. Exit `64` to deliberately say
nothing; any non-zero exit means the text is redelivered and retried.

`consumer/brains/echo_brain.sh` replies `Echo: <your text>` if you want to prove
the plumbing before your agent is wired in.

### 3. Install the consumer

```bash
./consumer/install.sh \
  --bridge-url https://hermes.your-domain.com \
  --push-key   "$HERMES_PUSH_KEY" \
  --api-key    "$AGENTCALL_API_KEY" \
  --sms-secret "$AGENTCALL_SIGNING_SECRET" \
  --allow      +15551234567 \
  --brain      /opt/agentcall-sms-consumer/brains/hermes_brain.sh
```

Installs the service, writes a 0600 secrets file, enables systemd, and runs
preflight. Run it with no arguments to be prompted instead, or use
`consumer/docker-compose.yml`.

`--allow` is the difference between a personal agent and a public one. Without
it, anyone who texts the number reaches your agent.

### 4. Put the number into relay mode

```bash
C="python3 /opt/agentcall-sms-consumer/agentcall_sms_consumer.py --config /opt/agentcall-sms-consumer/config.json"

$C configure-number \
  --number-id num_xxx \
  --bridge-url https://hermes.your-domain.com \
  --signing-secret "$AGENTCALL_SIGNING_SECRET" \
  --allow +15551234567
```

Read-modify-write against `POST /v1/numbers/:id/inbound-config`, which replaces
the whole config — it merges onto the current one so your voice setup survives.
`--dry-run` prints what it would save.

### 5. Verify

```bash
$C preflight    # config, bridge, push key, API key, brain. Sends nothing.
$C selftest     # signs a synthetic text and pushes it through the real loop.
                # No SMS is sent, no real thread is touched.
$C verify --number +1XXXXXXXXXX
                # the real one. Text the number; this watches it arrive, get
                # answered, and reports the latency.
```

`selftest` covers every hop except the carrier. Only `verify` proves the whole
thing, so run it last and check your phone for the reply.

### Doing it by prompt

`skill/SKILL.md` is the same procedure written for an agent to follow, with the
decision table, the failure-mode table, and the traps. Drop it in your agent's
skill directory and ask:

> Connect this AgentCall number to you for two-way SMS.

### If it does not work

In order, because most reports are one of the first three:

1. Account on Free — relay is processed on Pro.
2. Number not in relay mode — step 4.
3. Sender not on the allowlist — add it, or `--allow-anyone`.
4. `preflight` failing on the push key — the Worker and the consumer disagree.
5. Text arrives, no reply — the brain. `journalctl -u agentcall-sms-consumer -f`
   and look for `brain_error`.

Nothing is lost while you debug: the consumer never acks a text it did not
finish, so anything you fix is retried when the 300s claim expires.

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
npm test              # the Worker
npm run test:consumer  # the consumer (python3, no dependencies)
```

80 unit tests cover the Worker: HMAC verification, all eleven endpoints, end-to-end push/pull loops for pre-call, post-call, SMS relay (push → claim → ack), and the action bridge (tool dispatch, notes queue pull → ack), and failure modes (missing signature, bad key, malformed JSON, queue overflow, oversize body, dedicated-secret isolation, per-tenant queueing, message-id dedup, claim visibility + redelivery after expiry, idempotent ack, unknown-tool handling, empty-note no-op, notes-queue eviction).

71 more cover the consumer, most of them on the ack decision — the one that loses a text if it acks too early and double-texts a human if it acks too late. See [consumer/README.md](consumer/README.md#tests).

## License

MIT. Use it, modify it, ship your own bridge variant. See `LICENSE`.

## Links

- AgentCall: https://agentcall.co
- Hermes Agent (Nous Research): https://hermes-agent.nousresearch.com
- Integration walkthrough: https://agentcall.co/docs/hermes
