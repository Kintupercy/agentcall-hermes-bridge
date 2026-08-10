#!/usr/bin/env python3
"""
AgentCall SMS relay consumer.

The other half of the bridge. The Cloudflare Worker in this repo is the
public, always-on endpoint AgentCall pushes inbound texts to; this program
runs next to your agent (Hermes, or anything you can shell out to) and does
the rest of the loop:

    claim -> build context -> ask your agent -> reply in-thread -> ack

Protocol (all of it lives in ../src/index.ts and on agentcall.co/docs/agent-sms):

  1. POST {bridge}/hermes/pull-sms      X-Hermes-Push-Key
       -> {"messages":[envelope,...]}   each envelope is CLAIMED (hidden) for
          300s, not deleted. If we crash, it comes back.
  2. GET  {api}/v1/sms-conversations/{conversationId}
       -> last 50 messages, oldest first. Optional context for the brain.
  3. brain(envelope + history) -> reply text
  4. POST {api}/v1/sms-conversations/{conversationId}/reply
       {"body": ..., "idempotencyKey": message.id}
  5. POST {bridge}/hermes/ack-sms       {"messageIds":[...]}
       -> removed for good. Never ack what we did not finish.

Design rules this file follows, learned the hard way:

  * Never ack before the reply lands. A dropped text in a personal SMS agent
    is worse than a duplicate, and the reply endpoint is idempotent on
    idempotencyKey, so redelivery is cheap.
  * Never retry forever on a permanent error. 403 opted-out and 404 gone are
    acked and logged, not looped.
  * Never send twice for one message id, even if the bridge redelivers after
    a failed ack. A local replied-set backs up the server-side idempotency.
  * Never let Python's default User-Agent near the bridge. Cloudflare answers
    Python-urllib/3.x with 403 Error 1010 and your queue silently piles up.

Subcommands:
  run               poll forever (this is what the service runs)
  status            print the state file written by `run`
  preflight         check config, bridge, API key, and brain without sending
  selftest          push a signed synthetic text through the real loop
  verify            live end-to-end: you text the number, this watches it land
  configure-number  put an AgentCall number into relay mode pointing here

Python 3.8+. Standard library only, on purpose: the box running your agent
should not need a pip install to answer a text.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import hmac
import json
import os
import random
import signal
import socket
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

VERSION = "1.0.0"

# Cloudflare blocks Python's stdlib User-Agent on this bridge (403, Error 1010,
# browser_signature_banned) and the failure is silent from the caller's side:
# every poll 403s and the queue just grows. Always send our own.
USER_AGENT = f"agentcall-sms-consumer/{VERSION}"

DEFAULT_API_BASE = "https://api.agentcall.co"
DEFAULT_POLL_INTERVAL = 2.0
DEFAULT_BRAIN_TIMEOUT = 120.0
DEFAULT_HTTP_TIMEOUT = 20.0
DEFAULT_MAX_REPLY_CHARS = 1500  # server hard-caps at 1600

# SMS_VISIBILITY_MS in ../src/index.ts. A pulled text is hidden for this long,
# not deleted; after it, an unacked text is redelivered. The brain must finish
# comfortably inside it. Keep the two in sync if the Worker changes.
BRIDGE_VISIBILITY_SECONDS = 300.0
DEFAULT_HISTORY_MESSAGES = 20

# Poll backoff after consecutive failures: 2s -> 60s, so a bridge outage does
# not turn into a request flood.
BACKOFF_MAX_SECONDS = 60.0

# Bound the local replied-set. 2000 message ids is far more than the bridge
# can hold (200/tenant) and keeps the state file small.
MAX_REPLIED_IDS = 2000

# How often an idle consumer rewrites the state file so `status` and the health
# endpoint can tell "quiet" apart from "wedged".
STATE_HEARTBEAT_SECONDS = 30.0

# A brain may deliberately decline to answer (spam, nothing to say). Exiting
# with this code acks the text without sending anything.
BRAIN_EXIT_NO_REPLY = 64

# Synthetic envelopes injected by `selftest`. The consumer must never try to
# text a real person for one of these: the conversation does not exist.
SELFTEST_CONVERSATION_PREFIX = "smsconv_selftest_"


# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------

_LOG_LOCK = threading.Lock()


def log(event: str, **fields: Any) -> None:
    """One JSON object per line, on stdout, so journalctl/docker logs stay
    greppable. Never raises: logging must not be able to kill the loop."""
    record: Dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
    }
    record.update(fields)
    try:
        line = json.dumps(record, default=str)
    except Exception:
        line = json.dumps({"ts": record["ts"], "event": event, "log_error": True})
    with _LOG_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    pass


class Config:
    """Config file + environment. Environment always wins, so secrets can live
    in a 0600 EnvironmentFile that systemd reads and the config file can stay
    checked in / world-readable."""

    def __init__(self, raw: Dict[str, Any]):
        self.bridge_url: str = _rstrip_slash(
            _pick(raw, "bridge_url", "AGENTCALL_BRIDGE_URL", "")
        )
        self.hermes_push_key: str = _pick(raw, "hermes_push_key", "HERMES_PUSH_KEY", "")
        self.agentcall_api_key: str = _pick(
            raw, "agentcall_api_key", "AGENTCALL_API_KEY", ""
        )
        self.agentcall_api_base: str = _rstrip_slash(
            _pick(raw, "agentcall_api_base", "AGENTCALL_API_BASE", DEFAULT_API_BASE)
        )
        # Only needed by `selftest` (it signs a synthetic envelope the way
        # AgentCall would). The running loop never touches it.
        self.sms_signing_secret: str = _pick(
            raw, "agentcall_sms_signing_secret", "AGENTCALL_SMS_SIGNING_SECRET", ""
        )

        self.allowed_senders: List[str] = _parse_allowed(
            raw.get("allowed_senders"), os.environ.get("AGENTCALL_ALLOWED_SENDERS")
        )
        self.poll_interval: float = float(
            _pick(raw, "poll_interval_seconds", "AGENTCALL_POLL_INTERVAL",
                  DEFAULT_POLL_INTERVAL)
        )
        self.max_reply_chars: int = int(
            _pick(raw, "max_reply_chars", "AGENTCALL_MAX_REPLY_CHARS",
                  DEFAULT_MAX_REPLY_CHARS)
        )
        self.history_messages: int = int(
            _pick(raw, "history_messages", "AGENTCALL_HISTORY_MESSAGES",
                  DEFAULT_HISTORY_MESSAGES)
        )
        self.state_dir: str = _pick(
            raw, "state_dir", "AGENTCALL_STATE_DIR", _default_state_dir()
        )
        self.health_port: int = int(
            _pick(raw, "health_port", "AGENTCALL_HEALTH_PORT", 0)
        )
        # Loopback by default. The health body reports counters, the last poll,
        # and the error string — enough to tell an attacker on the same LAN
        # whether your agent is up and how much it is handling. Containers set
        # 0.0.0.0 explicitly, where the network namespace is the boundary.
        self.health_host: str = _pick(
            raw, "health_host", "AGENTCALL_HEALTH_HOST", "127.0.0.1"
        )
        self.http_timeout: float = float(
            _pick(raw, "http_timeout_seconds", "AGENTCALL_HTTP_TIMEOUT",
                  DEFAULT_HTTP_TIMEOUT)
        )

        brain = raw.get("brain") or {}
        if not isinstance(brain, dict):
            raise ConfigError("brain must be an object")
        self.brain_mode: str = _pick(brain, "mode", "AGENTCALL_BRAIN_MODE", "")
        self.brain_command: Any = brain.get("command")
        env_cmd = os.environ.get("AGENTCALL_BRAIN_COMMAND")
        if env_cmd:
            self.brain_command = env_cmd
            if not self.brain_mode:
                self.brain_mode = "command"
        self.brain_url: str = _pick(brain, "url", "AGENTCALL_BRAIN_URL", "")
        if self.brain_url and not self.brain_mode:
            self.brain_mode = "http"
        if not self.brain_mode:
            self.brain_mode = "command" if self.brain_command else ""
        self.brain_timeout: float = float(
            _pick(brain, "timeout_seconds", "AGENTCALL_BRAIN_TIMEOUT",
                  DEFAULT_BRAIN_TIMEOUT)
        )
        self.brain_headers: Dict[str, str] = brain.get("headers") or {}

    def validate(self) -> List[str]:
        """Return a list of human-readable problems. Empty list = good to run."""
        problems: List[str] = []
        if not self.bridge_url:
            problems.append("bridge_url is required (e.g. https://hermes.example.com)")
        elif not (self.bridge_url.startswith("https://") or _is_loopback(self.bridge_url)):
            problems.append(
                "bridge_url must be https:// (plain http is allowed only for a "
                "loopback address, so `wrangler dev` works)"
            )
        if not self.hermes_push_key:
            problems.append("hermes_push_key is required (the Worker's HERMES_PUSH_KEY)")
        if not self.agentcall_api_key:
            problems.append("agentcall_api_key is required (ac_live_...)")
        if self.brain_mode not in ("command", "http"):
            problems.append("brain.mode must be 'command' or 'http'")
        if self.brain_mode == "command" and not self.brain_command:
            problems.append("brain.command is required when brain.mode is 'command'")
        if self.brain_mode == "http" and not self.brain_url:
            problems.append("brain.url is required when brain.mode is 'http'")
        for s in self.allowed_senders:
            if not s.startswith("+"):
                problems.append(f"allowed_senders entry {s!r} must be E.164 (+15551234567)")
        # The brain gets a whole SMS thread and a 2-minute budget; a poll
        # interval under half a second is just noise against the bridge.
        if self.poll_interval < 0.5:
            problems.append("poll_interval_seconds must be >= 0.5")
        if self.max_reply_chars > 1600:
            problems.append("max_reply_chars must be <= 1600 (AgentCall's limit)")
        # A brain slower than the bridge's claim window gets its text redelivered
        # while it is still thinking, so the agent runs twice on one message and
        # you pay for both. The duplicate reply is suppressed (same
        # idempotencyKey), so this shows up as a mysterious cost, not a bug.
        if self.brain_timeout >= BRIDGE_VISIBILITY_SECONDS - 30:
            problems.append(
                f"brain.timeout_seconds ({self.brain_timeout:g}) is too close to "
                f"the bridge's {BRIDGE_VISIBILITY_SECONDS:g}s claim window; keep "
                f"it under {BRIDGE_VISIBILITY_SECONDS - 30:g} or slow replies get "
                f"redelivered and your agent runs twice on one text"
            )
        return problems

    def brain_argv(self) -> List[str]:
        if isinstance(self.brain_command, list):
            return [str(x) for x in self.brain_command]
        return ["/bin/sh", "-c", str(self.brain_command)]


def _pick(raw: Dict[str, Any], key: str, env: str, default: Any) -> Any:
    value = os.environ.get(env)
    if value not in (None, ""):
        return value
    if raw.get(key) not in (None, ""):
        return raw[key]
    return default


def _rstrip_slash(value: Any) -> str:
    return str(value or "").rstrip("/")


def _is_loopback(url: str) -> bool:
    """True for http://localhost:8787 and friends. The push key travels in a
    header, so plaintext is only acceptable when the bytes never leave the box —
    which is exactly the `wrangler dev` case."""
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1")


def _parse_allowed(from_file: Any, from_env: Optional[str]) -> List[str]:
    if from_env:
        return [s.strip() for s in from_env.split(",") if s.strip()]
    if isinstance(from_file, list):
        return [str(s).strip() for s in from_file if str(s).strip()]
    return []


def _default_state_dir() -> str:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "agentcall-sms-consumer")
    if os.access("/var/lib", os.W_OK):
        return "/var/lib/agentcall-sms-consumer"
    return os.path.join(os.path.expanduser("~"), ".agentcall-sms-consumer")


def load_config(path: Optional[str]) -> Config:
    raw: Dict[str, Any] = {}
    if path:
        if not os.path.exists(path):
            raise ConfigError(f"config file not found: {path}")
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ConfigError("config file must contain a JSON object")
    return Config(raw)


# ---------------------------------------------------------------------------
# http
# ---------------------------------------------------------------------------


class HttpResult:
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except Exception:
            return None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


def http_request(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    body: Optional[bytes] = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
) -> HttpResult:
    """Thin urllib wrapper that returns non-2xx as a result instead of raising.
    Only transport failures raise, because those are the ones worth retrying."""
    req_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=body, method=method, headers=req_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return HttpResult(resp.status, resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        payload = ""
        try:
            payload = exc.read().decode("utf-8", "replace")
        except Exception:
            pass
        return HttpResult(exc.code, payload)


def post_json(
    url: str, payload: Any, headers: Optional[Dict[str, str]] = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
) -> HttpResult:
    body = json.dumps(payload).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    return http_request(url, "POST", hdrs, body, timeout)


# ---------------------------------------------------------------------------
# bridge + AgentCall clients
# ---------------------------------------------------------------------------


class Bridge:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _headers(self) -> Dict[str, str]:
        return {"X-Hermes-Push-Key": self.cfg.hermes_push_key}

    def healthz(self) -> HttpResult:
        return http_request(
            f"{self.cfg.bridge_url}/healthz", "GET", timeout=self.cfg.http_timeout
        )

    def pull_sms(self) -> List[Dict[str, Any]]:
        res = post_json(
            f"{self.cfg.bridge_url}/hermes/pull-sms", {}, self._headers(),
            self.cfg.http_timeout,
        )
        if res.status == 401:
            raise BridgeAuthError("bridge rejected the push key (401)")
        if not res.ok:
            raise BridgeError(f"pull-sms returned {res.status}: {res.body[:200]}")
        data = res.json() or {}
        messages = data.get("messages")
        return [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []

    def probe_auth(self) -> HttpResult:
        """Non-destructive push-key check. An empty messageIds list is rejected
        with 400 *after* the auth check, so 400 means the key is good and 401
        means it is not.

        Deliberately not pull-sms: a pull CLAIMS every queued text for 300s, so
        running preflight against a live service would hide real inbound texts
        for five minutes."""
        return post_json(
            f"{self.cfg.bridge_url}/hermes/ack-sms", {"messageIds": []},
            self._headers(), self.cfg.http_timeout,
        )

    def probe_signature(self, signing_secret: str) -> Tuple[bool, str]:
        """Prove the consumer's SMS signing secret matches the Worker's.

        The only honest way to check: sign something and see whether the Worker
        accepts it. Reading the number's config cannot tell you — AgentCall
        redacts the stored secret to `hasSigningSecret: true`, which proves a
        secret exists and nothing about WHICH one. A stale secret there is
        invisible until a real text is silently rejected.

        Non-destructive: pushes a probe envelope, then acks it straight back
        out of the queue, so a running consumer never sees it.
        """
        nonce = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10))
        message_id = f"msg_sigprobe_{nonce}"
        envelope = {
            "message": {
                "id": message_id,
                "from": "+10000000000",
                "to": "+10000000000",
                "body": "signature probe",
                "receivedAt": now_iso(),
            },
            "conversation": {
                "id": f"{SELFTEST_CONVERSATION_PREFIX}sigprobe_{nonce}",
                "contactPhone": "+10000000000",
            },
            "context": {"channel": "sms", "numberId": "num_sigprobe",
                        "agentId": "sigprobe"},
        }
        try:
            res = self.push_sms(envelope, signing_secret)
        except Exception as exc:
            return False, str(exc)
        # Clean up regardless of the verdict; a queued probe would otherwise
        # wait for the consumer and show up as a stray selftest.
        try:
            self.ack_sms([message_id])
        except Exception:
            pass
        if res.status == 401:
            return False, "the Worker rejected the signature (401): this secret is not the Worker's"
        if not res.ok:
            return False, f"unexpected HTTP {res.status}: {res.body[:120]}"
        return True, "matches the Worker"

    def ack_sms(self, message_ids: List[str]) -> bool:
        if not message_ids:
            return True
        res = post_json(
            f"{self.cfg.bridge_url}/hermes/ack-sms", {"messageIds": message_ids},
            self._headers(), self.cfg.http_timeout,
        )
        if not res.ok:
            log("ack_failed", status=res.status, messageIds=message_ids,
                body=res.body[:200])
        return res.ok

    def push_sms(self, envelope: Dict[str, Any], signing_secret: str) -> HttpResult:
        """Sign and push an envelope the way AgentCall's relay worker does.
        Used by `selftest` only."""
        body = json.dumps(envelope).encode("utf-8")
        signature = "sha256=" + hmac.new(
            signing_secret.encode("utf-8"), body, hashlib.sha256
        ).hexdigest()
        return http_request(
            f"{self.cfg.bridge_url}/agentcall/sms",
            "POST",
            {
                "Content-Type": "application/json",
                "X-AgentCall-Signature": signature,
                "X-AgentCall-Event": "sms.relay",
            },
            body,
            self.cfg.http_timeout,
        )


class BridgeError(Exception):
    pass


class BridgeAuthError(BridgeError):
    pass


class AgentCall:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.agentcall_api_key}"}

    def get_conversation(self, conversation_id: str) -> HttpResult:
        return http_request(
            f"{self.cfg.agentcall_api_base}/v1/sms-conversations/"
            f"{urllib.parse.quote(conversation_id)}",
            "GET", self._headers(), timeout=self.cfg.http_timeout,
        )

    def reply(self, conversation_id: str, body: str, idempotency_key: str) -> HttpResult:
        return post_json(
            f"{self.cfg.agentcall_api_base}/v1/sms-conversations/"
            f"{urllib.parse.quote(conversation_id)}/reply",
            {"body": body, "idempotencyKey": idempotency_key},
            self._headers(),
            self.cfg.http_timeout,
        )

    def list_numbers(self) -> HttpResult:
        return http_request(
            f"{self.cfg.agentcall_api_base}/v1/numbers", "GET", self._headers(),
            timeout=self.cfg.http_timeout,
        )

    def get_inbound_config(self, number_id: str) -> HttpResult:
        return http_request(
            f"{self.cfg.agentcall_api_base}/v1/numbers/"
            f"{urllib.parse.quote(number_id)}/inbound-config",
            "GET", self._headers(), timeout=self.cfg.http_timeout,
        )

    def put_inbound_config(self, number_id: str, config: Dict[str, Any]) -> HttpResult:
        return post_json(
            f"{self.cfg.agentcall_api_base}/v1/numbers/"
            f"{urllib.parse.quote(number_id)}/inbound-config",
            config, self._headers(), self.cfg.http_timeout,
        )


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------


DEFAULT_COUNTS = {"claimed": 0, "replied": 0, "dropped": 0, "failed": 0}


class State:
    """Small JSON file next to the service. Two jobs: give `status` and the
    health endpoint something truthful to report, and remember which message
    ids we already answered so a redelivery after a failed ack cannot
    double-text anyone."""

    def __init__(self, state_dir: str):
        self.dir = state_dir
        self.path = os.path.join(state_dir, "state.json")
        self.data: Dict[str, Any] = {
            "version": VERSION,
            "started_at": None,
            "last_poll_at": None,
            "last_poll_ok": None,
            "last_message_at": None,
            "last_reply_at": None,
            "last_error": None,
            "consecutive_errors": 0,
            "counts": dict(DEFAULT_COUNTS),
            "replied_ids": [],
            "last_inbound": None,
        }
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                stored = json.load(fh)
            if isinstance(stored, dict):
                # Take everything. `status`, `verify`, and `selftest` all work by
                # constructing a State in a *second* process and reading what the
                # running loop wrote, so any key this drops is a key those
                # commands report wrongly — a healthy consumer showing "failing",
                # or a selftest that times out after the loop already succeeded.
                # A restarting loop overwrites started_at/last_poll_* immediately,
                # so nothing stale survives where it matters.
                self.data.update(stored)
                # Two exceptions that need their own shape enforced.
                counts = dict(DEFAULT_COUNTS)
                counts.update(stored.get("counts") or {})
                self.data["counts"] = counts
                ids = stored.get("replied_ids")
                self.data["replied_ids"] = (
                    [str(i) for i in ids][-MAX_REPLIED_IDS:]
                    if isinstance(ids, list) else []
                )
                self.data["version"] = VERSION
        except FileNotFoundError:
            pass
        except Exception as exc:  # corrupt state must not block startup
            log("state_load_failed", error=str(exc), path=self.path)

    def save(self) -> None:
        try:
            os.makedirs(self.dir, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh)
            os.replace(tmp, self.path)
        except Exception as exc:
            log("state_save_failed", error=str(exc), path=self.path)

    def already_replied(self, message_id: str) -> bool:
        return message_id in self.data["replied_ids"]

    def mark_replied(self, message_id: str) -> None:
        ids = self.data["replied_ids"]
        if message_id not in ids:
            ids.append(message_id)
        if len(ids) > MAX_REPLIED_IDS:
            del ids[: len(ids) - MAX_REPLIED_IDS]

    def bump(self, key: str) -> None:
        self.data["counts"][key] = self.data["counts"].get(key, 0) + 1


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_age_seconds(stamp: Optional[str]) -> Optional[float]:
    """Seconds since a now_iso() timestamp, or None if it is missing/unparseable.
    calendar.timegm, not time.mktime: the stamps are UTC and mktime would read
    them as local time, which quietly breaks the health check everywhere except
    UTC boxes."""
    if not stamp:
        return None
    try:
        parsed = time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None
    return max(0.0, time.time() - calendar.timegm(parsed))


# ---------------------------------------------------------------------------
# envelope handling
# ---------------------------------------------------------------------------


def envelope_fields(envelope: Dict[str, Any]) -> Tuple[str, str, str, str]:
    """(message_id, from_number, body, conversation_id) with tolerant lookups —
    the bridge stores whatever AgentCall posted, so never assume a shape."""
    message = envelope.get("message") if isinstance(envelope.get("message"), dict) else {}
    conversation = (
        envelope.get("conversation")
        if isinstance(envelope.get("conversation"), dict)
        else {}
    )
    message_id = str(message.get("id") or envelope.get("id") or "")
    sender = str(message.get("from") or "")
    body = str(message.get("body") or "")
    conversation_id = str(conversation.get("id") or "")
    return message_id, sender, body, conversation_id


def is_selftest(conversation_id: str) -> bool:
    return conversation_id.startswith(SELFTEST_CONVERSATION_PREFIX)


# ---------------------------------------------------------------------------
# brain
# ---------------------------------------------------------------------------


class BrainResult:
    def __init__(self, reply: Optional[str], skip: bool = False, error: Optional[str] = None):
        self.reply = reply
        self.skip = skip          # brain deliberately declined to answer
        self.error = error        # brain broke; retry later, do not ack

    @property
    def ok(self) -> bool:
        return self.error is None


def ask_brain(cfg: Config, payload: Dict[str, Any]) -> BrainResult:
    """Hand the text to the agent and get a reply back.

    command mode: JSON on stdin, reply text on stdout. Exit 0 = reply,
    exit 64 = deliberately no reply (acked, nothing sent), anything else =
    failure (not acked, redelivered after the claim expires).

    http mode: POST the same JSON. {"reply": "..."} or a bare text body.
    An explicit {"skip": true} is the exit-64 equivalent.
    """
    if cfg.brain_mode == "http":
        return _ask_brain_http(cfg, payload)
    return _ask_brain_command(cfg, payload)


def _ask_brain_command(cfg: Config, payload: Dict[str, Any]) -> BrainResult:
    argv = cfg.brain_argv()
    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=cfg.brain_timeout,
        )
    except subprocess.TimeoutExpired:
        return BrainResult(None, error=f"brain timed out after {cfg.brain_timeout}s")
    except FileNotFoundError:
        return BrainResult(None, error=f"brain command not found: {argv[0]}")
    except Exception as exc:
        return BrainResult(None, error=f"brain failed to start: {exc}")

    if proc.returncode == BRAIN_EXIT_NO_REPLY:
        return BrainResult(None, skip=True)
    if proc.returncode != 0:
        return BrainResult(
            None,
            error=f"brain exited {proc.returncode}: {(proc.stderr or '').strip()[:300]}",
        )
    reply = (proc.stdout or "").strip()
    if not reply:
        # A zero exit with no output is ambiguous. Treat it as an error rather
        # than silently swallowing a text: the claim expires and it comes back.
        return BrainResult(None, error="brain exited 0 but produced no reply text")
    return BrainResult(reply)


def _ask_brain_http(cfg: Config, payload: Dict[str, Any]) -> BrainResult:
    headers = {"Content-Type": "application/json"}
    headers.update(cfg.brain_headers or {})
    try:
        res = post_json(cfg.brain_url, payload, headers, cfg.brain_timeout)
    except Exception as exc:
        return BrainResult(None, error=f"brain request failed: {exc}")
    if not res.ok:
        return BrainResult(None, error=f"brain returned {res.status}: {res.body[:200]}")
    data = res.json()
    if isinstance(data, dict):
        if data.get("skip") is True:
            return BrainResult(None, skip=True)
        reply = data.get("reply")
        if isinstance(reply, str) and reply.strip():
            return BrainResult(reply.strip())
        return BrainResult(None, error="brain JSON had no non-empty 'reply'")
    text = (res.body or "").strip()
    if text:
        return BrainResult(text)
    return BrainResult(None, error="brain returned an empty body")


# ---------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------


class Consumer:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.bridge = Bridge(cfg)
        self.api = AgentCall(cfg)
        self.state = State(cfg.state_dir)
        self.stop = threading.Event()

    # -- one message ------------------------------------------------------

    def handle(self, envelope: Dict[str, Any]) -> Tuple[bool, str]:
        """Process one claimed envelope.

        Returns (ack, outcome). ack=False means "leave it claimed" — the
        visibility window expires and the bridge hands it back, which is the
        behaviour we want for anything transient.
        """
        message_id, sender, body, conversation_id = envelope_fields(envelope)

        if not message_id or not conversation_id:
            # Nothing we can do with it and it will never get better. Ack so it
            # does not wedge the queue, but log loudly.
            log("envelope_malformed", envelope_keys=sorted(envelope.keys()))
            return True, "malformed"

        if self.state.already_replied(message_id):
            # Redelivered because a previous ack failed. The reply already went
            # out; ack it now and send nothing.
            log("duplicate_skipped", messageId=message_id)
            return True, "duplicate"

        # Defence in depth. AgentCall already enforces allowedSenders on the
        # relay worker, but this consumer may be pointed at a number whose
        # allowlist was never set, and a personal agent should answer its owner
        # and nobody else.
        if self.cfg.allowed_senders and sender not in self.cfg.allowed_senders:
            log("sender_not_allowed", messageId=message_id, sender=_mask(sender))
            self.state.bump("dropped")
            return True, "sender_not_allowed"

        self.state.bump("claimed")
        self.state.data["last_message_at"] = now_iso()
        self.state.data["last_inbound"] = {
            "messageId": message_id,
            "from": _mask(sender),
            "body": body[:160],
            "at": now_iso(),
        }

        selftest = is_selftest(conversation_id)
        history = [] if selftest else self.fetch_history(conversation_id)

        payload = {
            "message": envelope.get("message"),
            "conversation": envelope.get("conversation"),
            "context": envelope.get("context"),
            "history": history,
            "selftest": selftest,
        }

        started = time.time()
        result = ask_brain(self.cfg, payload)
        think_ms = int((time.time() - started) * 1000)

        if not result.ok:
            log("brain_error", messageId=message_id, error=result.error,
                thinkMs=think_ms)
            self.state.bump("failed")
            return False, "brain_error"  # retry after the claim expires

        if result.skip:
            log("brain_skipped", messageId=message_id, thinkMs=think_ms)
            self.state.bump("dropped")
            return True, "skipped"

        reply_text = (result.reply or "")[: self.cfg.max_reply_chars]

        if selftest:
            # Never text anyone for a synthetic message: the conversation does
            # not exist. Probe the API instead so the test still proves the
            # credentials work end to end (404 = good key, unknown thread).
            probe = self.api.get_conversation(conversation_id)
            ok = probe.status == 404
            log("selftest_processed", messageId=message_id, thinkMs=think_ms,
                apiProbeStatus=probe.status, credentialsOk=ok,
                replyPreview=reply_text[:80])
            self.state.data["last_selftest"] = {
                "messageId": message_id,
                "at": now_iso(),
                "apiProbeStatus": probe.status,
                "credentialsOk": ok,
                "thinkMs": think_ms,
            }
            return True, "selftest"

        return self.send_reply(conversation_id, message_id, reply_text, think_ms)

    def send_reply(
        self, conversation_id: str, message_id: str, reply_text: str, think_ms: int
    ) -> Tuple[bool, str]:
        res = self.api.reply(conversation_id, reply_text, message_id)

        if res.ok:
            self.state.mark_replied(message_id)
            self.state.bump("replied")
            self.state.data["last_reply_at"] = now_iso()
            payload = res.json() or {}
            log("replied", messageId=message_id, conversationId=conversation_id,
                thinkMs=think_ms, chars=len(reply_text),
                status=payload.get("status"))
            return True, "replied"

        code = _error_code(res)

        # Permanent, and looping on it would be worse than dropping it:
        #   403 recipient_opted_out — TCPA, we must not text them again
        #   404 not found           — thread is gone
        #   400 invalid body        — our reply is unsendable as written
        if res.status in (400, 403, 404):
            log("reply_rejected", messageId=message_id, status=res.status, code=code,
                body=res.body[:200])
            self.state.bump("dropped")
            self.state.mark_replied(message_id)  # do not try again on redelivery
            return True, code or f"http_{res.status}"

        # 401/402/429/5xx and anything else: transient or operator-fixable.
        # Do not ack; the claim expires and we try again.
        log("reply_failed", messageId=message_id, status=res.status, code=code,
            body=res.body[:200])
        self.state.bump("failed")
        return False, code or f"http_{res.status}"

    def fetch_history(self, conversation_id: str) -> List[Dict[str, Any]]:
        """Best effort. A brain with no history still answers; a brain that
        waits on a hung API call does not."""
        try:
            res = self.api.get_conversation(conversation_id)
        except Exception as exc:
            log("history_fetch_failed", conversationId=conversation_id, error=str(exc))
            return []
        if not res.ok:
            log("history_unavailable", conversationId=conversation_id, status=res.status)
            return []
        data = res.json() or {}
        messages = data.get("messages")
        if not isinstance(messages, list):
            return []
        trimmed = messages[-self.cfg.history_messages :]
        return [
            {
                "direction": m.get("direction"),
                "body": m.get("body"),
                "createdAt": m.get("createdAt"),
            }
            for m in trimmed
            if isinstance(m, dict)
        ]

    # -- one poll ---------------------------------------------------------

    def poll_once(self) -> int:
        messages = self.bridge.pull_sms()
        self.state.data["last_poll_at"] = now_iso()
        self.state.data["last_poll_ok"] = True
        if not messages:
            return 0

        log("claimed", count=len(messages))
        to_ack: List[str] = []
        for envelope in messages:
            if self.stop.is_set():
                break
            try:
                ack, outcome = self.handle(envelope)
            except Exception as exc:  # one bad message must not kill the loop
                message_id, _, _, _ = envelope_fields(envelope)
                log("handle_crashed", messageId=message_id, error=str(exc))
                self.state.bump("failed")
                continue
            if ack:
                message_id, _, _, _ = envelope_fields(envelope)
                if message_id:
                    to_ack.append(message_id)
            _ = outcome

        if to_ack:
            self.bridge.ack_sms(to_ack)
        self.state.save()
        return len(messages)

    def run(self) -> int:
        problems = self.cfg.validate()
        if problems:
            for problem in problems:
                log("config_invalid", problem=problem)
            return 2

        self.state.data["started_at"] = now_iso()
        self.state.save()
        log("started", version=VERSION, bridge=self.cfg.bridge_url,
            brainMode=self.cfg.brain_mode, pollInterval=self.cfg.poll_interval,
            allowedSenders=len(self.cfg.allowed_senders), stateDir=self.cfg.state_dir)

        health = None
        if self.cfg.health_port:
            health = start_health_server(self.cfg, self.state)

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, lambda *_: self.stop.set())
            except (ValueError, AttributeError):
                pass  # not the main thread, or Windows without SIGTERM

        backoff = self.cfg.poll_interval
        last_saved = 0.0
        while not self.stop.is_set():
            try:
                self.poll_once()
                self.state.data["consecutive_errors"] = 0
                self.state.data["last_error"] = None
                backoff = self.cfg.poll_interval
                # An idle consumer polls every couple of seconds and writes
                # nothing, so `status` would show a last-poll timestamp from
                # whenever the last text arrived and look dead. Heartbeat the
                # file instead of writing it on every poll.
                if time.time() - last_saved >= STATE_HEARTBEAT_SECONDS:
                    self.state.save()
                    last_saved = time.time()
            except BridgeAuthError as exc:
                # The push key is wrong. Retrying every 2s just hammers the
                # bridge with 401s, and no amount of waiting fixes it.
                log("bridge_auth_failed", error=str(exc))
                self.state.data["last_error"] = str(exc)
                self.state.data["last_poll_ok"] = False
                self.state.save()
                if health:
                    health.shutdown()
                return 3
            except Exception as exc:
                errors = self.state.data.get("consecutive_errors", 0) + 1
                self.state.data["consecutive_errors"] = errors
                self.state.data["last_error"] = str(exc)
                self.state.data["last_poll_ok"] = False
                self.state.save()
                log("poll_failed", error=str(exc), consecutiveErrors=errors,
                    retryIn=round(backoff, 1))
                # Jitter so a fleet of consumers does not resynchronise into a
                # thundering herd against the bridge after a shared outage.
                self.stop.wait(backoff + random.uniform(0, backoff * 0.2))
                backoff = min(backoff * 2, BACKOFF_MAX_SECONDS)
                continue

            self.stop.wait(self.cfg.poll_interval)

        self.state.save()
        if health:
            health.shutdown()
        log("stopped", counts=self.state.data["counts"])
        return 0


def _error_code(res: HttpResult) -> str:
    data = res.json()
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            return error["code"]
    return ""


def _mask(phone: str) -> str:
    """Log the last 4 digits only. Inbound numbers are personal data and these
    logs end up in journald, Docker, and support tickets."""
    if len(phone) <= 4:
        return phone
    return "*" * (len(phone) - 4) + phone[-4:]


# ---------------------------------------------------------------------------
# health endpoint (for Docker / k8s probes)
# ---------------------------------------------------------------------------


def start_health_server(cfg: Config, state: State) -> HTTPServer:
    """GET /healthz -> 200 while polls are landing, 503 once they stop. Docker's
    healthcheck restarts the container on 503, which is the whole point: a
    consumer that is running but not polling is worse than one that is down,
    because nothing alerts."""
    stale_after = max(cfg.poll_interval * 3, 30.0) + cfg.brain_timeout

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
            if self.path.split("?")[0] not in ("/healthz", "/health", "/"):
                self.send_response(404)
                self.end_headers()
                return
            last = state.data.get("last_poll_at")
            healthy = False
            age = parse_age_seconds(last)
            if age is not None:
                healthy = (
                    age <= stale_after
                    and state.data.get("last_poll_ok") is not False
                )
            payload = json.dumps({
                "status": "ok" if healthy else "stale",
                "lastPollAt": last,
                "lastPollAgeSeconds": round(age, 1) if age is not None else None,
                "consecutiveErrors": state.data.get("consecutive_errors", 0),
                "counts": state.data.get("counts", {}),
                "version": VERSION,
            }).encode("utf-8")
            self.send_response(200 if healthy else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: Any) -> None:
            pass  # probe traffic would drown the real log

    server = HTTPServer((cfg.health_host, cfg.health_port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log("health_server_started", host=cfg.health_host, port=cfg.health_port)
    return server


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------


def cmd_run(cfg: Config, _args: argparse.Namespace) -> int:
    return Consumer(cfg).run()


def cmd_status(cfg: Config, args: argparse.Namespace) -> int:
    state = State(cfg.state_dir)
    if args.json:
        print(json.dumps(state.data, indent=2))
        return 0
    data = state.data
    counts = data.get("counts", {})
    print(f"agentcall-sms-consumer {VERSION}")
    print(f"  state file      {state.path}")
    print(f"  bridge          {cfg.bridge_url or '(unset)'}")
    print(f"  brain           {cfg.brain_mode or '(unset)'}")
    print(f"  started         {data.get('started_at') or '-'}")
    print(f"  last poll       {data.get('last_poll_at') or '-'}"
          f"  ({'ok' if data.get('last_poll_ok') else 'failing'})")
    print(f"  last inbound    {data.get('last_message_at') or '-'}")
    print(f"  last reply      {data.get('last_reply_at') or '-'}")
    print(f"  claimed/replied/dropped/failed  "
          f"{counts.get('claimed', 0)}/{counts.get('replied', 0)}/"
          f"{counts.get('dropped', 0)}/{counts.get('failed', 0)}")
    if data.get("consecutive_errors"):
        print(f"  consecutive errors {data['consecutive_errors']}")
    if data.get("last_error"):
        print(f"  last error      {data['last_error']}")
    return 0


def cmd_preflight(cfg: Config, args: argparse.Namespace) -> int:
    """Everything that can be checked without a real text going anywhere."""
    checks: List[Tuple[str, bool, str]] = []

    problems = cfg.validate()
    checks.append(("config", not problems, "; ".join(problems) or "valid"))

    if cfg.bridge_url:
        try:
            res = Bridge(cfg).healthz()
            checks.append(("bridge /healthz", res.ok, f"HTTP {res.status}"))
        except Exception as exc:
            checks.append(("bridge /healthz", False, str(exc)))

    if cfg.bridge_url and cfg.hermes_push_key:
        try:
            res = Bridge(cfg).probe_auth()
            ok = res.status == 400  # authorised, then rejected for the empty list
            detail = "authorised" if ok else (
                "push key rejected (401)" if res.status == 401
                else f"unexpected HTTP {res.status}: {res.body[:120]}"
            )
            checks.append(("bridge push key", ok, detail))
        except Exception as exc:
            checks.append(("bridge push key", False, str(exc)))

    # The check that would have caught the migration failure. Everything else
    # here can pass while the number holds a signing secret from an older
    # bridge, and the first symptom is a real text disappearing.
    if cfg.bridge_url and cfg.sms_signing_secret:
        ok, detail = Bridge(cfg).probe_signature(cfg.sms_signing_secret)
        checks.append(("SMS signing secret", ok, detail))
    elif cfg.bridge_url:
        checks.append((
            "SMS signing secret", False,
            "not set, so it cannot be verified. Set AGENTCALL_SMS_SIGNING_SECRET "
            "to the Worker's value; without it nothing checks that your number's "
            "stored secret still matches",
        ))

    if cfg.agentcall_api_key:
        res = AgentCall(cfg).list_numbers()
        detail = f"HTTP {res.status}"
        if res.ok:
            data = res.json() or {}
            numbers = data.get("numbers") if isinstance(data, dict) else None
            if isinstance(numbers, list):
                detail = f"{len(numbers)} number(s) on the account"
        checks.append(("AgentCall API key", res.ok, detail))

    if cfg.brain_mode in ("command", "http"):
        payload = {
            "message": {
                "id": "msg_preflight",
                "from": cfg.allowed_senders[0] if cfg.allowed_senders else "+10000000000",
                "to": "+10000000000",
                "body": args.probe,
                "receivedAt": now_iso(),
            },
            "conversation": {"id": SELFTEST_CONVERSATION_PREFIX + "preflight",
                             "contactPhone": "+10000000000"},
            "context": {"channel": "sms"},
            "history": [],
            "selftest": True,
            "preflight": True,
        }
        result = ask_brain(cfg, payload)
        if result.ok and result.skip:
            checks.append(("brain", True, "declined to answer (exit 64)"))
        elif result.ok:
            checks.append(("brain", True, f"replied {len(result.reply or '')} chars: "
                                          f"{(result.reply or '')[:60]!r}"))
        else:
            checks.append(("brain", False, result.error or "unknown error"))

    width = max(len(name) for name, _, _ in checks)
    failed = 0
    for name, ok, detail in checks:
        if not ok:
            failed += 1
        print(f"  [{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")
    print()
    print("preflight: " + ("all checks passed" if not failed else f"{failed} check(s) failed"))
    return 0 if not failed else 1


def cmd_selftest(cfg: Config, args: argparse.Namespace) -> int:
    """Push a signed synthetic text through the real bridge and wait for the
    running consumer to claim, think, and ack it.

    This exercises every hop except the carrier: HMAC signing, the Worker's
    queue, the push-key pull, your brain, and (via a 404 probe on a
    conversation that cannot exist) your AgentCall credentials. No SMS is sent
    and no real thread is touched.
    """
    if not cfg.sms_signing_secret:
        print("selftest needs the SMS signing secret so it can sign the way "
              "AgentCall does.")
        print("Set AGENTCALL_SMS_SIGNING_SECRET (or agentcall_sms_signing_secret "
              "in the config) to the same value as the Worker's "
              "AGENTCALL_SMS_SIGNING_SECRET / AGENTCALL_SIGNING_SECRET.")
        return 2

    nonce = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10))
    message_id = f"msg_selftest_{nonce}"
    conversation_id = f"{SELFTEST_CONVERSATION_PREFIX}{nonce}"
    sender = cfg.allowed_senders[0] if cfg.allowed_senders else "+10000000000"
    envelope = {
        "message": {
            "id": message_id,
            "from": sender,
            "to": "+10000000000",
            "body": args.body,
            "receivedAt": now_iso(),
        },
        "conversation": {"id": conversation_id, "contactPhone": sender},
        "context": {"channel": "sms", "numberId": "num_selftest",
                    "agentId": args.tenant or "selftest"},
    }

    bridge = Bridge(cfg)
    # A secret written with `wrangler secret put` seconds ago has not reached
    # every edge yet, so a 401 right after deploying is usually propagation
    # rather than a mismatch. Retry briefly before calling it wrong.
    deadline_push = time.time() + max(0.0, args.secret_wait)
    while True:
        res = bridge.push_sms(envelope, cfg.sms_signing_secret)
        if res.ok or res.status != 401 or time.time() >= deadline_push:
            break
        print("  ....   401 from the bridge, retrying while the Worker secret propagates")
        time.sleep(5)
    if not res.ok:
        print(f"  [FAIL] push to bridge          HTTP {res.status} {res.body[:200]}")
        if res.status == 401:
            print("         The signing secret does not match the Worker's.")
            print("         Fix by writing the SAME value to both sides:")
            print("           wrangler secret put AGENTCALL_SMS_SIGNING_SECRET   (in the bridge repo)")
            print("           agentcall_sms_consumer.py configure-number --number-id num_xxx \\")
            print("             --signing-secret <that same value>")
            print("         A number can report hasSigningSecret:true and still hold a stale one.")
        return 1
    print(f"  [PASS] push to bridge          {res.json()}")
    print(f"         messageId {message_id}")

    deadline = time.time() + args.timeout
    print(f"  ....   waiting up to {args.timeout}s for the consumer to claim and ack it")
    started = time.time()
    while time.time() < deadline:
        time.sleep(2)
        state = State(cfg.state_dir)
        last = state.data.get("last_selftest") or {}
        if last.get("messageId") == message_id:
            took = round(time.time() - started, 1)
            ok = bool(last.get("credentialsOk"))
            print(f"  [PASS] consumer processed it   {took}s, brain took "
                  f"{last.get('thinkMs')}ms")
            print(f"  [{'PASS' if ok else 'FAIL'}] AgentCall credentials   "
                  f"probe returned HTTP {last.get('apiProbeStatus')}"
                  f"{'' if ok else ' (expected 404; 401 means a bad API key)'}")
            print()
            print("selftest: " + ("the whole loop works, carrier aside"
                                  if ok else "the loop ran but the API key looks wrong"))
            return 0 if ok else 1

    print("  [FAIL] consumer processed it   timed out")
    print("         Is the service running? `agentcall-sms-consumer status` and "
          "`journalctl -u agentcall-sms-consumer -n 50`.")
    return 1


def cmd_verify(cfg: Config, args: argparse.Namespace) -> int:
    """The real end-to-end test: a human texts the number and this watches the
    text land, get answered, and come back. Nothing else proves the carrier
    leg, the 10DLC registration, and the number's relay config at once."""
    state_before = State(cfg.state_dir)
    baseline_reply = state_before.data.get("last_reply_at")
    baseline_inbound = state_before.data.get("last_message_at")

    number = args.number or "your AgentCall number"
    print(f"Text {number} now. Say anything.")
    if cfg.allowed_senders:
        print(f"Text from one of: {', '.join(cfg.allowed_senders)} "
              f"(the allowlist drops everyone else).")
    print(f"Watching for up to {args.timeout}s ...")
    print()

    deadline = time.time() + args.timeout
    started = time.time()
    seen_inbound = False
    while time.time() < deadline:
        time.sleep(2)
        state = State(cfg.state_dir)
        inbound_at = state.data.get("last_message_at")
        if not seen_inbound and inbound_at and inbound_at != baseline_inbound:
            seen_inbound = True
            last = state.data.get("last_inbound") or {}
            print(f"  [PASS] text reached the consumer   from {last.get('from')} "
                  f"after {round(time.time() - started, 1)}s")
            print(f"         {last.get('body', '')!r}")
        reply_at = state.data.get("last_reply_at")
        if reply_at and reply_at != baseline_reply:
            print(f"  [PASS] reply sent                  after "
                  f"{round(time.time() - started, 1)}s")
            print()
            print("verify: end to end works. Check your phone for the answer.")
            return 0

    if seen_inbound:
        print("  [FAIL] reply sent                  timed out after the text arrived")
        print("         The brain or the reply call is the problem. "
              "`agentcall-sms-consumer status` and check the log.")
    else:
        print("  [FAIL] text reached the consumer   nothing arrived")
        print("         Check, in order:")
        print("           1. the number is smsMode:'relay' with agentWebhook "
              "pointing at this bridge  (configure-number)")
        print("           2. the account is on Pro (relay is not processed on Free)")
        print("           3. your number is on the allowlist, if you set one")
        print("           4. the consumer is running  (status)")
    return 1


def cmd_configure_number(cfg: Config, args: argparse.Namespace) -> int:
    """Put a number into relay mode pointing at this bridge, without clobbering
    its voice config.

    POST /v1/numbers/:id/inbound-config replaces the whole inboundConfig, so
    read the current one first and merge. Stored webhook secrets survive an
    update that omits `signingSecret`, and the server re-injects the BYOK and
    premium-voice fields it manages, so a read-modify-write is safe.
    """
    api = AgentCall(cfg)
    number_id = args.number_id

    current = api.get_inbound_config(number_id)
    if current.status == 404:
        print(f"No number {number_id} on this account (or no API key access).")
        return 1
    if current.status in (401, 403):
        print(f"AgentCall rejected the API key (HTTP {current.status}).")
        return 1

    existing: Dict[str, Any] = {}
    if current.ok:
        data = current.json() or {}
        cfg_block = data.get("config") if isinstance(data, dict) else None
        if isinstance(cfg_block, dict):
            existing = dict(cfg_block)

    # Read-only fields the API returns but will not accept back. They are
    # stripped by validation anyway; dropping them keeps the diff honest.
    for read_only in ("premiumVoice", "hasByokKey"):
        existing.pop(read_only, None)
    for webhook_key in ("contextWebhook", "actionWebhook", "agentWebhook"):
        wh = existing.get(webhook_key)
        if isinstance(wh, dict):
            wh.pop("hasSigningSecret", None)

    payload: Dict[str, Any] = dict(existing)
    # Inbound config is voice-shaped: mode + systemPrompt are required even
    # when all you are changing is SMS.
    payload["mode"] = "ai"
    if not payload.get("systemPrompt"):
        if not args.system_prompt:
            print("This number has no inbound voice config yet, so the API needs a "
                  "systemPrompt for the voice side.")
            print("Re-run with --system-prompt \"...\" (it powers calls, not relay "
                  "texts).")
            return 2
        payload["systemPrompt"] = args.system_prompt
    elif args.system_prompt:
        payload["systemPrompt"] = args.system_prompt

    bridge_url = _rstrip_slash(args.bridge_url or cfg.bridge_url)
    if not bridge_url:
        print("Need a bridge URL: --bridge-url https://hermes.example.com "
              "(or set it in the config).")
        return 2

    payload["smsMode"] = "relay"
    # ALWAYS write the secret. Omitting it makes AgentCall keep whatever was
    # stored, and `hasSigningSecret: true` on the read only proves *a* secret
    # exists, never that it matches the Worker's. That is the migration trap:
    # a number configured against an older bridge keeps its stale secret, so
    # AgentCall happily accepts the text, signs with the old key, and the
    # Worker rejects the push with 401. The symptom is a text that vanishes
    # with a green config on both sides.
    #
    # Overwriting is safe and idempotent: the Worker and the number are meant
    # to hold the same value, and `selftest` proves they do.
    secret = args.signing_secret or cfg.sms_signing_secret
    agent_webhook: Dict[str, Any] = {"url": f"{bridge_url}/agentcall/sms"}
    if secret:
        agent_webhook["signingSecret"] = secret
    elif args.keep_secret:
        print("  [WARN] --keep-secret: leaving the stored signing secret in place.")
        print("         Nothing here has verified it matches the Worker. Run "
              "`selftest` before trusting this number.")
    else:
        print("A signing secret is required, even if this number already has one.")
        print("AgentCall cannot show you the stored secret, and a stored secret "
              "that does not match your Worker is exactly how texts silently")
        print("disappear. Re-run with --signing-secret <the Worker's "
              "AGENTCALL_SMS_SIGNING_SECRET>, or set it in the config/env.")
        print("If you genuinely want to keep the stored one unverified, pass "
              "--keep-secret.")
        return 2
    payload["agentWebhook"] = agent_webhook

    allow = args.allow if args.allow else cfg.allowed_senders
    if allow:
        payload["allowedSenders"] = allow
    elif args.allow_anyone:
        payload.pop("allowedSenders", None)

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    res = api.put_inbound_config(number_id, payload)
    if not res.ok:
        print(f"  [FAIL] configure  HTTP {res.status} {res.body[:400]}")
        return 1
    data = res.json() or {}
    saved = data.get("config") if isinstance(data, dict) else {}
    saved = saved if isinstance(saved, dict) else {}
    print(f"  [PASS] configure   {data.get('number')} ({number_id})")
    print(f"         smsMode        {saved.get('smsMode')}")
    print(f"         agentWebhook   {(saved.get('agentWebhook') or {}).get('url')}")
    print(f"         allowedSenders {saved.get('allowedSenders') or '(anyone)'}")
    if not allow:
        print()
        print("  Note: no allowlist. Anyone who texts this number reaches your "
              "agent. For a personal agent, pass --allow +1XXXXXXXXXX.")
    return 0


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentcall-sms-consumer",
        description="Deliver AgentCall relay texts to your own agent and send "
                    "its replies back in-thread.",
    )
    parser.add_argument("--config", default=os.environ.get("AGENTCALL_CONSUMER_CONFIG"),
                        help="path to config.json (env overrides always win)")
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("run", help="poll the bridge forever (what the service runs)")

    p_status = sub.add_parser("status", help="print the running consumer's state")
    p_status.add_argument("--json", action="store_true")

    p_pre = sub.add_parser("preflight",
                           help="check config, bridge, API key, and brain; sends nothing")
    p_pre.add_argument("--probe", default="preflight check, please reply with OK",
                       help="text handed to the brain for the dry run")

    p_self = sub.add_parser("selftest",
                            help="push a signed synthetic text through the real loop")
    p_self.add_argument("--body", default="selftest: reply with anything")
    p_self.add_argument("--tenant", default="",
                        help="agentId to queue under (default: selftest)")
    p_self.add_argument("--timeout", type=float, default=90.0)
    p_self.add_argument("--secret-wait", type=float, default=0.0,
                        help="seconds to keep retrying a 401 while a freshly "
                             "written Worker secret propagates")

    p_ver = sub.add_parser("verify",
                           help="live end-to-end: you text the number, this watches")
    p_ver.add_argument("--number", default="", help="the number to text, for the prompt")
    p_ver.add_argument("--timeout", type=float, default=180.0)

    p_cfg = sub.add_parser("configure-number",
                           help="put an AgentCall number into relay mode pointing here")
    p_cfg.add_argument("--number-id", required=True, help="num_...")
    p_cfg.add_argument("--bridge-url", default="", help="https://hermes.example.com")
    p_cfg.add_argument("--signing-secret", default="",
                       help="the Worker's AGENTCALL_SMS_SIGNING_SECRET")
    p_cfg.add_argument("--allow", action="append", default=[],
                       help="E.164 sender allowed to reach the agent (repeatable)")
    p_cfg.add_argument("--allow-anyone", action="store_true",
                       help="clear the allowlist (anyone who texts reaches the agent)")
    p_cfg.add_argument("--system-prompt", default="",
                       help="voice prompt, required only if the number has no config yet")
    p_cfg.add_argument("--keep-secret", action="store_true",
                       help="leave the stored signing secret alone (UNVERIFIED: "
                            "AgentCall cannot show it, and a stale one silently "
                            "drops every text)")
    p_cfg.add_argument("--dry-run", action="store_true",
                       help="print the config that would be saved")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1

    try:
        cfg = load_config(args.config)
    except (ConfigError, json.JSONDecodeError) as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    handlers = {
        "run": cmd_run,
        "status": cmd_status,
        "preflight": cmd_preflight,
        "selftest": cmd_selftest,
        "verify": cmd_verify,
        "configure-number": cmd_configure_number,
    }
    try:
        return handlers[args.command](cfg, args)
    except KeyboardInterrupt:
        return 130
    except socket.timeout:
        print("timed out talking to the bridge or the API", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
