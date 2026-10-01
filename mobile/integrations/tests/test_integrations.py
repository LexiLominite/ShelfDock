import contextlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import notify
import paperclip_adapter

ID = str(uuid.uuid4())
TOKEN = "fixture-only-token-0000000000000000"
BASE = Path(__file__).resolve().parents[1]

class Fixture(http.server.BaseHTTPRequestHandler):
    events = {}
    calls = []
    mode = "normal"
    def log_message(self, *args):
        pass
    def reply(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self.reply(401, {"error": "fixture"})
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append(payload)
        if self.mode == "none":
            return self.reply(409, {"error": "Pair a phone first."})
        if self.mode == "conflict":
            return self.reply(409, {"error": "Event ID already used for different content."})
        if self.mode == "redirect":
            self.send_response(307)
            self.send_header("Location", "http://127.0.0.1:1/secret")
            self.end_headers()
            return
        if self.mode == "zero":
            return self.reply(200, {"id": ID, "status": "queued", "recipientCount": 0})
        if self.mode == "bad":
            return self.reply(200, {"id": ID, "status": "delivered", "recipientCount": 1, "token": TOKEN})
        if self.mode == "slow":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                for _ in range(20):
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    time.sleep(0.15)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        event = payload.get("eventId")
        result = self.events.setdefault(event, {"id": str(uuid.uuid4()), "status": "queued", "recipientCount": 1}) if event else {"id": ID, "status": "queued", "recipientCount": 1}
        self.reply(200, dict(result, unexpectedSecret=TOKEN))
    def do_GET(self):
        self.reply(200, {"id": ID, "status": "displayed", "recipientCount": 1, "receivedCount": 1, "displayedCount": 1})

class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name).resolve() / "agent.json"
        self.path.write_text(json.dumps({"version": 1, "endpoint": "http://127.0.0.1:" + str(self.server.server_port), "token": TOKEN}))
        self.path.chmod(0o600)
        Fixture.mode = "normal"
        Fixture.calls = []
        Fixture.events = {}
    def tearDown(self):
        self.temp.cleanup()
    def send(self, **args):
        return notify.send_notification("Test", "Synthetic alert", config_path=self.path, **args)
    def test_actual_receipts_and_secret_whitelist(self):
        result = self.send()
        self.assertEqual(result["status"], "queued")
        self.assertNotIn(TOKEN, json.dumps(result))
        status = notify.get_notification_status(ID, self.path)
        self.assertEqual(status["status"], "displayed")
        self.assertEqual(status["displayedCount"], 1)
    def test_explicit_paperclip_adapter(self):
        result = paperclip_adapter.send_phone_notification(title="Test", body="Explicit fixture", config_path=self.path)
        self.assertEqual(Fixture.calls[0]["source"], "paperclip")
        self.assertEqual(result["status"], "queued")
        self.assertEqual(paperclip_adapter.get_phone_notification_status(ID, config_path=self.path)["status"], "displayed")
    def test_retry_same_event_id_one_receipt(self):
        event = str(uuid.uuid4())
        first = self.send(event_id=event)
        second = self.send(event_id=event)
        self.assertEqual(first, second)
        self.assertEqual(len(Fixture.events), 1)
        self.assertEqual(len(Fixture.calls), 2)
    def test_no_recipients_and_invalid_status(self):
        for mode, code in (("none", "no_recipients"), ("zero", "no_recipients"), ("bad", "protocol_error"), ("redirect", "http_error"), ("conflict", "http_error")):
            Fixture.mode = mode
            with self.assertRaises(notify.NotifyError) as caught:
                self.send()
            self.assertEqual(caught.exception.code, code)
            self.assertNotIn(TOKEN, str(caught.exception))
    def test_unsafe_credentials(self):
        self.path.chmod(0o644)
        with self.assertRaises(notify.NotifyError):
            self.send()
        self.path.chmod(0o600)
        self.path.parent.chmod(0o755)
        with self.assertRaises(notify.NotifyError):
            self.send()
        self.path.parent.chmod(0o700)
        link = self.path.parent / "link.json"
        link.symlink_to(self.path)
        with self.assertRaises(notify.NotifyError):
            notify.load_credentials(link)
        parentlink = self.path.parent / "linked-dir"
        parentlink.symlink_to(self.path.parent, target_is_directory=True)
        with self.assertRaises(notify.NotifyError):
            notify.load_credentials(parentlink / "agent.json")
    def test_private_endpoint_validation(self):
        for value in ("http://8.8.8.8", "http://127.0.0.1\n", "https://example.com", "http://localhost", "http://192.168.1.2", "http://100.128.0.1", "https://fake.ts.net.evil.com", "http://100.64.1.2/?token=a", "http://x:y@127.0.0.1", "file:///tmp/x"):
            with self.assertRaises(notify.NotifyError, msg=value):
                notify.validate_endpoint(value)
        for value in ("http://127.0.0.1:18474", "http://100.64.1.2", "http://[::1]", "https://100.127.255.255", "https://phone.example.ts.net"):
            self.assertEqual(notify.validate_endpoint(value), value)
    def test_input_rejected_before_http(self):
        for args in ({"title": "x" * 121}, {"body": "x" * 8193}, {"body": "bad\ud800"}, {"source": "a\x00"}, {"severity": "urgent"}, {"event_id": "bad"}, {"device": "bad"}):
            values = dict(title="Test", body="Body", config_path=self.path)
            values.update(args)
            with self.assertRaises(notify.NotifyError):
                notify.send_notification(**values)
        self.assertEqual(Fixture.calls, [])
    def test_total_deadline_no_automatic_retry(self):
        old_timeout = notify.TIMEOUT
        notify.TIMEOUT = 0.45
        Fixture.mode = "slow"
        started = time.monotonic()
        try:
            with self.assertRaises(notify.NotifyError) as caught:
                self.send()
            self.assertEqual(caught.exception.code, "connection_error")
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertEqual(len(Fixture.calls), 1)
        finally:
            notify.TIMEOUT = old_timeout
    def cli(self, *args):
        return subprocess.run([sys.executable, str(BASE / "notify.py"), "--config", str(self.path), "--json", *args], capture_output=True, text=True, timeout=8)
    def test_cli_status_and_exit_codes(self):
        result = self.cli("--title", "Test", "--body", "Body", "--source", "codex")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "queued")
        Fixture.mode = "none"
        result = self.cli("--title", "Test", "--body", "Body")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stderr)["code"], "no_recipients")
        result = self.cli("--status", ID)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["status"], "displayed")
    def mcp(self, messages, raw=None):
        env = dict(os.environ, LEXBRIDGE_NOTIFY_CONFIG=str(self.path))
        data = raw if raw is not None else "".join(json.dumps(m) + "\n" for m in messages).encode()
        result = subprocess.run([sys.executable, str(BASE / "mcp_server.py")], input=data, capture_output=True, env=env, timeout=8)
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(TOKEN.encode(), result.stdout)
        return result, [json.loads(line) for line in result.stdout.splitlines()]
    def init(self):
        return [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fixture", "version": "1"}}}, {"jsonrpc": "2.0", "method": "notifications/initialized"}]
    def test_mcp_lifecycle_discovery_send_status_errors(self):
        msgs = self.init() + [
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "send_phone_notification", "arguments": {"title": "Test", "body": "Body", "source": "codex", "severity": "info"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "get_phone_notification_status", "arguments": {"id": ID}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "unknown"}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "send_phone_notification", "arguments": {"token": TOKEN}}}]
        result, replies = self.mcp(msgs)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(replies), 6)
        self.assertEqual(len(replies[1]["result"]["tools"]), 2)
        self.assertEqual(json.loads(replies[2]["result"]["content"][0]["text"])["status"], "queued")
        self.assertEqual(json.loads(replies[3]["result"]["content"][0]["text"])["status"], "displayed")
        self.assertEqual(replies[4]["error"]["code"], -32602)
        self.assertEqual(replies[5]["error"]["code"], -32602)
    def test_mcp_bounded_parse_and_preinitialize(self):
        _, replies = self.mcp([], raw=b"{bad}\n")
        self.assertEqual(replies[0]["error"]["code"], -32700)
        result, replies = self.mcp([], raw=b"x" * (notify.MAX_JSON + 1))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(replies[0]["error"]["code"], -32700)
        _, replies = self.mcp([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
        self.assertEqual(replies[0]["error"]["code"], -32002)
    def test_mcp_execution_failure_is_tool_error(self):
        Fixture.mode = "none"
        _, replies = self.mcp(self.init() + [{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "send_phone_notification", "arguments": {"title": "T", "body": "B", "source": "agent", "severity": "info"}}}])
        self.assertTrue(replies[1]["result"]["isError"])
        self.assertEqual(json.loads(replies[1]["result"]["content"][0]["text"])["code"], "no_recipients")

if __name__ == "__main__":
    unittest.main()
