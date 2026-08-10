#!/usr/bin/env python3
"""Unit tests for the AgentCall SMS relay consumer.

    python3 consumer/tests/test_consumer.py

Standard library only, like the consumer itself. The HTTP layer is stubbed at
`http_request`, so nothing here touches the network, the bridge, or AgentCall.

The tests that matter most are the ack-decision ones: acking a text we did not
answer loses it for good, and answering a redelivered text twice texts a human
twice. Everything else is recoverable.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import agentcall_sms_consumer as c  # noqa: E402


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def make_config(tmpdir: str, **overrides: Any) -> c.Config:
    raw: Dict[str, Any] = {
        "bridge_url": "https://hermes.example.com",
        "hermes_push_key": "hpk_test",
        "agentcall_api_key": "ac_live_test",
        "state_dir": tmpdir,
        "brain": {"mode": "command", "command": ["true"], "timeout_seconds": 5},
    }
    raw.update(overrides)
    return c.Config(raw)


def envelope(
    message_id: str = "msg_1",
    sender: str = "+15551234567",
    body: str = "hello",
    conversation_id: str = "smsconv_1",
) -> Dict[str, Any]:
    return {
        "message": {
            "id": message_id,
            "from": sender,
            "to": "+15559998888",
            "body": body,
            "receivedAt": "2026-08-10T12:00:00Z",
        },
        "conversation": {"id": conversation_id, "contactPhone": sender},
        "context": {"channel": "sms", "numberId": "num_1", "agentId": "agent_1"},
    }


class FakeHttp:
    """Records every request and answers from a queued list of responses."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.responses: Dict[str, c.HttpResult] = {}
        self.default = c.HttpResult(200, "{}")

    def on(self, needle: str, status: int, body: str = "{}") -> None:
        self.responses[needle] = c.HttpResult(status, body)

    def __call__(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        body: Optional[bytes] = None,
        timeout: float = 0,
    ) -> c.HttpResult:
        self.calls.append(
            {
                "url": url,
                "method": method,
                "headers": headers or {},
                "body": json.loads(body.decode()) if body else None,
            }
        )
        # Longest needle first, so a rule for ".../smsconv_1/reply" wins over
        # one for ".../smsconv_1" regardless of registration order.
        for needle in sorted(self.responses, key=len, reverse=True):
            if needle in url:
                return self.responses[needle]
        return self.default

    def urls(self) -> List[str]:
        return [call["url"] for call in self.calls]

    def hit(self, needle: str) -> bool:
        return any(needle in url for url in self.urls())


class ConsumerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.http = FakeHttp()
        self._real_http = c.http_request
        self._real_ask_brain = c.ask_brain
        c.http_request = self.http  # type: ignore[assignment]
        self._env_backup = dict(os.environ)
        for key in list(os.environ):
            if key.startswith(("AGENTCALL_", "HERMES_")):
                del os.environ[key]

    def tearDown(self) -> None:
        c.http_request = self._real_http  # type: ignore[assignment]
        # Several tests swap the brain for a stub; leaving it swapped would make
        # the real-subprocess tests silently pass against a fake.
        c.ask_brain = self._real_ask_brain  # type: ignore[assignment]
        os.environ.clear()
        os.environ.update(self._env_backup)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def consumer(self, brain_reply: Optional[str] = "sure thing", **overrides: Any) -> c.Consumer:
        cfg = make_config(self.tmp, **overrides)
        consumer = c.Consumer(cfg)
        if brain_reply is not None:
            self.stub_brain(c.BrainResult(brain_reply))
        return consumer

    def stub_brain(self, result: c.BrainResult) -> None:
        self.brain_calls: List[Dict[str, Any]] = getattr(self, "brain_calls", [])
        calls = self.brain_calls

        def fake(_cfg: c.Config, payload: Dict[str, Any]) -> c.BrainResult:
            calls.append(payload)
            return result

        c.ask_brain = fake  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


class TestConfig(ConsumerTestCase):
    def test_environment_overrides_the_file(self) -> None:
        os.environ["AGENTCALL_BRIDGE_URL"] = "https://from-env.example.com"
        cfg = make_config(self.tmp, bridge_url="https://from-file.example.com")
        self.assertEqual(cfg.bridge_url, "https://from-env.example.com")

    def test_trailing_slash_is_stripped(self) -> None:
        cfg = make_config(self.tmp, bridge_url="https://hermes.example.com/")
        self.assertEqual(cfg.bridge_url, "https://hermes.example.com")

    def test_allowed_senders_from_env_is_comma_separated(self) -> None:
        os.environ["AGENTCALL_ALLOWED_SENDERS"] = "+15551112222, +15553334444"
        cfg = make_config(self.tmp)
        self.assertEqual(cfg.allowed_senders, ["+15551112222", "+15553334444"])

    def test_validate_flags_missing_essentials(self) -> None:
        cfg = c.Config({})
        problems = " ".join(cfg.validate())
        self.assertIn("bridge_url", problems)
        self.assertIn("hermes_push_key", problems)
        self.assertIn("agentcall_api_key", problems)

    def test_validate_rejects_http_bridge(self) -> None:
        cfg = make_config(self.tmp, bridge_url="http://hermes.example.com")
        self.assertTrue(any("https" in p for p in cfg.validate()))

    def test_validate_rejects_reply_over_the_server_limit(self) -> None:
        cfg = make_config(self.tmp, max_reply_chars=2000)
        self.assertTrue(any("1600" in p for p in cfg.validate()))

    def test_validate_passes_on_a_complete_config(self) -> None:
        self.assertEqual(make_config(self.tmp).validate(), [])

    def test_validate_rejects_a_brain_slower_than_the_claim_window(self) -> None:
        # Past this, the bridge redelivers while the brain is still thinking and
        # the agent runs twice on one text. The duplicate reply is suppressed by
        # the idempotency key, so it surfaces as cost, not as a visible bug.
        cfg = make_config(self.tmp, brain={"mode": "command", "command": ["true"],
                                           "timeout_seconds": 280})
        self.assertTrue(any("claim window" in p for p in cfg.validate()))

    def test_health_binds_loopback_unless_told_otherwise(self) -> None:
        self.assertEqual(make_config(self.tmp).health_host, "127.0.0.1")
        os.environ["AGENTCALL_HEALTH_HOST"] = "0.0.0.0"
        self.assertEqual(make_config(self.tmp).health_host, "0.0.0.0")

    def test_brain_argv_wraps_a_string_command_in_a_shell(self) -> None:
        cfg = make_config(self.tmp, brain={"mode": "command", "command": "echo hi"})
        self.assertEqual(cfg.brain_argv(), ["/bin/sh", "-c", "echo hi"])

    def test_brain_argv_passes_a_list_through(self) -> None:
        cfg = make_config(self.tmp, brain={"mode": "command", "command": ["/x/y", "-z"]})
        self.assertEqual(cfg.brain_argv(), ["/x/y", "-z"])


# ---------------------------------------------------------------------------
# envelope parsing
# ---------------------------------------------------------------------------


class TestEnvelope(ConsumerTestCase):
    def test_reads_the_documented_shape(self) -> None:
        self.assertEqual(
            c.envelope_fields(envelope()),
            ("msg_1", "+15551234567", "hello", "smsconv_1"),
        )

    def test_tolerates_a_root_level_id(self) -> None:
        message_id, _, _, _ = c.envelope_fields({"id": "msg_root"})
        self.assertEqual(message_id, "msg_root")

    def test_missing_pieces_come_back_empty_not_raising(self) -> None:
        self.assertEqual(c.envelope_fields({}), ("", "", "", ""))

    def test_selftest_conversations_are_recognised(self) -> None:
        self.assertTrue(c.is_selftest("smsconv_selftest_abc"))
        self.assertFalse(c.is_selftest("smsconv_real"))


# ---------------------------------------------------------------------------
# the ack decision — the part that loses or duplicates texts if it is wrong
# ---------------------------------------------------------------------------


class TestHandle(ConsumerTestCase):
    def test_successful_reply_is_acked_and_sent_in_thread(self) -> None:
        consumer = self.consumer()
        ack, outcome = consumer.handle(envelope())
        self.assertTrue(ack)
        self.assertEqual(outcome, "replied")
        reply_calls = [x for x in self.http.calls if x["url"].endswith("/reply")]
        self.assertEqual(len(reply_calls), 1)
        self.assertEqual(reply_calls[0]["body"]["body"], "sure thing")

    def test_reply_is_idempotent_on_the_message_id(self) -> None:
        # The server dedups on (agent, idempotencyKey) for 24h, so a redelivery
        # that races our local replied-set still cannot double-text.
        consumer = self.consumer()
        consumer.handle(envelope(message_id="msg_42"))
        reply = [x for x in self.http.calls if x["url"].endswith("/reply")][0]
        self.assertEqual(reply["body"]["idempotencyKey"], "msg_42")

    def test_brain_failure_is_not_acked_so_the_text_comes_back(self) -> None:
        consumer = self.consumer(brain_reply=None)
        self.stub_brain(c.BrainResult(None, error="agent is down"))
        ack, outcome = consumer.handle(envelope())
        self.assertFalse(ack)
        self.assertEqual(outcome, "brain_error")
        self.assertFalse(self.http.hit("/reply"))

    def test_server_error_on_reply_is_not_acked(self) -> None:
        consumer = self.consumer()
        self.http.on("/reply", 500, '{"error":{"code":"internal"}}')
        ack, _ = consumer.handle(envelope())
        self.assertFalse(ack)

    def test_rate_limit_on_reply_is_not_acked(self) -> None:
        consumer = self.consumer()
        self.http.on("/reply", 429, '{"error":{"code":"rate_limited"}}')
        ack, _ = consumer.handle(envelope())
        self.assertFalse(ack)

    def test_opted_out_recipient_is_acked_and_never_retried(self) -> None:
        # TCPA: they sent STOP. Retrying forever would be both useless and
        # exactly the behaviour the opt-out exists to prevent.
        consumer = self.consumer()
        self.http.on("/reply", 403, '{"error":{"code":"recipient_opted_out"}}')
        ack, outcome = consumer.handle(envelope())
        self.assertTrue(ack)
        self.assertEqual(outcome, "recipient_opted_out")
        self.assertTrue(consumer.state.already_replied("msg_1"))

    def test_missing_conversation_is_acked(self) -> None:
        consumer = self.consumer()
        self.http.on("/reply", 404, '{"error":{"code":"sms_conversation_not_found"}}')
        ack, _ = consumer.handle(envelope())
        self.assertTrue(ack)

    def test_redelivery_after_a_failed_ack_does_not_text_twice(self) -> None:
        consumer = self.consumer()
        consumer.handle(envelope(message_id="msg_dup"))
        self.assertTrue(self.http.hit("/reply"))
        self.http.calls.clear()

        ack, outcome = consumer.handle(envelope(message_id="msg_dup"))
        self.assertTrue(ack)
        self.assertEqual(outcome, "duplicate")
        self.assertFalse(self.http.hit("/reply"))

    def test_the_replied_set_survives_a_restart(self) -> None:
        consumer = self.consumer()
        consumer.handle(envelope(message_id="msg_persist"))
        consumer.state.save()

        restarted = self.consumer()
        self.http.calls.clear()
        ack, outcome = restarted.handle(envelope(message_id="msg_persist"))
        self.assertTrue(ack)
        self.assertEqual(outcome, "duplicate")
        self.assertFalse(self.http.hit("/reply"))

    def test_sender_not_on_the_allowlist_is_dropped_without_reaching_the_brain(self) -> None:
        consumer = self.consumer(allowed_senders=["+15550001111"])
        self.brain_calls = []
        ack, outcome = consumer.handle(envelope(sender="+15559998888"))
        self.assertTrue(ack)
        self.assertEqual(outcome, "sender_not_allowed")
        self.assertEqual(self.brain_calls, [])
        self.assertFalse(self.http.hit("/reply"))

    def test_allowlisted_sender_gets_through(self) -> None:
        consumer = self.consumer(allowed_senders=["+15551234567"])
        ack, outcome = consumer.handle(envelope(sender="+15551234567"))
        self.assertTrue(ack)
        self.assertEqual(outcome, "replied")

    def test_brain_declining_acks_without_sending(self) -> None:
        consumer = self.consumer(brain_reply=None)
        self.stub_brain(c.BrainResult(None, skip=True))
        ack, outcome = consumer.handle(envelope())
        self.assertTrue(ack)
        self.assertEqual(outcome, "skipped")
        self.assertFalse(self.http.hit("/reply"))

    def test_malformed_envelope_is_acked_rather_than_wedging_the_queue(self) -> None:
        consumer = self.consumer()
        ack, outcome = consumer.handle({"nonsense": True})
        self.assertTrue(ack)
        self.assertEqual(outcome, "malformed")

    def test_reply_is_truncated_to_the_configured_limit(self) -> None:
        consumer = self.consumer(brain_reply=None, max_reply_chars=20)
        self.stub_brain(c.BrainResult("x" * 500))
        consumer.handle(envelope())
        reply = [x for x in self.http.calls if x["url"].endswith("/reply")][0]
        self.assertEqual(len(reply["body"]["body"]), 20)

    def test_history_is_fetched_and_handed_to_the_brain(self) -> None:
        consumer = self.consumer()
        self.brain_calls = []
        self.stub_brain(c.BrainResult("ok"))
        self.http.on(
            "/v1/sms-conversations/smsconv_1",
            200,
            json.dumps({"messages": [
                {"direction": "inbound", "body": "first", "createdAt": "t1"},
                {"direction": "outbound", "body": "second", "createdAt": "t2"},
            ]}),
        )
        consumer.handle(envelope())
        self.assertEqual(len(self.brain_calls[0]["history"]), 2)
        self.assertEqual(self.brain_calls[0]["history"][0]["body"], "first")

    def test_unavailable_history_still_lets_the_reply_happen(self) -> None:
        consumer = self.consumer()
        self.http.on("/v1/sms-conversations/smsconv_1", 500, "{}")
        # The reply URL contains the history URL, so name it in full or the
        # longest-match rule hands the reply the history's 500.
        self.http.on("/v1/sms-conversations/smsconv_1/reply", 200, '{"status":"sent"}')
        ack, outcome = consumer.handle(envelope())
        self.assertTrue(ack)
        self.assertEqual(outcome, "replied")


class TestSelftestPath(ConsumerTestCase):
    def test_synthetic_message_never_calls_the_reply_endpoint(self) -> None:
        # A selftest conversation does not exist. If this ever POSTed a reply we
        # would be one server-side bug away from texting a stranger.
        consumer = self.consumer()
        self.http.on("/v1/sms-conversations/", 404, '{"error":{"code":"not_found"}}')
        ack, outcome = consumer.handle(
            envelope(conversation_id="smsconv_selftest_abc123")
        )
        self.assertTrue(ack)
        self.assertEqual(outcome, "selftest")
        self.assertFalse(self.http.hit("/reply"))

    def test_404_on_the_probe_means_the_api_key_is_good(self) -> None:
        consumer = self.consumer()
        self.http.on("/v1/sms-conversations/", 404, "{}")
        consumer.handle(envelope(conversation_id="smsconv_selftest_abc123"))
        self.assertTrue(consumer.state.data["last_selftest"]["credentialsOk"])

    def test_401_on_the_probe_means_the_api_key_is_bad(self) -> None:
        consumer = self.consumer()
        self.http.on("/v1/sms-conversations/", 401, "{}")
        consumer.handle(envelope(conversation_id="smsconv_selftest_abc123"))
        self.assertFalse(consumer.state.data["last_selftest"]["credentialsOk"])


# ---------------------------------------------------------------------------
# polling
# ---------------------------------------------------------------------------


class TestPolling(ConsumerTestCase):
    def test_only_finished_messages_are_acked(self) -> None:
        consumer = self.consumer(brain_reply=None)

        results = {"msg_ok": c.BrainResult("done"), "msg_bad": c.BrainResult(None, error="boom")}

        def fake(_cfg: c.Config, payload: Dict[str, Any]) -> c.BrainResult:
            return results[payload["message"]["id"]]

        c.ask_brain = fake  # type: ignore[assignment]
        self.http.on("/hermes/pull-sms", 200, json.dumps({
            "messages": [envelope("msg_ok"), envelope("msg_bad")],
        }))
        consumer.poll_once()

        acks = [x for x in self.http.calls if "/ack-sms" in x["url"]]
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["body"]["messageIds"], ["msg_ok"])

    def test_one_crashing_message_does_not_stop_the_others(self) -> None:
        consumer = self.consumer(brain_reply=None)

        def fake(_cfg: c.Config, payload: Dict[str, Any]) -> c.BrainResult:
            if payload["message"]["id"] == "msg_boom":
                raise RuntimeError("brain exploded in an unexpected way")
            return c.BrainResult("fine")

        c.ask_brain = fake  # type: ignore[assignment]
        self.http.on("/hermes/pull-sms", 200, json.dumps({
            "messages": [envelope("msg_boom"), envelope("msg_fine")],
        }))
        consumer.poll_once()

        acks = [x for x in self.http.calls if "/ack-sms" in x["url"]]
        self.assertEqual(acks[0]["body"]["messageIds"], ["msg_fine"])

    def test_empty_queue_acks_nothing(self) -> None:
        consumer = self.consumer()
        self.http.on("/hermes/pull-sms", 200, '{"messages":[],"count":0}')
        self.assertEqual(consumer.poll_once(), 0)
        self.assertFalse(self.http.hit("/ack-sms"))

    def test_a_401_from_the_bridge_is_reported_as_an_auth_error(self) -> None:
        consumer = self.consumer()
        self.http.on("/hermes/pull-sms", 401, '{"error":"unauthorized"}')
        with self.assertRaises(c.BridgeAuthError):
            consumer.poll_once()

    def test_pull_sends_the_push_key(self) -> None:
        consumer = self.consumer()
        self.http.on("/hermes/pull-sms", 200, '{"messages":[]}')
        consumer.poll_once()
        pull = [x for x in self.http.calls if "/pull-sms" in x["url"]][0]
        self.assertEqual(pull["headers"]["X-Hermes-Push-Key"], "hpk_test")

    def test_every_request_sends_a_non_python_user_agent(self) -> None:
        # Cloudflare 403s Python's stdlib User-Agent on this bridge (Error 1010)
        # and the failure is invisible: polls fail, the queue just grows.
        result = self._real_http.__globals__  # sanity: we stubbed the right thing
        self.assertIn("USER_AGENT", result)
        self.assertNotIn("urllib", c.USER_AGENT.lower())
        self.assertTrue(c.USER_AGENT.startswith("agentcall-sms-consumer/"))


class TestBridgeProbe(ConsumerTestCase):
    def test_auth_probe_never_claims_queued_texts(self) -> None:
        # preflight must not use pull-sms: a pull hides every queued text for
        # 300s, so checking a healthy service would delay real replies.
        bridge = c.Bridge(make_config(self.tmp))
        self.http.on("/hermes/ack-sms", 400, '{"error":"messageIds_required"}')
        result = bridge.probe_auth()
        self.assertEqual(result.status, 400)
        self.assertFalse(self.http.hit("/pull-sms"))


# ---------------------------------------------------------------------------
# brain contract
# ---------------------------------------------------------------------------


class TestBrainCommand(unittest.TestCase):
    """Exercises the real subprocess path, not a stub."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        # In production a string command is run through /bin/sh. Here we resolve
        # whatever POSIX shell exists so these run on a dev box too, instead of
        # skipping and leaving the real subprocess path unverified.
        self.sh = shutil.which("sh") or ("/bin/sh" if os.path.exists("/bin/sh") else "")
        if not self.sh:
            self.skipTest("no POSIX shell available for command brains")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cfg(self, command: Any) -> c.Config:
        if isinstance(command, str):
            command = [self.sh, "-c", command]
        return c.Config({
            "bridge_url": "https://hermes.example.com",
            "hermes_push_key": "k",
            "agentcall_api_key": "a",
            "state_dir": self.tmp,
            "brain": {"mode": "command", "command": command, "timeout_seconds": 10},
        })

    def test_stdout_becomes_the_reply(self) -> None:
        result = c.ask_brain(self.cfg("printf 'hello back'"), {"message": {}})
        self.assertEqual(result.reply, "hello back")
        self.assertTrue(result.ok)

    def test_exit_64_means_deliberately_no_reply(self) -> None:
        result = c.ask_brain(self.cfg("exit 64"), {"message": {}})
        self.assertTrue(result.skip)
        self.assertTrue(result.ok)

    def test_nonzero_exit_is_an_error(self) -> None:
        result = c.ask_brain(self.cfg("echo broke >&2; exit 3"), {"message": {}})
        self.assertFalse(result.ok)
        self.assertIn("exited 3", result.error or "")

    def test_exit_zero_with_no_output_is_an_error_not_a_silent_drop(self) -> None:
        result = c.ask_brain(self.cfg("true"), {"message": {}})
        self.assertFalse(result.ok)

    def test_timeout_is_an_error(self) -> None:
        cfg = self.cfg("sleep 5")
        cfg.brain_timeout = 0.3
        result = c.ask_brain(cfg, {"message": {}})
        self.assertFalse(result.ok)
        self.assertIn("timed out", result.error or "")

    def test_missing_command_is_an_error(self) -> None:
        result = c.ask_brain(self.cfg(["/nonexistent/brain"]), {"message": {}})
        self.assertFalse(result.ok)
        self.assertIn("not found", result.error or "")

    def test_the_payload_reaches_the_brain_on_stdin(self) -> None:
        cfg = self.cfg("grep -q 'the payload' && printf 'saw it'")
        result = c.ask_brain(cfg, envelope(body="the payload"))
        self.assertEqual(result.reply, "saw it")

    def test_the_shipped_echo_brain_works(self) -> None:
        script = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "brains", "echo_brain.sh"
        )
        result = c.ask_brain(self.cfg([self.sh, script]), envelope(body="ping"))
        self.assertEqual(result.reply, "Echo: ping")


class TestBrainHttp(ConsumerTestCase):
    def cfg(self) -> c.Config:
        return make_config(
            self.tmp, brain={"mode": "http", "url": "http://127.0.0.1:9/x",
                             "timeout_seconds": 5}
        )

    def test_json_reply_field(self) -> None:
        self.http.default = c.HttpResult(200, '{"reply":"from http"}')
        self.assertEqual(c.ask_brain(self.cfg(), {}).reply, "from http")

    def test_plain_text_body(self) -> None:
        self.http.default = c.HttpResult(200, "bare text reply")
        self.assertEqual(c.ask_brain(self.cfg(), {}).reply, "bare text reply")

    def test_skip_flag(self) -> None:
        self.http.default = c.HttpResult(200, '{"skip":true}')
        self.assertTrue(c.ask_brain(self.cfg(), {}).skip)

    def test_non_2xx_is_an_error(self) -> None:
        self.http.default = c.HttpResult(502, "bad gateway")
        self.assertFalse(c.ask_brain(self.cfg(), {}).ok)

    def test_mode_is_inferred_from_a_url(self) -> None:
        cfg = make_config(self.tmp, brain={"url": "http://127.0.0.1:9/x"})
        self.assertEqual(cfg.brain_mode, "http")


# ---------------------------------------------------------------------------
# odds and ends
# ---------------------------------------------------------------------------


class TestMisc(ConsumerTestCase):
    def test_phone_numbers_are_masked_in_logs(self) -> None:
        self.assertEqual(c._mask("+15551234567"), "********4567")
        self.assertEqual(c._mask("+123"), "+123")

    def test_age_is_computed_in_utc_not_local_time(self) -> None:
        # time.mktime would read the UTC stamp as local time and report an age
        # off by the timezone offset, which breaks the health check everywhere
        # except UTC boxes.
        age = c.parse_age_seconds(c.now_iso())
        self.assertIsNotNone(age)
        self.assertLess(age or 999, 5)

    def test_age_of_an_unparseable_stamp_is_none(self) -> None:
        self.assertIsNone(c.parse_age_seconds("not a timestamp"))
        self.assertIsNone(c.parse_age_seconds(None))

    def test_error_code_is_pulled_out_of_the_api_error_envelope(self) -> None:
        res = c.HttpResult(403, '{"error":{"code":"recipient_opted_out"}}')
        self.assertEqual(c._error_code(res), "recipient_opted_out")
        self.assertEqual(c._error_code(c.HttpResult(500, "not json")), "")

    def test_replied_set_is_bounded(self) -> None:
        state = c.State(self.tmp)
        for i in range(c.MAX_REPLIED_IDS + 50):
            state.mark_replied(f"msg_{i}")
        self.assertEqual(len(state.data["replied_ids"]), c.MAX_REPLIED_IDS)
        self.assertTrue(state.already_replied(f"msg_{c.MAX_REPLIED_IDS + 49}"))

    def test_a_second_process_reads_back_everything_the_loop_wrote(self) -> None:
        # status, verify, and selftest all run in a separate process and learn
        # what happened by re-reading this file. A key that does not survive the
        # round trip makes a healthy consumer report as failing, or a selftest
        # time out after the loop already succeeded. Both happened.
        writer = c.State(self.tmp)
        writer.data["started_at"] = "2026-08-10T00:00:00Z"
        writer.data["last_poll_at"] = "2026-08-10T00:00:05Z"
        writer.data["last_poll_ok"] = True
        writer.data["last_selftest"] = {"messageId": "msg_st", "credentialsOk": True}
        writer.data["counts"]["replied"] = 7
        writer.save()

        reader = c.State(self.tmp)
        self.assertEqual(reader.data["started_at"], "2026-08-10T00:00:00Z")
        self.assertEqual(reader.data["last_poll_at"], "2026-08-10T00:00:05Z")
        self.assertTrue(reader.data["last_poll_ok"])
        self.assertEqual(reader.data["last_selftest"]["messageId"], "msg_st")
        self.assertEqual(reader.data["counts"]["replied"], 7)

    def test_a_state_file_missing_counters_still_loads_all_of_them(self) -> None:
        with open(os.path.join(self.tmp, "state.json"), "w", encoding="utf-8") as fh:
            json.dump({"counts": {"replied": 3}}, fh)
        state = c.State(self.tmp)
        self.assertEqual(state.data["counts"], {"claimed": 0, "replied": 3,
                                                "dropped": 0, "failed": 0})

    def test_corrupt_state_file_does_not_block_startup(self) -> None:
        with open(os.path.join(self.tmp, "state.json"), "w", encoding="utf-8") as fh:
            fh.write("{not json")
        state = c.State(self.tmp)
        self.assertEqual(state.data["counts"]["replied"], 0)

    def test_selftest_signature_matches_the_worker(self) -> None:
        # Same construction as verifyHmacSignature in src/index.ts:
        # sha256= + hex HMAC-SHA256 of the exact bytes posted.
        import hashlib
        import hmac

        bridge = c.Bridge(make_config(self.tmp))
        self.http.default = c.HttpResult(200, '{"status":"queued"}')
        bridge.push_sms({"message": {"id": "msg_x"}}, "s3cret-at-least-16-chars")

        call = self.http.calls[-1]
        expected_body = json.dumps({"message": {"id": "msg_x"}}).encode()
        expected = "sha256=" + hmac.new(
            b"s3cret-at-least-16-chars", expected_body, hashlib.sha256
        ).hexdigest()
        self.assertEqual(call["headers"]["X-AgentCall-Signature"], expected)
        self.assertEqual(call["headers"]["X-AgentCall-Event"], "sms.relay")


if __name__ == "__main__":
    unittest.main(verbosity=2)
