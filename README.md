# agentcall-hermes-bridge

**Text your own AI agent on a real phone number.** You send a text, your agent
answers, in the same thread, with its own memory and tools. Not a hosted
persona reading a prompt.

> **Developer beta (`v0.4.0-beta.1`).** The full chain runs in production for
> one agent, and every piece here is covered by tests and a live teardown test.
> It has not yet been installed from scratch by someone who did not write it.
> Expect to read the security section rather than skim it.

Two pieces:

```
your phone
   │  text
   ▼
AgentCall ──────────────► src/          the Cloudflare Worker (always-on, public)
 carrier, threading,      │             queues the text, HMAC-verified
 STOP, billing            ▼
                     consumer/          runs next to your agent (systemd/Docker)
                          │             claims it, asks your agent, replies, acks
                          ▼
                     your agent         Hermes, or anything you can shell out to
```

The Worker exists because your agent probably has no public HTTPS endpoint and
AgentCall needs one that is always up. The consumer exists because the Worker
is a queue, not a brain.

## Quickstart

```bash
git clone https://github.com/Kintupercy/agentcall-hermes-bridge.git
cd agentcall-hermes-bridge
npm install
npx wrangler login

./bootstrap.sh --install-consumer \
  --number-id num_xxx \
  --allow +15551234567
```

That creates the KV namespace, generates and installs three secrets, deploys
the Worker, waits for `/healthz`, installs the consumer as a service next to
your agent, puts your number into relay mode, and runs a signed self-test. It
**refuses to print READY** unless the self-test passes.

Add `--verify-live +15551234567` to also wait for a real text before saying
READY. Add `--dry-run` to read every command before anything is created.

Defaults to a **workers.dev** URL, so you need no domain and no DNS. Pass
`--domain hermes.you.com` if you want your own hostname.

## What you need

| | |
| --- | --- |
| An AgentCall number on **Pro** | relay is processed on Pro; on Free the text arrives and is dropped |
| A Cloudflare account | free tier is fine. `npx wrangler login` |
| An agent to answer | Hermes is autodetected; anything with a CLI or HTTP endpoint works |
| Linux/systemd or Docker | to keep the consumer alive |

## Read this before connecting a powerful agent

**You are giving a phone number the ability to type into your agent.** Whatever
that agent can do, a text message can now attempt: shell commands, spending
money, reading your files, if those are on the table. There is no sandbox
between the message and the agent. That is the feature.

- The sender allowlist is a **speed bump, not a wall.** Caller ID is a claim,
  not a credential, and numbers get ported, recycled, and SIM-swapped.
- The official Hermes adapter defaults to a **`sms-safe` profile**: Hermes is
  restricted on the command line to `web,session_search`. Shell, files, code
  execution, messaging, cron, and **writable memory** are unreachable from a
  text. Exposing the full agent takes two deliberate switches.
- **Prompt injection over SMS costs a stranger less than a cent per attempt.**
  Treat the message body the way you would treat a public web form.

Full threat model: [consumer/README.md](consumer/README.md#threat-model).

## The one secret that has to match in two places

`AGENTCALL_SMS_SIGNING_SECRET` lives in your Worker **and** on your AgentCall
number. If they differ, **the text silently disappears**: AgentCall accepts it,
signs with its copy, the Worker rejects the signature, and nothing errors
anywhere you would look.

You cannot check this by reading the number, because AgentCall redacts the
stored secret to `hasSigningSecret: true` — which proves *a* secret exists and
nothing about *which* one. `bootstrap.sh` writes both sides from one value, and
`preflight` proves it cryptographically. Details:
[consumer/README.md](consumer/README.md#the-one-secret-that-has-to-match-in-two-places).

## Endpoints

Eleven, one always-on KV store.

**Two-way SMS relay** (text in, reply out)
- `POST /agentcall/sms` — AgentCall pushes each inbound text here, HMAC-signed. Dedups on message id, appends to a bounded per-agent queue.
- `POST /hermes/pull-sms` — your consumer **claims** texts (at-least-once). Hidden for 300s, not deleted, so a crash never loses one.
- `POST /hermes/ack-sms` — removes a text for good once you have answered it.

**Pre-call context** (brief in)
- `POST /hermes/push` — your agent stores today's brief.
- `POST /agentcall/precall` — AgentCall fetches it on every inbound call and merges it onto the system prompt.

**Post-call transcripts** (out)
- `POST /agentcall/transcript` — AgentCall posts the transcript plus an LLM summary after each call.
- `POST /hermes/pull-transcripts` — your agent drains the queue.

**Action bridge** (the agent's hands)
- `POST /agentcall/action` — tool calls mid-conversation, answered synchronously. Ships `get_latest_brief` and `save_note`.
- `POST /hermes/pull-notes` / `POST /hermes/ack-notes` — drain saved notes.

**Health**
- `GET /healthz`

## Auth model

- **AgentCall → bridge** (`/agentcall/*`) is HMAC-SHA256 over the raw body, constant-time compared. Separate secrets per channel, so rotating the SMS secret never touches pre-call context.
- **Your agent → bridge** (`/hermes/*`) is a shared `X-Hermes-Push-Key` header, also constant-time.

No secret is in the code or config. All are Cloudflare Worker secrets.

⚠️ **One push key drains every tenant.** `pull-sms` reads across all per-agent
queues. Correct for the single-owner shape this is built for, disqualifying for
a multi-tenant hosted service. Per-tenant keys would need to land first.

## Doing it by prompt

`skill/SKILL.md` is the whole procedure written for an agent to follow. Drop it
in your agent's skill directory and say:

> Connect this AgentCall number to you for two-way SMS.

## If it does not work

In order, because most reports are one of the first three:

1. Account is on Free. Relay is processed on Pro.
2. Number is not actually in relay mode. `configure-number --dry-run`.
3. Your phone is not on the allowlist.
4. `preflight` fails on the push key: the Worker and consumer disagree.
5. `selftest` push returns 401: the signing secrets differ. Most common on a
   **migrated** number, whose stored secret predates the current Worker.
6. Text arrives, no reply: your agent. `journalctl -u agentcall-sms-consumer -f`
   and look for `brain_error`.

Nothing is lost while you debug. The consumer never acks a text it did not
finish, so anything you fix is retried when the 300s claim expires.

## Tests

```bash
npm test              # the Worker: 80 tests
npm run test:consumer # the consumer + Hermes adapter: 109 tests
```

`bootstrap.sh` has also been run live end to end against a real Cloudflare
account: create, deploy, verify, roll back, and confirm the Worker and KV
namespace are gone.

## Known gaps

- **No-systemd persistence.** On a box without systemd the installer warns and
  prints the command, but cannot keep the consumer alive for you. Docker works.
- **Hosted bridge.** Not offered; see the push-key note above.
- **Full-chain install from scratch** has been proven on the Cloudflare half
  and in production for one agent, but not yet by a fresh developer end to end.

<details>
<summary><b>Manual setup, without bootstrap.sh</b></summary>

```bash
npm install
npx wrangler kv namespace create HERMES_CONTEXT
# put the returned id into wrangler.jsonc, and set your subdomain.
# NOTE: a Custom Domain takes a BARE hostname ("hermes.you.com"), not "/*".

openssl rand -hex 32   # -> AGENTCALL_SIGNING_SECRET
openssl rand -hex 32   # -> AGENTCALL_SMS_SIGNING_SECRET
openssl rand -hex 32   # -> HERMES_PUSH_KEY
npx wrangler secret put AGENTCALL_SIGNING_SECRET
npx wrangler secret put AGENTCALL_SMS_SIGNING_SECRET
npx wrangler secret put HERMES_PUSH_KEY

npx wrangler deploy
curl https://your-bridge/healthz     # expect: ok
```

Then wire the number, either with `configure-number` or by setting
`contextWebhook` / `agentWebhook` on it directly. See
[agentcall.co/docs/agent-sms](https://agentcall.co/docs/agent-sms).

</details>

<details>
<summary><b>Draining transcripts on your agent side</b></summary>

```bash
curl -X POST https://your-bridge/hermes/pull-transcripts \
  -H "X-Hermes-Push-Key: $HERMES_PUSH_KEY" | jq '.transcripts[]'
```

Read-and-clear, so persist locally before processing. The bridge holds 100
transcripts between pulls.

**Python callers:** Cloudflare answers Python's stdlib User-Agent with 403
(Error 1010) on this bridge, and the failure is silent — every poll 403s while
your queue grows. Send your own User-Agent, or shell out to curl. Node, Go,
Rust, `requests`, and `httpx` are unaffected.

</details>

## License

MIT. See `LICENSE`.

## Links

- AgentCall: https://agentcall.co
- Relay docs: https://agentcall.co/docs/agent-sms
- Pre-call context walkthrough: https://agentcall.co/docs/hermes
- Post-call transcripts: https://agentcall.co/docs/post-call-webhook
