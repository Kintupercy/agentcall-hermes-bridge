#!/usr/bin/env python3
"""Tests for the Hermes brain adapter.

    python3 consumer/tests/test_hermes_brain.py

No network, no real agent. The HTTP transport is exercised against a real
localhost server so the request/response handling is genuinely tested rather
than mocked into agreement.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "brains"))

import hermes_brain as hb  # noqa: E402

BRAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "brains",
                     "hermes_brain.py")


def payload(body="what's critical this week?", history=None, selftest=False):
    return {
        "message": {"id": "msg_1", "from": "+15551234567", "to": "+15559998888",
                    "body": body, "receivedAt": "2026-08-10T12:00:00Z"},
        "conversation": {"id": "smsconv_abc", "contactPhone": "+15551234567"},
        "context": {"channel": "sms", "numberId": "num_1", "agentId": "agent_1"},
        "history": history or [],
        "selftest": selftest,
    }


class FakeAgent(BaseHTTPRequestHandler):
    """Echoes back whatever reply the test parked on the server."""
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.server.last_request = json.loads(self.rfile.read(n) or b"{}")
        body = json.dumps(self.server.reply).encode() if isinstance(self.server.reply, (dict, list)) \
            else str(self.server.reply).encode()
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class HttpTransportCase(unittest.TestCase):
    def setUp(self):
        self.srv = HTTPServer(("127.0.0.1", 0), FakeAgent)
        self.srv.reply = {"reply": "on it"}
        self.srv.status = 200
        self.srv.last_request = None
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}/chat"
        for k in list(os.environ):
            if k.startswith("HERMES_"):
                del os.environ[k]

    def tearDown(self):
        self.srv.shutdown()

    def cfg(self, **over):
        raw = {"transport": "http", "url": self.url, "timeout": 10}
        raw.update(over)
        return hb.Config(raw)

    def run_brain(self, data, env=None):
        e = dict(os.environ)
        e.update({"HERMES_TRANSPORT": "http", "HERMES_URL": self.url,
                  "HERMES_TIMEOUT": "10"})
        e.update(env or {})
        p = subprocess.run([sys.executable, BRAIN], input=json.dumps(data),
                           capture_output=True, text=True, env=e, timeout=30)
        return p

    def test_reply_reaches_stdout_and_exits_zero(self):
        p = self.run_brain(payload())
        self.assertEqual(p.returncode, hb.EXIT_REPLY)
        self.assertEqual(p.stdout, "on it")

    def test_the_thread_maps_to_a_stable_session(self):
        # A follow-up text must continue the same conversation, not open a cold
        # one. Same conversation id in, same session id out.
        self.run_brain(payload())
        first = self.srv.last_request["session"]
        self.run_brain(payload(body="and tomorrow?"))
        self.assertEqual(self.srv.last_request["session"], first)
        self.assertIn("smsconv_abc", first)

    def test_history_is_included_so_the_reply_continues_the_thread(self):
        self.run_brain(payload(history=[
            {"direction": "inbound", "body": "did the invoice go out?"},
            {"direction": "outbound", "body": "yes, Tuesday"},
        ]))
        prompt = self.srv.last_request["message"]
        self.assertIn("did the invoice go out?", prompt)
        self.assertIn("yes, Tuesday", prompt)

    def test_sms_safe_profile_tells_the_agent_the_channel_is_untrusted(self):
        self.run_brain(payload())          # sms-safe is the default
        prompt = self.srv.last_request["message"]
        self.assertIn("untrusted", prompt.lower())
        self.assertIn("caller ID", prompt)

    def test_full_profile_drops_the_restriction_only_when_asked(self):
        # Both switches, because one alone is refused (see ConfigCase).
        self.run_brain(payload(), env={"HERMES_PROFILE": "full",
                                       "HERMES_ALLOW_FULL_SMS": "1"})
        self.assertIsNotNone(self.srv.last_request)
        self.assertNotIn("untrusted", self.srv.last_request["message"].lower())

    def test_agent_error_is_a_failure_so_the_text_is_retried(self):
        self.srv.status = 500
        self.srv.reply = {"error": "boom"}
        p = self.run_brain(payload())
        self.assertEqual(p.returncode, hb.EXIT_FAIL)
        self.assertEqual(p.stdout, "")

    def test_empty_reply_is_a_failure_not_silent_success(self):
        self.srv.reply = {"reply": "   "}
        p = self.run_brain(payload())
        self.assertEqual(p.returncode, hb.EXIT_FAIL)

    def test_selftest_never_reaches_the_agent(self):
        p = self.run_brain(payload(selftest=True))
        self.assertEqual(p.returncode, hb.EXIT_REPLY)
        self.assertIsNone(self.srv.last_request)

    def test_unreachable_agent_fails_cleanly(self):
        p = self.run_brain(payload(), env={"HERMES_URL": "http://127.0.0.1:1/none"})
        self.assertEqual(p.returncode, hb.EXIT_FAIL)
        self.assertIn("could not reach", p.stderr)

    def test_a_bad_target_fails_rather_than_answering(self):
        # Note: "no transport at all" is NOT reproducible as a subprocess on a
        # machine that has hermes installed, because autodetection legitimately
        # finds it. That case is asserted at the Config level instead.
        p = self.run_brain(payload(), env={
            "HERMES_TRANSPORT": "hermes", "HERMES_BIN": "/nonexistent/hermes"})
        self.assertEqual(p.returncode, hb.EXIT_FAIL)
        self.assertEqual(p.stdout, "")
        self.assertIn("not found", p.stderr)


class ReplyShapeCase(unittest.TestCase):
    """SMS is not chat: markdown renders as literal characters on a phone and
    long replies cost extra segments."""

    def test_markdown_is_stripped(self):
        out = hb.sanitize_reply("**Invoice** sent\n- one\n- two\n## Heading")
        self.assertNotIn("**", out)
        self.assertNotIn("- one", out)
        self.assertNotIn("##", out)
        self.assertIn("Invoice sent", out)

    def test_code_fences_are_stripped(self):
        self.assertEqual(hb.sanitize_reply("```\nplain answer\n```"), "plain answer")

    def test_long_replies_are_cut_at_a_sentence(self):
        long = ("This is a sentence. " * 60).strip()
        out = hb.sanitize_reply(long)
        self.assertLessEqual(len(out), hb.MAX_REPLY_CHARS)
        self.assertTrue(out.endswith("."))

    def test_short_replies_pass_through_untouched(self):
        self.assertEqual(hb.sanitize_reply("  yes, Thursday works  "), "yes, Thursday works")


class ReplyExtractionCase(unittest.TestCase):
    """Agent servers disagree about which field holds the answer; accept the
    common ones rather than insisting on our own."""

    def test_common_field_names(self):
        for shape in ({"reply": "a"}, {"response": "a"}, {"text": "a"},
                      {"content": "a"}, {"output": "a"}, {"answer": "a"}):
            self.assertEqual(hb._extract_reply(shape), "a", shape)

    def test_nested_and_openai_shaped(self):
        self.assertEqual(hb._extract_reply({"message": {"content": "a"}}), "a")
        self.assertEqual(
            hb._extract_reply({"choices": [{"message": {"content": "a"}}]}), "a")

    def test_bare_string(self):
        self.assertEqual(hb._extract_reply("a"), "a")

    def test_unrecognised_shape_yields_nothing(self):
        self.assertEqual(hb._extract_reply({"weird": 1}), "")


class CommandTransportCase(unittest.TestCase):
    def setUp(self):
        self.sh = shutil.which("sh") or ("/bin/sh" if os.path.exists("/bin/sh") else "")
        if not self.sh:
            self.skipTest("no POSIX shell")

    def test_command_receives_the_prompt_on_stdin(self):
        cfg = hb.Config({"transport": "command",
                         "command": "grep -q 'critical this week' && printf 'saw it'",
                         "timeout": 10})
        reply, err = hb.ask_command(cfg, hb.build_prompt(cfg, payload()), "s", hb.time.time() + 10)
        self.assertIsNone(err)
        self.assertEqual(reply, "saw it")

    def test_session_placeholder_is_substituted(self):
        cfg = hb.Config({"transport": "command",
                         "command": "printf '%s' '{session}'", "timeout": 10})
        reply, err = hb.ask_command(cfg, "x", "agentcall-smsconv_abc", hb.time.time() + 10)
        self.assertIsNone(err)
        self.assertEqual(reply, "agentcall-smsconv_abc")

    def test_nonzero_exit_is_an_error(self):
        cfg = hb.Config({"transport": "command", "command": "echo bad >&2; exit 3",
                         "timeout": 10})
        _, err = hb.ask_command(cfg, "x", "s", hb.time.time() + 10)
        self.assertIn("exited 3", err or "")

    def test_timeout_explains_the_redelivery_consequence(self):
        cfg = hb.Config({"transport": "command", "command": "sleep 5", "timeout": 10})
        _, err = hb.ask_command(cfg, "x", "s", hb.time.time() + 0.5)
        self.assertIn("redelivers", err or "")


class HermesTransportCase(unittest.TestCase):
    """The native `hermes -z` transport, which is what most users get with no
    configuration at all. A stub binary stands in for the real CLI so the argv
    construction is asserted rather than assumed."""

    def setUp(self):
        self.tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmpbin")
        os.makedirs(self.tmp, exist_ok=True)
        self.stub = os.path.join(self.tmp, "fake_hermes.py")
        with open(self.stub, "w", encoding="utf-8") as fh:
            fh.write("import sys, json\n"
                     "sys.stderr.write(json.dumps(sys.argv[1:]))\n"
                     "print('stub reply')\n")
        for k in list(os.environ):
            if k.startswith("HERMES_"):
                del os.environ[k]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cfg(self, **over):
        raw = {"transport": "hermes", "hermes_bin": sys.executable, "timeout": 20}
        raw.update(over)
        c = hb.Config(raw)
        return c

    def _argv(self, cfg, session="agentcall-smsconv_abc"):
        """Run through _run with the stub and read back the argv it saw."""
        captured = {}
        real_run = hb._run

        def spy(argv, prompt, deadline):
            captured["argv"] = argv
            return real_run([sys.executable, self.stub] + argv[1:], prompt, deadline)

        hb._run = spy
        try:
            reply, err = hb.ask_hermes(cfg, "PROMPT", session, hb.time.time() + 20)
        finally:
            hb._run = real_run
        return captured["argv"], reply, err

    def test_uses_oneshot_and_continues_the_session(self):
        argv, reply, err = self._argv(self.cfg())
        self.assertIsNone(err)
        self.assertEqual(reply.strip(), "stub reply")
        self.assertIn("-z", argv)
        self.assertEqual(argv[argv.index("-z") + 1], "PROMPT")
        self.assertIn("-c", argv)
        self.assertEqual(argv[argv.index("-c") + 1], "agentcall-smsconv_abc")

    def test_sms_safe_restricts_toolsets_on_the_command_line(self):
        # The profile has to be enforced by Hermes, not merely requested in the
        # prompt, or it is decoration.
        argv, _, _ = self._argv(self.cfg(profile="sms-safe"))
        self.assertIn("-t", argv)
        allowed = argv[argv.index("-t") + 1]
        for banned in ("terminal", "file", "code_execution", "computer_use",
                       "messaging", "cronjob", "delegation", "browser"):
            self.assertNotIn(banned, allowed)
        self.assertIn("web", allowed)

    def test_sms_safe_excludes_writable_memory(self):
        # memory is WRITABLE. Allowing it would let a text talk the agent into
        # saving or deleting something permanent, on a channel authenticated by
        # caller ID. Hermes injects existing memory into the prompt anyway, so
        # the agent still knows what it knows; it just cannot rewrite it here.
        argv, _, _ = self._argv(self.cfg(profile="sms-safe"))
        self.assertNotIn("memory", argv[argv.index("-t") + 1])

    def test_full_profile_passes_no_toolset_restriction(self):
        argv, _, _ = self._argv(self.cfg(profile="full", allow_full_sms="1"))
        self.assertNotIn("-t", argv)

    def test_explicit_toolsets_override_the_profile(self):
        argv, _, _ = self._argv(self.cfg(toolsets="web,memory,terminal"))
        self.assertEqual(argv[argv.index("-t") + 1], "web,memory,terminal")

    def test_hooks_are_not_auto_approved_by_default(self):
        # --accept-hooks auto-approves unseen shell hooks from config.yaml.
        # Passing it by default would hand shell execution to whoever knows the
        # number.
        argv, _, _ = self._argv(self.cfg())
        self.assertNotIn("--accept-hooks", argv)

    def test_hooks_can_be_opted_into_explicitly(self):
        argv, _, _ = self._argv(self.cfg(accept_hooks="1"))
        self.assertIn("--accept-hooks", argv)

    def test_transport_is_autodetected_when_a_binary_exists(self):
        os.environ["HERMES_BIN"] = sys.executable
        self.assertEqual(hb.Config({}).transport, "hermes")


class ConfigCase(unittest.TestCase):
    def setUp(self):
        for k in list(os.environ):
            if k.startswith("HERMES_"):
                del os.environ[k]

    def test_transport_is_inferred_from_whichever_target_is_set(self):
        self.assertEqual(hb.Config({"url": "http://x"}).transport, "http")
        self.assertEqual(hb.Config({"container": "hermes"}).transport, "docker")
        self.assertEqual(hb.Config({"command": "x"}).transport, "command")

    def test_no_target_is_a_problem_with_a_pointer_to_discover(self):
        # Simulate a machine with no hermes binary, so the assertion is about
        # the code rather than about what happens to be installed here.
        real = hb._find_hermes
        hb._find_hermes = lambda: ""
        try:
            problems = hb.Config({}).problems()
        finally:
            hb._find_hermes = real
        self.assertTrue(any("--discover" in p for p in problems), problems)

    def test_a_hermes_binary_alone_is_enough_to_be_configured(self):
        # The turnkey case: hermes installed, nothing set, it just works.
        real = hb._find_hermes
        hb._find_hermes = lambda: "/usr/local/bin/hermes"
        try:
            cfg = hb.Config({})
        finally:
            hb._find_hermes = real
        self.assertEqual(cfg.transport, "hermes")
        self.assertEqual(cfg.problems(), [])

    def test_sms_safe_is_the_default_profile(self):
        self.assertEqual(hb.Config({}).profile, "sms-safe")

    def test_full_profile_alone_is_refused(self):
        # One string is too easy to flip while copying someone's config, so
        # exposing terminal/files/messaging to SMS takes two deliberate switches.
        problems = hb.Config({"url": "http://x", "profile": "full"}).problems()
        self.assertTrue(any("HERMES_ALLOW_FULL_SMS" in p for p in problems), problems)

    def test_full_profile_with_both_switches_is_allowed(self):
        cfg = hb.Config({"url": "http://x", "profile": "full",
                         "allow_full_sms": "1"})
        self.assertEqual(cfg.problems(), [])

    def test_refusing_full_means_no_reply_rather_than_a_quiet_downgrade(self):
        # Silently falling back to sms-safe would leave the operator believing
        # the full agent was live. Failing means the text is retried and the
        # log says exactly which switch is missing.
        os.environ.update({"HERMES_TRANSPORT": "http", "HERMES_URL": "http://127.0.0.1:1/x",
                           "HERMES_PROFILE": "full"})
        p = subprocess.run([sys.executable, BRAIN], input=json.dumps(payload()),
                           capture_output=True, text=True, env=dict(os.environ),
                           timeout=30)
        self.assertEqual(p.returncode, hb.EXIT_FAIL)
        self.assertEqual(p.stdout, "")
        self.assertIn("HERMES_ALLOW_FULL_SMS", p.stderr)

    def test_env_beats_file(self):
        os.environ["HERMES_URL"] = "http://from-env"
        self.assertEqual(hb.Config({"url": "http://from-file"}).url, "http://from-env")


if __name__ == "__main__":
    unittest.main(verbosity=2)
