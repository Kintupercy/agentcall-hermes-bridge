#!/usr/bin/env bash
#
# One command from a fresh clone to a deployed bridge.
#
#   ./bootstrap.sh                          # deploy to a workers.dev URL
#   ./bootstrap.sh --domain hermes.you.com  # deploy to your own subdomain
#   ./bootstrap.sh --dry-run                # print every command, run nothing
#   ./bootstrap.sh --install-consumer --number-id num_x --allow +1555...
#
# What it removes from your setup list: creating the KV namespace, writing
# wrangler config, inventing and installing three secrets, deploying, finding
# the resulting URL, and copying that URL and those secrets into the consumer.
#
# It defaults to a **workers.dev** URL, which needs no domain and no DNS. That
# is a real HTTPS endpoint and AgentCall does not care what it is called. Pass
# --domain only if you want the bridge on your own hostname; that zone must
# already be on this Cloudflare account.
#
# EVERY run keeps its own state under .bootstrap/<account-id>/<worker-name>/,
# so running this repeatedly (several clients, one checkout) never overwrites
# an earlier run's recovery secrets, rollback commands, or config. The
# generated config is passed to wrangler with --config; the repo's own
# wrangler.jsonc is left alone.

set -euo pipefail

NAME="hermes-bridge"
DOMAIN=""
DRY_RUN=0
INSTALL_CONSUMER=0
ASSUME_YES=0
SHOW_SECRETS=0
ALLOW_ANYONE=0
FORCE_REPLACE=0
NUMBER_ID=""
ALLOW=()
KV_ID=""
ROLLBACK_STEPS=()   # creation order; emitted reversed so teardown is safe

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Bootstrap the AgentCall Hermes bridge on Cloudflare.

  --name NAME          Worker name (default: hermes-bridge)
  --domain HOST        deploy to your own hostname instead of workers.dev.
                       The zone must already be on this Cloudflare account.
  --install-consumer   after deploying, run consumer/install.sh with the
                       generated URL and secrets already filled in
  --number-id num_...  REQUIRED with --install-consumer: the number to put in
                       relay mode
  --allow +1555...     REQUIRED with --install-consumer: a sender allowed to
                       reach your agent (repeatable)
  --allow-anyone       instead of --allow: let ANYONE who texts the number
                       reach your agent. Read the warning it prints.
  --force-replace      deploy over an EXISTING Worker of this name. This
                       REPLACES its secrets and is NOT undoable: Cloudflare
                       never discloses the old values. Refused by default.
  --show-secrets       also print the generated secrets to stdout. Off by
                       default: they go to a 0600 file instead.
  --dry-run            print every command without running any of them
  --yes                do not pause for confirmation

State per run:  .bootstrap/<account-id>/<worker-name>/
                  secrets.env     0600, the values Cloudflare will not show again
                  rollback.sh     deletes what this run created, in safe order
                  wrangler.jsonc  the config this run deployed with

Requires: node, npx, and a wrangler login (run `npx wrangler login` first).
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name)             NAME="${2:-}"; shift 2 ;;
    --domain)           DOMAIN="${2:-}"; shift 2 ;;
    --install-consumer) INSTALL_CONSUMER=1; shift ;;
    --number-id)        NUMBER_ID="${2:-}"; shift 2 ;;
    --allow)            ALLOW+=("${2:-}"); shift 2 ;;
    --allow-anyone)     ALLOW_ANYONE=1; shift ;;
    --show-secrets)     SHOW_SECRETS=1; shift ;;
    --force-replace)    FORCE_REPLACE=1; shift ;;
    --reuse)            FORCE_REPLACE=1
                        warn "--reuse is now --force-replace (it replaces secrets and cannot be undone)"
                        shift ;;
    --dry-run)          DRY_RUN=1; shift ;;
    --yes|-y)           ASSUME_YES=1; shift ;;
    --help|-h)          usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# --- refuse an unsafe or half-finished setup up front -----------------------
# Better to fail before creating anything than to leave a deployed bridge and a
# running consumer attached to a number that answers strangers.

if [ "$INSTALL_CONSUMER" -eq 1 ]; then
  [ -n "$NUMBER_ID" ] || die "--install-consumer needs --number-id num_xxx.
     Without it the consumer is installed but no number is in relay mode, which
     looks finished and answers nothing. Find yours with:
       curl -s https://api.agentcall.co/v1/numbers -H 'Authorization: Bearer ac_live_...'"
  if [ ${#ALLOW[@]} -eq 0 ] && [ "$ALLOW_ANYONE" -eq 0 ]; then
    die "--install-consumer needs --allow +1XXXXXXXXXX (repeatable).
     That list is what keeps your agent answering only you. Whatever your agent
     can do, a text from an allowed number can attempt.
     To deliberately let ANYONE who texts the number reach your agent, pass
     --allow-anyone instead."
  fi
  if [ "$ALLOW_ANYONE" -eq 1 ] && [ ${#ALLOW[@]} -eq 0 ]; then
    warn "--allow-anyone: ANY phone that texts $NUMBER_ID reaches your agent."
    warn "Only do this for an agent you are happy to let strangers drive."
  fi
fi

# --- prerequisites ----------------------------------------------------------

step "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org)"
say "  node       $(node --version)"

WRANGLER="npx wrangler"
$WRANGLER --version >/dev/null 2>&1 || die "wrangler unavailable. Run 'npm install' here first."
say "  wrangler   $($WRANGLER --version 2>/dev/null | tail -1)"

ACCOUNT_ID="dry-run-account"
if [ "$DRY_RUN" -eq 0 ]; then
  WHOAMI="$($WRANGLER whoami 2>&1 || true)"
  case "$WHOAMI" in
    *"You are logged in"*) : ;;
    *) die "not logged in to Cloudflare. Run: npx wrangler login" ;;
  esac
  say "  cloudflare $(printf '%s' "$WHOAMI" | grep -o '[^ ]*@[^ .]*\.[^ .]*' | head -1)"
  # Account id namespaces the local state, so the same worker name under two
  # different Cloudflare accounts never collides on disk.
  ACCOUNT_ID="$(printf '%s' "$WHOAMI" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  [ -n "$ACCOUNT_ID" ] || ACCOUNT_ID="unknown-account"
fi

[ -f package.json ] || die "run this from the agentcall-hermes-bridge checkout"
if [ ! -d node_modules ]; then
  step "Installing dependencies"
  [ "$DRY_RUN" -eq 1 ] && say "  would run: npm install" || npm install
fi

# --- per-run state ----------------------------------------------------------
# Namespaced by account AND worker name. A developer bootstrapping a second
# client from this same checkout must not overwrite the first client's
# unrecoverable secrets or their rollback commands.

BOOT_DIR="$REPO_DIR/.bootstrap/$ACCOUNT_ID/$NAME"
CONFIG_FILE="$BOOT_DIR/wrangler.jsonc"
SECRETS_FILE="$BOOT_DIR/secrets.env"
ROLLBACK_FILE="$BOOT_DIR/rollback.sh"

step "Run state"
say "  directory  ${BOOT_DIR#$REPO_DIR/}"
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -e "$SECRETS_FILE" ] && [ "$FORCE_REPLACE" -eq 0 ]; then
    die "$SECRETS_FILE already exists.

     A previous bootstrap of '$NAME' on this account left secrets there, and
     Cloudflare will never show them again, so this run will not overwrite it.
     Use a different --name, or move that directory aside deliberately."
  fi
  mkdir -p "$BOOT_DIR"
fi

# --- do not silently take over an existing Worker ---------------------------
# `wrangler deploy` UPDATES a Worker of the same name, and the secret writes
# below REPLACE its secrets. On a bridge already in use that is not a cosmetic
# clash: its AgentCall numbers keep signing with the old secret, so every text
# starts failing signature verification.

PREV_VERSION=""
if [ "$DRY_RUN" -eq 0 ]; then
  step "Checking the Worker name"
  if $WRANGLER deployments list --name "$NAME" >/dev/null 2>&1; then
    if [ "$FORCE_REPLACE" -eq 0 ]; then
      die "a Worker named '$NAME' already exists on this account.

     Deploying over it would replace its secrets, and any AgentCall number
     pointed at it would start failing signature verification on every text.

     Either pick another name:    --name hermes-bridge-2
     or replace it deliberately:  --force-replace"
    fi
    PREV_VERSION="$($WRANGLER deployments list --name "$NAME" 2>/dev/null \
      | grep -oE '[0-9a-f-]{36}' | head -1 || true)"
    warn "REPLACING the existing Worker '$NAME'."
    warn "Its current secrets will be overwritten and Cloudflare does not"
    warn "disclose the old values, so this is NOT undoable. Any number pointed"
    warn "at it must be re-run through configure-number with the new secret."
    [ -n "$PREV_VERSION" ] && warn "Previous version id recorded: $PREV_VERSION"
  else
    say "  '$NAME' is free"
  fi
fi

record_rollback() { ROLLBACK_STEPS+=("$1"); }

# --- confirm ----------------------------------------------------------------

TARGET_DESC="a workers.dev URL (no domain needed)"
[ -n "$DOMAIN" ] && TARGET_DESC="https://$DOMAIN"

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ]; then
  step "About to create real Cloudflare resources"
  say "  worker     $NAME$([ "$FORCE_REPLACE" -eq 1 ] && printf '  (REPLACING an existing one)')"
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
  say "  would run: $WRANGLER kv namespace create HERMES_CONTEXT"
  KV_ID="DRY_RUN_KV_ID"
else
  # KV namespace TITLES are account-global, so a bare "HERMES_CONTEXT" collides
  # with any bridge already bootstrapped on this account. Title it per worker.
  # The runtime binding is still HERMES_CONTEXT: that is set in the config
  # below and is independent of the namespace's title.
  #
  # No --config here: the config does not exist yet, and it would reference the
  # very namespace this call is creating.
  KV_TITLE="${NAME}-HERMES_CONTEXT"
  KV_OUT="$($WRANGLER kv namespace create "$KV_TITLE" 2>&1 || true)"
  # wrangler has changed this output repeatedly (toml block, jsonc block,
  # quoted vs bare). A 32-hex id is the stable part, so take that.
  KV_ID="$(printf '%s' "$KV_OUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)"

  if [ -z "$KV_ID" ] && printf '%s' "$KV_OUT" | grep -q "already exists"; then
    # Left over from an earlier run of this same worker name that failed after
    # creating the namespace. Adopt it rather than making the operator clean up
    # by hand; the title is worker-scoped, so it cannot be someone else's.
    say "  '$KV_TITLE' already exists, looking it up"
    # Parsed with node rather than grep: the list is pretty-printed JSON, and
    # a regex across it would match the wrong record the moment two titles
    # share a prefix.
    KV_ID="$($WRANGLER kv namespace list 2>/dev/null | node -e '
      let s = "";
      process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const hit = JSON.parse(s.slice(s.indexOf("[")))
            .find(n => n.title === process.argv[1]);
          if (hit) process.stdout.write(hit.id);
        } catch {}
      });' "$KV_TITLE" || true)"
    if [ -n "$KV_ID" ]; then
      say "  reusing    id $KV_ID (not created by this run, so no delete step)"
      ADOPTED_KV=1
    fi
  fi

  if [ -z "$KV_ID" ]; then
    say "$KV_OUT"
    die "could not create or find the KV namespace '$KV_TITLE'.
     List what exists with: npx wrangler kv namespace list"
  fi
  if [ "${ADOPTED_KV:-0}" -eq 0 ]; then
    say "  created    id $KV_ID  (title $KV_TITLE)"
    # -y, not --force: kv namespace delete spells its non-interactive flag
    # --skip-confirmation, and would otherwise sit waiting for a prompt.
    record_rollback "npx wrangler kv namespace delete --namespace-id $KV_ID -y"
  fi
fi

# --- config -----------------------------------------------------------------
# Written into the per-run directory and passed with --config, so the repo's
# own wrangler.jsonc is never rewritten and two clients never share one file.
# `main` is relative to the CONFIG file, not the working directory, and the
# config sits at .bootstrap/<account>/<worker>/ — exactly three levels below
# the repo root, so "../../../src/index.ts" is deterministic. An absolute path
# looks safer and is not: on Windows/Git-Bash $(pwd) yields "/c/Users/..."
# which wrangler resolves into nonsense.

step "Config"
if [ -n "$DOMAIN" ]; then
  # BARE hostname, no "/*". The wildcard form is for Worker Routes; wrangler
  # rejects it on a Custom Domain, and both forms are valid JSON, so only a
  # real deploy surfaces the mistake.
  DOMAIN="${DOMAIN%/\*}"; DOMAIN="${DOMAIN%/}"
  ROUTES=$(printf '  "routes": [\n    { "pattern": "%s", "custom_domain": true }\n  ],' "$DOMAIN")
  WORKERS_DEV='  "workers_dev": false,'
else
  ROUTES=""
  WORKERS_DEV='  "workers_dev": true,'
fi

CONFIG_JSON=$(cat <<EOF
{
  "name": "$NAME",
  "main": "../../../src/index.ts",
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
  say "  would write ${CONFIG_FILE#$REPO_DIR/}:"
  printf '%s\n' "$CONFIG_JSON" | sed 's/^/    /'
else
  printf '%s\n' "$CONFIG_JSON" > "$CONFIG_FILE"
  say "  wrote      ${CONFIG_FILE#$REPO_DIR/} ($NAME -> ${DOMAIN:-workers.dev})"
fi

WR_CONF=(--config "$CONFIG_FILE")

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
    say "  would run: printf ... | $WRANGLER secret put $1 --config <run config>"
    return 0
  fi
  if printf '%s' "$2" | $WRANGLER secret put "$1" "${WR_CONF[@]}" >/dev/null 2>&1; then
    say "  set        $1"
  else
    die "could not set $1. Run '$WRANGLER secret put $1 --config $CONFIG_FILE' by hand."
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
  say "  would run: $WRANGLER deploy --config <run config>"
  BRIDGE_URL="https://$NAME.EXAMPLE.workers.dev"
  [ -n "$DOMAIN" ] && BRIDGE_URL="https://$DOMAIN"
else
  DEPLOY_OUT="$($WRANGLER deploy "${WR_CONF[@]}" 2>&1 || true)"
  printf '%s\n' "$DEPLOY_OUT" | sed 's/^/  /' | tail -8
  # Only offer to delete the Worker if THIS run created it. With
  # --force-replace it already existed, and deleting it would destroy
  # someone's bridge rather than undo anything.
  if [ "$FORCE_REPLACE" -eq 0 ]; then
    record_rollback "npx wrangler delete --name $NAME --force"
  fi
  if [ -n "$DOMAIN" ]; then
    BRIDGE_URL="https://$DOMAIN"
  else
    BRIDGE_URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
  fi
  [ -n "$BRIDGE_URL" ] || die "deployed, but could not find the URL above.
     Find it with 'npx wrangler deployments list --name $NAME'."
fi

# --- write the run state ----------------------------------------------------

if [ "$DRY_RUN" -eq 0 ]; then
  # Secrets to a 0600 file, never stdout: they are unrecoverable from
  # Cloudflare, and stdout is captured by scrollback, CI logs, agent tool
  # output, screen recordings, and pasted support transcripts. Restrictive
  # umask rather than chmod-after-write, so it is never briefly world-readable.
  ( umask 077; cat > "$SECRETS_FILE" <<EOF
# AgentCall bridge secrets for worker '$NAME'
# account $ACCOUNT_ID, generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Cloudflare will not show these again. Keep or delete deliberately.
AGENTCALL_BRIDGE_URL=$BRIDGE_URL
AGENTCALL_SIGNING_SECRET=$AGENTCALL_SIGNING_SECRET
AGENTCALL_SMS_SIGNING_SECRET=$AGENTCALL_SMS_SIGNING_SECRET
HERMES_PUSH_KEY=$HERMES_PUSH_KEY
EOF
  )
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
  # Verify rather than assume. chmod and umask are silently ignored on some
  # filesystems (notably NTFS via Git Bash and some network mounts), and a
  # world-readable file full of unrecoverable secrets should say so out loud
  # instead of looking locked down.
  PERM="$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_FILE" 2>/dev/null || echo '')"
  case "$PERM" in
    600|"") ;;
    *) warn "$SECRETS_FILE is mode $PERM, not 600. This filesystem ignored chmod."
       warn "Anyone with access to this machine can read the bridge secrets."
       warn "Move it somewhere you can actually restrict before leaving it there." ;;
  esac

  # Rollback runs in REVERSE creation order: the Worker goes first, then the
  # KV namespace it was bound to. Tearing the namespace out from under a live
  # Worker would leave it deployed and broken.
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Undo the bootstrap of worker "%s" on account %s\n' "$NAME" "$ACCOUNT_ID"
    printf '# Generated %s. Reverse creation order: Worker first, then its KV.\n' \
           "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [ "$FORCE_REPLACE" -eq 1 ]; then
      printf '#\n# THIS WAS A REPLACEMENT, NOT A FRESH CREATE.\n'
      printf '# The Worker existed before this run, so there is no delete step for it:\n'
      printf '# deleting it would destroy the pre-existing bridge rather than undo\n'
      printf '# anything. Its previous SECRETS cannot be restored either, because\n'
      printf '# Cloudflare never discloses stored secret values. Restoring them needs\n'
      printf '# your own prior backup.\n'
      [ -n "$PREV_VERSION" ] && printf '# Previous version id: %s\n' "$PREV_VERSION"
      printf '#   npx wrangler rollback %s --name %s\n' "${PREV_VERSION:-<version-id>}" "$NAME"
    fi
    printf 'set -euo pipefail\n\n'
    for (( i=${#ROLLBACK_STEPS[@]}-1 ; i>=0 ; i-- )); do
      printf 'echo "+ %s"\n' "${ROLLBACK_STEPS[$i]}"
      printf '%s\n\n' "${ROLLBACK_STEPS[$i]}"
    done
    printf 'echo "rolled back. Local state is still in %s"\n' "$BOOT_DIR"
  } > "$ROLLBACK_FILE"
  chmod +x "$ROLLBACK_FILE" 2>/dev/null || true
fi

# --- verify -----------------------------------------------------------------

step "Verifying"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would run: curl -fsS $BRIDGE_URL/healthz"
else
  HEALTH=""
  for _ in 1 2 3 4 5 6; do            # a fresh route takes a moment to answer
    HEALTH="$(curl -fsS "$BRIDGE_URL/healthz" 2>/dev/null || true)"
    [ "$HEALTH" = "ok" ] && break
    sleep 5
  done
  [ "$HEALTH" = "ok" ] || die "deployed to $BRIDGE_URL but /healthz did not answer 'ok'.
     Check 'npx wrangler tail --name $NAME'. To undo: $ROLLBACK_FILE"
  say "  $BRIDGE_URL/healthz -> ok"
fi

# --- hand off ---------------------------------------------------------------

step "Bridge is up"
say "  URL        $BRIDGE_URL"
if [ "$DRY_RUN" -eq 0 ]; then
  say "  secrets    ${SECRETS_FILE#$REPO_DIR/} (0600, not printed)"
  say "  rollback   ${ROLLBACK_FILE#$REPO_DIR/}"
fi

if [ "$SHOW_SECRETS" -eq 1 ]; then
  warn "--show-secrets: these are now in your scrollback and any log capturing it."
  say "    AGENTCALL_SIGNING_SECRET=$AGENTCALL_SIGNING_SECRET"
  say "    AGENTCALL_SMS_SIGNING_SECRET=$AGENTCALL_SMS_SIGNING_SECRET"
  say "    HERMES_PUSH_KEY=$HERMES_PUSH_KEY"
fi

if [ "$INSTALL_CONSUMER" -eq 1 ]; then
  step "Installing the consumer"
  # Secrets travel in the ENVIRONMENT, never argv: command lines are readable
  # by any user on the box via ps, environments only by the same user and root.
  consumer_args=(--bridge-dir "$REPO_DIR" --number-id "$NUMBER_ID")
  for a in "${ALLOW[@]:-}"; do [ -n "$a" ] && consumer_args+=(--allow "$a"); done
  [ "$ALLOW_ANYONE" -eq 1 ] && consumer_args+=(--yes)
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  would run: AGENTCALL_BRIDGE_URL=... HERMES_PUSH_KEY=... \\"
    say "             AGENTCALL_SMS_SIGNING_SECRET=... ./consumer/install.sh ${consumer_args[*]}"
  else
    AGENTCALL_BRIDGE_URL="$BRIDGE_URL" \
    HERMES_PUSH_KEY="$HERMES_PUSH_KEY" \
    AGENTCALL_SMS_SIGNING_SECRET="$AGENTCALL_SMS_SIGNING_SECRET" \
      ./consumer/install.sh "${consumer_args[@]}"
  fi
  exit $?
fi

say ""
say "  Next, install the consumer next to your agent. Load the secrets from the"
say "  file rather than retyping them, so they stay out of your shell history:"
say ""
say "    set -a; . ${SECRETS_FILE#$REPO_DIR/}; set +a"
say "    ./consumer/install.sh --bridge-dir $REPO_DIR \\"
say "      --number-id num_xxx --allow +1XXXXXXXXXX"
say ""
say "  (or re-run this with --install-consumer to chain them)"
