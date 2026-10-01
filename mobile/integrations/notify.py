#!/usr/bin/env python3
"""Explicit notification client. Python standard library; never reads agent sessions."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_JSON = 65536
TIMEOUT = 4

class NotifyError(Exception):
    def __init__(self, message, code="client_error", result=None):
        super().__init__(message)
        self.code, self.result = code, result


def canonical_id(value, name):
    if not isinstance(value, str):
        raise NotifyError(name + " must be a UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        raise NotifyError(name + " must be a UUID") from None
    if str(parsed) != value.lower():
        raise NotifyError(name + " must be a canonical UUID")
    return str(parsed)


def bounded_text(value, name, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise NotifyError(name + " must be nonempty text within " + str(limit) + " characters")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise NotifyError(name + " must be valid UTF-8") from None
    if any(ord(c) < 32 and (name != "body" or c not in "\n\t") for c in value) or "\x7f" in value:
        raise NotifyError(name + " contains control characters")
    return value


def validate_endpoint(endpoint):
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or any(ord(c) <= 32 or ord(c) >= 127 for c in endpoint):
        raise NotifyError("Invalid endpoint")
    try:
        url = urllib.parse.urlsplit(endpoint)
        port = url.port
    except ValueError:
        raise NotifyError("Invalid endpoint") from None
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise NotifyError("Endpoint must be a plain HTTP(S) origin without credentials or query")
    if port is not None and not 1 <= port <= 65535:
        raise NotifyError("Invalid endpoint port")
    try:
        addr = ipaddress.ip_address(url.hostname)
    except ValueError:
        host = url.hostname.lower()
        if url.scheme == "https" and host.endswith(".ts.net") and len(host) > len(".ts.net") and all(part and all(c.isascii() and (c.isalnum() or c == "-") for c in part) for part in host.split(".")):
            return endpoint.rstrip("/")
        raise NotifyError("Endpoint requires a private literal address or HTTPS Tailscale .ts.net host") from None
    if not (addr.is_loopback or (addr.version == 4 and addr in ipaddress.ip_network("100.64.0.0/10"))):
        raise NotifyError("Endpoint is allowed only on loopback or the encrypted Tailscale overlay")
    return endpoint.rstrip("/")


def load_credentials(config_path=None):
    path = Path(config_path or os.environ.get("LEXBRIDGE_NOTIFY_CONFIG", "~/.config/lexbridge-mobile/agent.json")).expanduser().absolute()
    # Check every parent as well: a private leaf reached through a symlink is unsafe.
    for component in (path, *path.parents):
        if component.is_symlink():
            raise NotifyError("Credential path must not contain symlinks")
    try:
        parent_meta = path.parent.stat()
        if parent_meta.st_uid != os.getuid() or stat.S_IMODE(parent_meta.st_mode) != 0o700:
            raise NotifyError("Credential directory must be owned by this user with mode 0700")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            meta = os.fstat(handle.fileno())
            if not stat.S_ISREG(meta.st_mode) or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != os.getuid():
                raise NotifyError("Credential file must be owned by this user with mode 0600")
            raw = handle.read(MAX_JSON + 1)
    except OSError:
        raise NotifyError("Cannot read private notification credential file") from None
    if len(raw) > MAX_JSON:
        raise NotifyError("Credential file is too large")
    try:
        config = json.loads(raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeError):
        raise NotifyError("Credential file must contain UTF-8 JSON") from None
    if not isinstance(config, dict) or type(config.get("version")) is not int or config.get("version") != 1 or set(config) != {"version", "endpoint", "token"}:
        raise NotifyError("Credential config requires version 1, endpoint and token only")
    token = config["token"]
    if not isinstance(token, str) or not 16 <= len(token) <= 4096 or any(ord(c) <= 32 or ord(c) >= 127 for c in token):
        raise NotifyError("Invalid notification credential")
    return validate_endpoint(config["endpoint"]), token


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _perform_request(method, route, payload=None, config_path=None):
    endpoint, token = load_credentials(config_path)
    data = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if data is not None and len(data) > MAX_JSON:
        raise NotifyError("Notification exceeds JSON byte limit")
    req = urllib.request.Request(endpoint + route, data=data, method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
    # No proxies or redirects: never forward a scoped credential to another origin.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + TIMEOUT
    try:
        with opener.open(req, timeout=TIMEOUT) as response:
            chunks, size = [], 0
            while size <= MAX_JSON:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                # CPython HTTPResponse exposes its transport socket through its buffered reader.
                response.fp.raw._sock.settimeout(remaining)
                chunk = response.read1(min(8192, MAX_JSON + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if response.isclosed():
                    break
            raw = b"".join(chunks)
            if response.headers.get_content_type() != "application/json":
                raise NotifyError("Bridge returned a non-JSON response", "protocol_error")
    except urllib.error.HTTPError as exc:
        status = exc.code
        error_body = {}
        try:
            raw_error = exc.read(MAX_JSON + 1)
            if len(raw_error) <= MAX_JSON:
                error_body = json.loads(raw_error.decode("utf-8", "strict"))
        except (ValueError, UnicodeError, OSError):
            pass
        finally:
            exc.close()
        if status == 409 and isinstance(error_body, dict) and (error_body.get("code") == "no_recipients" or error_body.get("error") == "Pair a phone first."):
            raise NotifyError("No paired notification recipients", "no_recipients", {"status": "no_recipients", "recipientCount": 0}) from None
        raise NotifyError("Bridge rejected request (HTTP " + str(status) + ")", "http_error") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise NotifyError("Bridge connection failed or timed out; delivery is unconfirmed", "connection_error") from None
    if len(raw) > MAX_JSON:
        raise NotifyError("Bridge response exceeds byte limit", "protocol_error")
    try:
        result = json.loads(raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeError):
        raise NotifyError("Bridge returned invalid UTF-8 JSON", "protocol_error") from None
    if not isinstance(result, dict):
        raise NotifyError("Bridge returned an invalid result", "protocol_error")
    canonical_id(result.get("id"), "result id")
    if result.get("status") not in ("queued", "received", "displayed") or type(result.get("recipientCount")) is not int or result["recipientCount"] < 0:
        raise NotifyError("Bridge returned invalid notification status", "protocol_error")
    for field in ("receivedCount", "displayedCount"):
        if method == "GET" and (type(result.get(field)) is not int or not 0 <= result[field] <= result["recipientCount"]):
            raise NotifyError("Bridge returned invalid receipt counts", "protocol_error")
    if method == "GET" and result["displayedCount"] > result["receivedCount"]:
        raise NotifyError("Bridge returned inconsistent receipt counts", "protocol_error")
    if result["recipientCount"] == 0:
        raise NotifyError("No paired notification recipients", "no_recipients", {"id": result["id"], "status": "no_recipients", "recipientCount": 0})
    # Whitelist protocol fields; never echo arbitrary server fields or credentials.
    return {key: result[key] for key in ("id", "status", "recipientCount", "receivedCount", "displayedCount") if key in result}



def request(method, route, payload=None, config_path=None):
    # Bound the entire network operation, including DNS and slow HTTP headers.
    # A separate disposable process prevents an uncertain request from leaving
    # blocked threads or sockets in a long-lived MCP or Paperclip agent process.
    job = {"method": method, "route": route, "payload": payload, "config_path": str(config_path) if config_path is not None else None}
    encoded = json.dumps(job, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_JSON:
        raise NotifyError("Notification exceeds JSON byte limit")
    try:
        completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--internal-request-worker"], input=encoded,
                                   capture_output=True, timeout=TIMEOUT, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise NotifyError("Bridge connection failed or timed out; delivery is unconfirmed", "connection_error") from None
    try:
        if completed.returncode != 0 or len(completed.stdout) > MAX_JSON:
            raise ValueError()
        result = json.loads(completed.stdout.decode("utf-8", "strict"))
        if "error" in result:
            raise NotifyError(result["error"], result["code"], result.get("result"))
        return result["result"]
    except (ValueError, UnicodeError, KeyError, TypeError):
        raise NotifyError("Notification worker failed; delivery is unconfirmed", "connection_error") from None


def internal_worker():
    try:
        raw = sys.stdin.buffer.read(MAX_JSON + 1)
        if len(raw) > MAX_JSON:
            raise NotifyError("Notification exceeds JSON byte limit")
        job = json.loads(raw.decode("utf-8", "strict"))
        result = {"result": _perform_request(**job)}
    except NotifyError as exc:
        result = {"error": str(exc), "code": exc.code, "result": exc.result}
    except Exception:
        result = {"error": "Notification worker failed; delivery is unconfirmed", "code": "connection_error"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    return 0


def send_notification(title, body, source="agent", severity="info", device=None, event_id=None, config_path=None):
    payload = {"title": bounded_text(title, "title", 120), "body": bounded_text(body, "body", 8192), "source": bounded_text(source, "source", 64), "severity": severity}
    if severity not in ("info", "success", "warning", "error"):
        raise NotifyError("Invalid severity")
    if device is not None:
        payload["deviceId"] = canonical_id(device, "device")
    # Return stable event ID through caller input. No automatic retries after uncertain writes.
    if event_id is not None:
        payload["eventId"] = canonical_id(event_id, "event id")
    return request("POST", "/v1/notifications", payload, config_path)


def get_notification_status(notification_id, config_path=None):
    return request("GET", "/v1/notifications/" + canonical_id(notification_id, "notification id"), config_path=config_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title")
    parser.add_argument("--body")
    parser.add_argument("--source", default="agent")
    parser.add_argument("--severity", default="info", choices=("info", "success", "warning", "error"))
    parser.add_argument("--device")
    parser.add_argument("--event-id")
    parser.add_argument("--config", help="Private credential JSON path (never put tokens in arguments)")
    parser.add_argument("--status", metavar="UUID", help="Read one notification's actual receipt status")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.status:
            if args.title is not None or args.body is not None or args.device or args.event_id:
                raise NotifyError("Status cannot be combined with send arguments")
            result = get_notification_status(args.status, args.config)
        else:
            result = send_notification(args.title, args.body, args.source, args.severity, args.device, args.event_id, args.config)
        print(json.dumps(result) if args.json else result["status"] + " (" + result["id"] + "; recipients=" + str(result["recipientCount"]) + ")")
        return 0
    except NotifyError as exc:
        result = {"error": str(exc), "code": exc.code}
        if exc.result:
            result.update(exc.result)
        print(json.dumps(result) if args.json else str(exc), file=sys.stderr)
        return 3 if exc.code == "no_recipients" else 2

if __name__ == "__main__":
    sys.exit(internal_worker() if sys.argv[1:] == ["--internal-request-worker"] else main())
