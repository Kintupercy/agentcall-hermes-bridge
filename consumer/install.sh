#!/usr/bin/env bash
#
# One-command install for the AgentCall SMS relay consumer.
#
#   curl -fsSL https://raw.githubusercontent.com/Kintupercy/agentcall-hermes-bridge/main/consumer/install.sh | bash -s -- \
#     --bridge-url https://hermes.example.com \
#     --push-key   "$HERMES_PUSH_KEY" \
#     --api-key    "$AGENTCALL_API_KEY" \
#     --sms-secret "$AGENTCALL_SMS_SIGNING_SECRET" \
#     --allow      +15551234567 \
#     --brain      /opt/agentcall-sms-consumer/brains/hermes_brain.sh \
#     --number-id  num_xxx \
#     --verify-live +15551234567
#
# Or clone the repo and run ./consumer/install.sh with no arguments to be
# prompted for each value.
#
# What it does:
#   1. installs the consumer to a prefix (/opt/... as root, ~/.local/... otherwise)
#   2. writes config.json (world-readable) and consumer.env (0600, secrets)
#   3. installs a systemd service that restarts forever
#   4. generates the SMS signing secret if you did not supply one, and writes it
#      to the Worker too when --bridge-dir is given
#   5. runs preflight, then selftest, and REFUSES to claim success unless they
#      pass. With --verify-live it also waits for a real text before saying READY
#
# It does NOT touch your AgentCall number unless you pass --number-id. Putting a
# number into relay mode changes how real texts are handled, so that stays an
# explicit step.

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/Kintupercy/agentcall-hermes-bridge/main/consumer"

BRIDGE_URL=""
BRIDGE_DIR=""
PUSH_KEY=""
API_KEY=""
SMS_SECRET=""
BRAIN=""
NUMBER_ID=""
VERIFY_LIVE=""
ALLOW=()
PREFIX=""
SERVICE_USER=""
NO_SERVICE=0
ASSUME_YES=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  # Piped into bash, "$0" is the shell itself, so reading the header back out of
  # the file only works when the script is on disk.
  if [ -f "$0" ] && head -1 "$0" | grep -q '^#!'; then
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
  else
    cat <<'USAGE'
One-command install for the AgentCall SMS relay consumer.

  --bridge-url URL    your deployed bridge, https://hermes.example.com
  --bridge-dir DIR    local clone of this repo; the SMS signing secret is
                      written to the Worker from there via wrangler
  --push-key KEY      the bridge's HERMES_PUSH_KEY
  --api-key KEY       your AgentCall API key, ac_live_...
  --sms-secret SECRET the bridge's signing secret (generated if omitted)
  --allow +1555...    a phone number allowed to reach your agent (repeatable)
  --brain PATH        the command that asks your agent for a reply
  --number-id num_... also put this number into relay mode, then selftest it
  --verify-live +1... wait for a real text and only print READY if it completes
  --prefix DIR        install location
  --user NAME         run the service as an existing user
  --no-service        install files only, do not touch systemd
  --yes               do not prompt for optional values

Run with no arguments to be prompted for each value.
Docs: https://github.com/Kintupercy/agentcall-hermes-bridge/tree/main/consumer
USAGE
  fi
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bridge-url) BRIDGE_URL="${2:-}"; shift 2 ;;
    --bridge-dir) BRIDGE_DIR="${2:-}"; shift 2 ;;
    --push-key)   PUSH_KEY="${2:-}"; shift 2 ;;
    --api-key)    API_KEY="${2:-}"; shift 2 ;;
    --sms-secret) SMS_SECRET="${2:-}"; shift 2 ;;
    --brain)      BRAIN="${2:-}"; shift 2 ;;
    --allow)      ALLOW+=("${2:-}"); shift 2 ;;
    --number-id)  NUMBER_ID="${2:-}"; shift 2 ;;
    --verify-live) VERIFY_LIVE="${2:-}"; shift 2 ;;
    --prefix)     PREFIX="${2:-}"; shift 2 ;;
    --user)       SERVICE_USER="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --help|-h)    usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --- prerequisites ----------------------------------------------------------

step "Checking prerequisites"

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || die "python3 is required (3.8 or newer). Install it and re-run."
PY_OK="$("$PYTHON" -c 'import sys; print(1 if sys.version_info >= (3, 8) else 0)')"
[ "$PY_OK" = "1" ] || die "python3 3.8 or newer is required (found $("$PYTHON" -V 2>&1))."
say "  python3   $("$PYTHON" -V 2>&1)"

IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

if [ -z "$PREFIX" ]; then
  if [ "$IS_ROOT" -eq 1 ]; then PREFIX="/opt/agentcall-sms-consumer"
  else PREFIX="$HOME/.local/share/agentcall-sms-consumer"; fi
fi
if [ "$IS_ROOT" -eq 1 ]; then
  ENV_DIR="/etc/agentcall-sms-consumer"
  STATE_DIR="/var/lib/agentcall-sms-consumer"
else
  ENV_DIR="$PREFIX"
  STATE_DIR="$HOME/.agentcall-sms-consumer"
fi
say "  prefix    $PREFIX"
say "  secrets   $ENV_DIR/consumer.env"
say "  state     $STATE_DIR"

# --- gather settings --------------------------------------------------------

# Can we ask the user something? Test /dev/tty, NOT stdin. Under the documented
# `curl ... | install.sh | bash` flow stdin is the pipe carrying the script, so
# `[ -t 0 ]` is false even though there is a perfectly good terminal attached —
# gating on it made the headline one-liner die with "no terminal to ask on".
# A real non-interactive context (CI, a container with no controlling terminal)
# has no readable /dev/tty and still falls through to the error.
if [ -r /dev/tty ]; then HAVE_TTY=1; else HAVE_TTY=0; fi

prompt() { # prompt VAR_NAME "question" [secret]
  local __var="$1" __q="$2" __secret="${3:-}" __val=""
  eval "__val=\${$__var}"
  [ -n "$__val" ] && return 0
  [ "$HAVE_TTY" -eq 1 ] || die "$__var not set and no terminal to ask on. Pass it as a flag."
  if [ -n "$__secret" ]; then
    read -r -s -p "$__q: " __val < /dev/tty; printf '\n'
  else
    read -r -p "$__q: " __val < /dev/tty
  fi
  eval "$__var=\$__val"
}

step "Settings"
say "  You are about to give a phone number the ability to type into your agent."
say "  Whatever your agent can do, a text message can now attempt: shell commands,"
say "  spending money, reading files, if those are on the table. The sender"
say "  allowlist below is a speed bump, not a wall - caller ID is a claim, not a"
say "  credential. If your agent can execute code or take irreversible actions,"
say "  put a narrower agent on this channel instead of your full one."
say "  Details: https://github.com/Kintupercy/agentcall-hermes-bridge/blob/main/consumer/README.md#threat-model"
say ""
prompt BRIDGE_URL "Bridge URL (https://hermes.your-domain.com)"
BRIDGE_URL="${BRIDGE_URL%/}"
case "$BRIDGE_URL" in
  https://*) ;;
  *) die "bridge URL must start with https:// (got '$BRIDGE_URL')" ;;
esac
prompt PUSH_KEY   "Worker HERMES_PUSH_KEY" secret
prompt API_KEY    "AgentCall API key (ac_live_...)" secret

# The SMS signing secret is NOT optional, because the failure it causes is
# invisible. One value has to live in two places: the Worker, and the AgentCall
# number. If they differ, AgentCall accepts the text, signs it with its copy,
# and the Worker rejects the push with 401 — the text just vanishes, while both
# sides look configured. Reading the number back does not help: AgentCall
# redacts the stored secret to `hasSigningSecret: true`, which proves a secret
# exists and nothing about which one.
#
# So: collect it, or generate it, and then push the SAME value to both sides.
if [ -z "$SMS_SECRET" ] && [ "$HAVE_TTY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
  say ""
  say "  The SMS signing secret must be identical in your Worker and on your"
  say "  AgentCall number. Paste the Worker's AGENTCALL_SMS_SIGNING_SECRET, or"
  say "  leave it blank and one will be generated for you to install in both."
  read -r -s -p "Worker AGENTCALL_SMS_SIGNING_SECRET (blank = generate): " SMS_SECRET < /dev/tty
  printf '\n'
fi
GENERATED_SECRET=0
if [ -z "$SMS_SECRET" ]; then
  if command -v openssl >/dev/null 2>&1; then
    SMS_SECRET="$(openssl rand -hex 32)"
  else
    SMS_SECRET="$("$PYTHON" -c 'import secrets; print(secrets.token_hex(32))')"
  fi
  GENERATED_SECRET=1
  say "  generated a new SMS signing secret"
fi

if [ ${#ALLOW[@]} -eq 0 ] && [ "$HAVE_TTY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
  read -r -p "Your phone number, E.164, so only you can reach the agent (blank = anyone): " _allow < /dev/tty
  [ -n "$_allow" ] && ALLOW+=("$_allow")
fi
if [ ${#ALLOW[@]} -eq 0 ]; then
  warn "no allowlist: ANYONE who texts this number reaches your agent, with"
  warn "whatever tools it has. Only do this deliberately, for an agent you are"
  warn "happy to let strangers drive."
fi

# --- install files ----------------------------------------------------------

step "Installing"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$PREFIX/brains" "$ENV_DIR" "$STATE_DIR"

fetch() { # fetch RELATIVE_PATH DEST
  if [ -f "$SRC_DIR/$1" ]; then
    cp "$SRC_DIR/$1" "$2"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$REPO_RAW/$1" -o "$2"
  else
    die "cannot find $1 locally and curl is not installed"
  fi
}

fetch agentcall_sms_consumer.py "$PREFIX/agentcall_sms_consumer.py"
fetch brains/echo_brain.sh "$PREFIX/brains/echo_brain.sh"
fetch brains/hermes_brain.sh.example "$PREFIX/brains/hermes_brain.sh.example"
chmod +x "$PREFIX/agentcall_sms_consumer.py" "$PREFIX/brains/echo_brain.sh"
say "  installed $PREFIX/agentcall_sms_consumer.py"

if [ -z "$BRAIN" ]; then
  BRAIN="$PREFIX/brains/echo_brain.sh"
  warn "no --brain given: using the echo brain, which replies 'Echo: <your text>'."
  warn "Copy brains/hermes_brain.sh.example to hermes_brain.sh, wire it to your"
  warn "agent, then set brain.command in $PREFIX/config.json."
fi

# --- config.json ------------------------------------------------------------

allow_json="[]"
if [ ${#ALLOW[@]} -gt 0 ]; then
  allow_json="$(printf '%s\n' "${ALLOW[@]}" | "$PYTHON" -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"
fi

cat > "$PREFIX/config.json" <<EOF
{
  "bridge_url": "$BRIDGE_URL",
  "agentcall_api_base": "https://api.agentcall.co",
  "allowed_senders": $allow_json,
  "brain": {
    "mode": "command",
    "command": ["$BRAIN"],
    "timeout_seconds": 120
  },
  "poll_interval_seconds": 2,
  "history_messages": 20,
  "max_reply_chars": 1500,
  "health_port": 0,
  "state_dir": "$STATE_DIR"
}
EOF
say "  wrote     $PREFIX/config.json"

# --- secrets ----------------------------------------------------------------
# Written with a restrictive umask rather than chmod-after-write, so the file is
# never briefly world-readable with a live API key in it.

( umask 077; cat > "$ENV_DIR/consumer.env" <<EOF
AGENTCALL_BRIDGE_URL=$BRIDGE_URL
HERMES_PUSH_KEY=$PUSH_KEY
AGENTCALL_API_KEY=$API_KEY
AGENTCALL_SMS_SIGNING_SECRET=$SMS_SECRET
EOF
)
chmod 600 "$ENV_DIR/consumer.env"
say "  wrote     $ENV_DIR/consumer.env (0600)"

# --- service ----------------------------------------------------------------

RUN_CMD="$PYTHON $PREFIX/agentcall_sms_consumer.py --config $PREFIX/config.json"

install_system_service() {
  local unit=/etc/systemd/system/agentcall-sms-consumer.service
  local svc_user="${SERVICE_USER:-agentcall}"

  if ! id -u "$svc_user" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$svc_user" \
      || die "could not create service user '$svc_user' (pass --user <existing-user>)"
    say "  created   service user $svc_user"
  fi
  chown -R "$svc_user":"$svc_user" "$STATE_DIR" "$PREFIX"
  chown "$svc_user":"$svc_user" "$ENV_DIR/consumer.env"

  cat > "$unit" <<EOF
[Unit]
Description=AgentCall SMS relay consumer (bridge -> your agent -> reply)
Documentation=https://github.com/Kintupercy/agentcall-hermes-bridge
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$RUN_CMD run
WorkingDirectory=$PREFIX
EnvironmentFile=$ENV_DIR/consumer.env
Environment=PYTHONUNBUFFERED=1
User=$svc_user
Group=$svc_user
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentcall-sms
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now agentcall-sms-consumer >/dev/null
  say "  service   agentcall-sms-consumer enabled and started"
}

install_user_service() {
  local dir="$HOME/.config/systemd/user"
  mkdir -p "$dir"
  cat > "$dir/agentcall-sms-consumer.service" <<EOF
[Unit]
Description=AgentCall SMS relay consumer
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$RUN_CMD run
WorkingDirectory=$PREFIX
EnvironmentFile=$ENV_DIR/consumer.env
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now agentcall-sms-consumer >/dev/null
  say "  service   agentcall-sms-consumer enabled and started (user scope)"
  # Without lingering, the service dies when this login session ends, which
  # looks exactly like "it worked yesterday and stopped overnight".
  if command -v loginctl >/dev/null 2>&1 && \
     [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    warn "user services stop when you log out. Run: sudo loginctl enable-linger $USER"
  fi
}

step "Service"
if [ "$NO_SERVICE" -eq 1 ]; then
  say "  skipped (--no-service). Run it yourself with:"
  say "    $RUN_CMD run"
elif ! command -v systemctl >/dev/null 2>&1; then
  warn "systemd not found. Use Docker (consumer/docker-compose.yml) or run:"
  say "    $RUN_CMD run"
elif [ "$IS_ROOT" -eq 1 ]; then
  install_system_service
else
  install_user_service
fi

# --- verify -----------------------------------------------------------------

# --- put the SAME secret on the Worker --------------------------------------

step "Worker secret"
SECRET_WAIT=0
if [ -n "$BRIDGE_DIR" ] && command -v wrangler >/dev/null 2>&1; then
  if printf '%s' "$SMS_SECRET" | (cd "$BRIDGE_DIR" && wrangler secret put AGENTCALL_SMS_SIGNING_SECRET >/dev/null 2>&1); then
    say "  wrote AGENTCALL_SMS_SIGNING_SECRET to the Worker in $BRIDGE_DIR"
    SECRET_WAIT=45   # let it reach every edge before selftest calls a 401 a mismatch
  else
    warn "could not write the Worker secret automatically. Do it by hand (below)."
  fi
fi
if [ "$SECRET_WAIT" -eq 0 ]; then
  say "  Not written automatically. In your bridge repo, run:"
  say ""
  say "    wrangler secret put AGENTCALL_SMS_SIGNING_SECRET"
  if [ "$GENERATED_SECRET" -eq 1 ]; then
    say "    # paste this exact value:"
    say "    $SMS_SECRET"
  else
    say "    # paste the same value you gave this installer"
  fi
  say ""
  say "  (pass --bridge-dir /path/to/agentcall-hermes-bridge to have this done for you)"
  if [ "$HAVE_TTY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
    read -r -p "  Press enter once the Worker secret is set... " _ < /dev/tty
    SECRET_WAIT=15
  fi
fi

# --- verify ------------------------------------------------------------------

step "Preflight"
set -a
# shellcheck disable=SC1090
. "$ENV_DIR/consumer.env"
set +a
PREFLIGHT_RC=0
$RUN_CMD preflight || PREFLIGHT_RC=$?

# --- optional: put the number into relay mode -------------------------------

if [ -n "$NUMBER_ID" ]; then
  step "Configuring $NUMBER_ID for relay"
  # Always pass the secret, never let AgentCall keep a stored one. On an
  # existing number the stored secret is usually the stale half of this exact
  # problem, and nothing can read it back to tell you.
  configure_args=(configure-number --number-id "$NUMBER_ID" --bridge-url "$BRIDGE_URL" --signing-secret "$SMS_SECRET")
  for a in "${ALLOW[@]:-}"; do [ -n "$a" ] && configure_args+=(--allow "$a"); done
  $RUN_CMD "${configure_args[@]}" || warn "could not configure the number; run it by hand (see below)."
fi

# --- prove it, do not assume it ---------------------------------------------

SELFTEST_RC=0
if [ -n "$NUMBER_ID" ] && [ "$PREFLIGHT_RC" -eq 0 ]; then
  step "Selftest (signed synthetic text through the real loop; texts nobody)"
  $RUN_CMD selftest --secret-wait "$SECRET_WAIT" || SELFTEST_RC=$?
else
  SELFTEST_RC=127
fi

# --- what next --------------------------------------------------------------

step "Next"
say "  status      $RUN_CMD status"
say "  logs        journalctl -u agentcall-sms-consumer -f"
say "  selftest    $RUN_CMD selftest         # signed synthetic text, no SMS sent"
say "  live test   $RUN_CMD verify --number +1XXXXXXXXXX"
if [ -z "$NUMBER_ID" ]; then
  say ""
  say "  The number is not in relay mode yet. When you are ready:"
  say "    $RUN_CMD configure-number --number-id num_xxx \\"
  say "      --bridge-url $BRIDGE_URL --signing-secret <the same secret> \\"
  say "      --allow +1XXXXXXXXXX"
  say "    $RUN_CMD selftest"
fi
say ""

if [ "$PREFLIGHT_RC" -ne 0 ]; then
  say "NOT READY. Preflight found problems (above). Fix those, then re-run preflight."
  exit "$PREFLIGHT_RC"
fi
if [ "$SELFTEST_RC" -eq 127 ]; then
  say "Installed. NOT verified end to end yet: configure a number, then run selftest."
  say "Do not trust the setup until selftest passes."
  exit 0
fi
if [ "$SELFTEST_RC" -ne 0 ]; then
  say "NOT READY. Installed and configured, but the selftest did not pass, so a"
  say "real text would be dropped somewhere in the chain. The most common cause is"
  say "the Worker and the number holding DIFFERENT signing secrets. Fix that, then:"
  say "    $RUN_CMD selftest"
  exit "$SELFTEST_RC"
fi

# --- the only test that proves the carrier leg -------------------------------

if [ -n "$VERIFY_LIVE" ]; then
  step "Live verification"
  say "  Everything above is machine-checkable. This last hop is not: only a real"
  say "  text proves the carrier, the 10DLC registration, and the number's relay"
  say "  config all work together."
  say ""
  if $RUN_CMD verify --number "$VERIFY_LIVE"; then
    say ""
    say "READY. A real text reached your agent and your agent's reply went back out."
    exit 0
  fi
  say ""
  say "NOT READY. The synthetic loop passes but a real text did not complete."
  say "Everything except the carrier leg is proven, so look at the number itself:"
  say "  - is it on the Pro plan (relay is not processed on Free)"
  say "  - is smsMode really 'relay'  ($RUN_CMD configure-number --dry-run ...)"
  say "  - is your phone on the allowlist"
  exit 1
fi

say "Ready for a real text. The loop is proven end to end except for the carrier."
say "Nothing has yet proven the carrier leg, so finish with:"
say "    $RUN_CMD verify --number +1XXXXXXXXXX"
say "(or re-run this installer with --verify-live +1XXXXXXXXXX to have it wait)"
