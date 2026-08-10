#!/usr/bin/env bash
#
# One command from a fresh clone to a deployed bridge.
#
#   ./bootstrap.sh                          # deploy to a workers.dev URL
#   ./bootstrap.sh --domain hermes.you.com  # deploy to your own subdomain
#   ./bootstrap.sh --dry-run                # print every command, run nothing
#   ./bootstrap.sh --install-consumer       # then install the consumer too
#
# What it removes from your setup list: creating the KV namespace, editing
# wrangler.jsonc, inventing and installing three secrets, deploying, finding
# the resulting URL, and copying that URL and those secrets into the consumer.
#
# It defaults to a **workers.dev** URL, which needs no domain and no DNS. That
# is a real HTTPS endpoint and AgentCall does not care what it is called. Pass
# --domain only if you specifically want the bridge on your own hostname; that
# requires the domain to already be on this Cloudflare account.
#
# Nothing here is destructive except overwriting wrangler.jsonc, which is
# backed up first.

set -euo pipefail

NAME="hermes-bridge"
DOMAIN=""
DRY_RUN=0
INSTALL_CONSUMER=0
ASSUME_YES=0
KV_ID=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

run() { # run <description> <command...>
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

usage() {
  cat <<'USAGE'
Bootstrap the AgentCall Hermes bridge on Cloudflare.

  --name NAME          Worker name (default: hermes-bridge)
  --domain HOST        deploy to your own hostname instead of workers.dev.
                       The zone must already be on this Cloudflare account.
  --install-consumer   after deploying, run consumer/install.sh with the
                       generated URL and secrets already filled in
  --number-id num_...  passed through to the consumer installer
  --allow +1555...     passed through to the consumer installer (repeatable)
  --dry-run            print every command without running any of them
  --yes                do not pause for confirmation

Requires: node, npx, and a wrangler login (run `npx wrangler login` first).
USAGE
  exit 0
}

NUMBER_ID=""
ALLOW=()
while [ $# -gt 0 ]; do
  case "$1" in
    --name)             NAME="${2:-}"; shift 2 ;;
    --domain)           DOMAIN="${2:-}"; shift 2 ;;
    --install-consumer) INSTALL_CONSUMER=1; shift ;;
    --number-id)        NUMBER_ID="${2:-}"; shift 2 ;;
    --allow)            ALLOW+=("${2:-}"); shift 2 ;;
    --dry-run)          DRY_RUN=1; shift ;;
    --yes|-y)           ASSUME_YES=1; shift ;;
    --help|-h)          usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

cd "$(dirname "$0")"

# --- prerequisites ----------------------------------------------------------

step "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org)"
say "  node       $(node --version)"

WRANGLER="npx wrangler"
if ! $WRANGLER --version >/dev/null 2>&1; then
  die "wrangler is not available. Run 'npm install' in this directory first."
fi
say "  wrangler   $($WRANGLER --version 2>/dev/null | tail -1)"

if [ "$DRY_RUN" -eq 0 ]; then
  WHOAMI="$($WRANGLER whoami 2>&1 || true)"
  case "$WHOAMI" in
    *"You are logged in"*) say "  cloudflare $(printf '%s' "$WHOAMI" | grep -o '[^ ]*@[^ .]*\.[^ .]*' | head -1)" ;;
    *) die "not logged in to Cloudflare. Run: npx wrangler login" ;;
  esac
fi

[ -f package.json ] || die "run this from the agentcall-hermes-bridge checkout"
if [ ! -d node_modules ]; then
  step "Installing dependencies"
  run npm install
fi

# --- confirm ----------------------------------------------------------------

TARGET_DESC="a workers.dev URL (no domain needed)"
[ -n "$DOMAIN" ] && TARGET_DESC="https://$DOMAIN"

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ]; then
  step "About to create real Cloudflare resources"
  say "  worker     $NAME"
  say "  endpoint   $TARGET_DESC"
  say "  KV         a namespace bound as HERMES_CONTEXT"
  say "  secrets    AGENTCALL_SIGNING_SECRET, AGENTCALL_SMS_SIGNING_SECRET, HERMES_PUSH_KEY"
  say ""
  read -r -p "  Continue? [y/N] " ok < /dev/tty
  case "$ok" in y|Y|yes|YES) ;; *) die "cancelled" ;; esac
fi

# --- KV namespace -----------------------------------------------------------

step "KV namespace"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  would run: %s kv namespace create HERMES_CONTEXT\n' "$WRANGLER"
  KV_ID="DRY_RUN_KV_ID"
else
  KV_OUT="$($WRANGLER kv namespace create HERMES_CONTEXT 2>&1 || true)"
  # wrangler has changed this output format repeatedly (toml block, jsonc
  # block, quoted vs bare). A 32-hex id is the stable part, so take that.
  KV_ID="$(printf '%s' "$KV_OUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  if [ -z "$KV_ID" ]; then
    say "$KV_OUT"
    die "could not find a namespace id in the wrangler output above. Create one
     manually with: npx wrangler kv namespace create HERMES_CONTEXT
     then re-run with the id pasted into wrangler.jsonc."
  fi
  say "  created    id $KV_ID"
fi

# --- wrangler.jsonc ---------------------------------------------------------

step "Writing wrangler.jsonc"
if [ -f wrangler.jsonc ] && [ "$DRY_RUN" -eq 0 ]; then
  cp wrangler.jsonc wrangler.jsonc.bak
  say "  backed up  wrangler.jsonc.bak"
fi

if [ -n "$DOMAIN" ]; then
  ROUTES=$(printf '  "routes": [\n    { "pattern": "%s/*", "custom_domain": true }\n  ],' "$DOMAIN")
  WORKERS_DEV='  "workers_dev": false,'
else
  ROUTES=""
  WORKERS_DEV='  "workers_dev": true,'
fi

WRANGLER_JSONC=$(cat <<EOF
{
  "\$schema": "node_modules/wrangler/config-schema.json",
  "name": "$NAME",
  "main": "src/index.ts",
  "compatibility_date": "2025-05-05",
  "compatibility_flags": ["nodejs_compat"],
$WORKERS_DEV
$ROUTES
  "kv_namespaces": [
    {
      "binding": "HERMES_CONTEXT",
      "id": "$KV_ID"
    }
  ]
}
EOF
)
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would write wrangler.jsonc:"
  printf '%s\n' "$WRANGLER_JSONC" | sed 's/^/    /'
else
  printf '%s\n' "$WRANGLER_JSONC" > wrangler.jsonc
  say "  wrote      wrangler.jsonc ($NAME -> ${DOMAIN:-workers.dev})"
fi

# --- secrets ----------------------------------------------------------------

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; fi
}

step "Secrets"
AGENTCALL_SIGNING_SECRET="$(gen_secret)"
AGENTCALL_SMS_SIGNING_SECRET="$(gen_secret)"
HERMES_PUSH_KEY="$(gen_secret)"

put_secret() { # put_secret NAME VALUE
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would run: printf ... | %s secret put %s\n' "$WRANGLER" "$1"
    return 0
  fi
  if printf '%s' "$2" | $WRANGLER secret put "$1" >/dev/null 2>&1; then
    say "  set        $1"
  else
    die "could not set $1. Run '$WRANGLER secret put $1' by hand and re-run."
  fi
}

# Separate secrets per channel on purpose: rotating or leaking the SMS relay
# secret then never touches the pre-call context channel.
put_secret AGENTCALL_SIGNING_SECRET "$AGENTCALL_SIGNING_SECRET"
put_secret AGENTCALL_SMS_SIGNING_SECRET "$AGENTCALL_SMS_SIGNING_SECRET"
put_secret HERMES_PUSH_KEY "$HERMES_PUSH_KEY"

# --- deploy -----------------------------------------------------------------

step "Deploying"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  would run: %s deploy\n' "$WRANGLER"
  BRIDGE_URL="https://$NAME.EXAMPLE.workers.dev"
  [ -n "$DOMAIN" ] && BRIDGE_URL="https://$DOMAIN"
else
  DEPLOY_OUT="$($WRANGLER deploy 2>&1 || true)"
  printf '%s\n' "$DEPLOY_OUT" | sed 's/^/  /' | tail -8
  if [ -n "$DOMAIN" ]; then
    BRIDGE_URL="https://$DOMAIN"
  else
    BRIDGE_URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
  fi
  [ -n "$BRIDGE_URL" ] || die "deployed, but could not find the URL in the output above.
     Find it with 'npx wrangler deployments list' and pass it to the consumer
     installer as --bridge-url."
fi

# --- verify -----------------------------------------------------------------

step "Verifying"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  would run: curl -fsS %s/healthz\n' "$BRIDGE_URL"
else
  # A fresh Worker route can take a few seconds to answer.
  HEALTH=""
  for _ in 1 2 3 4 5 6; do
    HEALTH="$(curl -fsS "$BRIDGE_URL/healthz" 2>/dev/null || true)"
    [ "$HEALTH" = "ok" ] && break
    sleep 5
  done
  [ "$HEALTH" = "ok" ] || die "deployed to $BRIDGE_URL but /healthz did not answer 'ok'.
     Check 'npx wrangler tail' and the Cloudflare dashboard."
  say "  $BRIDGE_URL/healthz -> ok"
fi

# --- hand off ---------------------------------------------------------------

step "Bridge is up"
say "  URL        $BRIDGE_URL"
say ""
say "  Keep these. Cloudflare will not show them to you again:"
say "    AGENTCALL_SIGNING_SECRET=$AGENTCALL_SIGNING_SECRET"
say "    AGENTCALL_SMS_SIGNING_SECRET=$AGENTCALL_SMS_SIGNING_SECRET"
say "    HERMES_PUSH_KEY=$HERMES_PUSH_KEY"

if [ "$INSTALL_CONSUMER" -eq 1 ]; then
  step "Installing the consumer"
  consumer_args=(--bridge-url "$BRIDGE_URL" --bridge-dir "$(pwd)"
                 --push-key "$HERMES_PUSH_KEY"
                 --sms-secret "$AGENTCALL_SMS_SIGNING_SECRET")
  [ -n "$NUMBER_ID" ] && consumer_args+=(--number-id "$NUMBER_ID")
  for a in "${ALLOW[@]:-}"; do [ -n "$a" ] && consumer_args+=(--allow "$a"); done
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would run: ./consumer/install.sh %s --api-key <prompted>\n' "${consumer_args[*]}"
  else
    ./consumer/install.sh "${consumer_args[@]}"
  fi
  exit $?
fi

say ""
say "  Next, install the consumer next to your agent:"
say "    ./consumer/install.sh \\"
say "      --bridge-url $BRIDGE_URL \\"
say "      --bridge-dir $(pwd) \\"
say "      --push-key   '$HERMES_PUSH_KEY' \\"
say "      --sms-secret '$AGENTCALL_SMS_SIGNING_SECRET' \\"
say "      --api-key    'ac_live_...' \\"
say "      --number-id  num_xxx \\"
say "      --allow      +1XXXXXXXXXX"
say ""
say "  (or re-run this with --install-consumer to chain them)"
