#!/usr/bin/env python3
"""Newline-delimited stdio MCP server; stdout is exclusively JSON-RPC."""
import json
import sys
from notify import MAX_JSON, NotifyError, send_notification, get_notification_status

VERSION = "2025-06-18"
SEND_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string", "minLength": 1, "maxLength": 120},
    "body": {"type": "string", "minLength": 1, "maxLength": 8192},
    "source": {"type": "string", "minLength": 1, "maxLength": 64},
    "severity": {"type": "string", "enum": ["info", "success", "warning", "error"]},
    "deviceId": {"type": "string", "format": "uuid"},
    "eventId": {"type": "string", "format": "uuid"}},
    "required": ["title", "body", "source", "severity"], "additionalProperties": False}
TOOLS = [
    {"name": "send_phone_notification", "description": "Explicitly send a user-authorized brief alert. Queued does not mean received or displayed. Never use this to forward transcripts or automatic lifecycle events.", "inputSchema": SEND_SCHEMA,
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}},
    {"name": "get_phone_notification_status", "description": "Read the bridge's actual queued, received or displayed receipt for a notification.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "format": "uuid"}}, "required": ["id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}
]

class RPCError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

class Server:
    def __init__(self):
        self.initialized = False
        self.ready = False

    def dispatch(self, msg):
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            raise RPCError(-32600, "Invalid request")
        request_id = msg.get("id")
        if "id" in msg and (request_id is None or isinstance(request_id, bool) or not isinstance(request_id, (str, int))):
            raise RPCError(-32600, "Invalid request ID")
        method = msg["method"]
        params = msg.get("params", {})
        if not isinstance(params, dict):
            raise RPCError(-32602, "Parameters must be an object")
        if "id" not in msg:
            if method == "notifications/initialized" and self.initialized:
                self.ready = True
            return None
        if method == "initialize":
            if self.initialized:
                raise RPCError(-32600, "Already initialized")
            if not isinstance(params.get("protocolVersion"), str) or not isinstance(params.get("capabilities"), dict) or not isinstance(params.get("clientInfo"), dict):
                raise RPCError(-32602, "Invalid initialization parameters")
            self.initialized = True
            requested = params["protocolVersion"]
            version = requested if requested in ("2024-11-05", "2025-03-26", VERSION) else VERSION
            return {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "lexbridge-notify", "version": "0.1.0"}, "instructions": "Send only explicitly authorized brief alerts. A queued receipt does not prove phone delivery."}
        if method == "ping":
            return {}
        if not self.ready:
            raise RPCError(-32002, "Initialize and send notifications/initialized first")
        if method == "tools/list":
            if params:
                raise RPCError(-32602, "Unexpected list parameters")
            return {"tools": TOOLS}
        if method != "tools/call":
            raise RPCError(-32601, "Method not found")
        if set(params) - {"name", "arguments", "_meta"}:
            raise RPCError(-32602, "Unexpected tool parameters")
        name, args = params.get("name"), params.get("arguments", {})
        if not isinstance(args, dict):
            raise RPCError(-32602, "Tool arguments must be an object")
        if name == "send_phone_notification":
            if set(args) - set(SEND_SCHEMA["properties"]) or not set(SEND_SCHEMA["required"]).issubset(args):
                raise RPCError(-32602, "Invalid send arguments")
            call = lambda: send_notification(args["title"], args["body"], args["source"], args["severity"], args.get("deviceId"), args.get("eventId"))
        elif name == "get_phone_notification_status":
            if set(args) != {"id"}:
                raise RPCError(-32602, "Status requires only id")
            call = lambda: get_notification_status(args["id"])
        else:
            raise RPCError(-32602, "Unknown tool")
        try:
            result = call()
            return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}
        except NotifyError as exc:
            result = {"error": str(exc), "code": exc.code}
            if exc.result:
                result.update(exc.result)
            return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": True}


def emit(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=True, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    server = Server()
    while True:
        raw = sys.stdin.buffer.readline(MAX_JSON + 1)
        if not raw:
            return 0
        if len(raw) > MAX_JSON or not raw.endswith(b"\n"):
            emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Message exceeds limit or missing newline"}})
            # Exit instead of unbounded draining a malicious line.
            return 1
        request_id = None
        msg = None
        try:
            msg = json.loads(raw.decode("utf-8", "strict"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if isinstance(msg, dict):
                request_id = msg.get("id")
            result = server.dispatch(msg)
            if isinstance(msg, dict) and "id" in msg:
                emit({"jsonrpc": "2.0", "id": request_id, "result": result})
        except (ValueError, UnicodeError):
            emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
        except RPCError as exc:
            if isinstance(msg, dict) and "id" not in msg and msg.get("jsonrpc") == "2.0":
                continue
            safe_id = request_id if type(request_id) in (str, int) else None
            emit({"jsonrpc": "2.0", "id": safe_id, "error": {"code": exc.code, "message": exc.message}})
        except Exception:
            emit({"jsonrpc": "2.0", "id": request_id if type(request_id) in (str, int) else None, "error": {"code": -32603, "message": "Internal error"}})

if __name__ == "__main__":
    sys.exit(main())
