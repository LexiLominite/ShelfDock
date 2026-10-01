# Host integration and explicit invocation

The bridge's `init` creates `~/.config/lexbridge-mobile/agent.json` owned by the current user with mode `0600`. Its shape is `{ "version": 1, "endpoint": "http://127.0.0.1:18474", "token": "<private-agent-token>" }`; this is a shape example, not an installable credential. The containing runtime directory must be owned by the current user with mode `0700`. The client rejects credential symlinks and unsafe file permissions. `LEXBRIDGE_NOTIFY_CONFIG` or CLI `--config` can select another private file. Token CLI arguments are unsupported.

HTTP endpoints require a literal loopback or Tailscale `100.64.0.0/10` address because the overlay encrypts traffic. HTTPS permits the same literal addresses or Tailscale hostnames ending exactly in `.ts.net`, with normal certificate validation. Arbitrary public domains and other DNS hostnames are rejected. Keep the bridge private; do not enable public Tailscale Funnel. Redirects and environment HTTP proxies are disabled so scoped credentials cannot be forwarded to another origin.

Replace `/absolute/lexbridge/mobile/integrations` below with the installed absolute path. Preserve all existing host entries when adding an MCP server; do not overwrite the host's entire configuration. Installing a skill or MCP entry is a separate user-authorized action.

Codex configuration addition (merge into the existing TOML):

```toml
[mcp_servers.lexbridge-notify]
command = "python3"
args = ["/absolute/lexbridge/mobile/integrations/mcp_server.py"]
```

Claude Code MCP configuration addition (merge the `lexbridge-notify` entry into existing `mcpServers`):

```json
{
  "mcpServers": {
    "lexbridge-notify": {
      "command": "python3",
      "args": ["/absolute/lexbridge/mobile/integrations/mcp_server.py"]
    }
  }
}
```

If a host requires an explicit environment map, set only `LEXBRIDGE_NOTIFY_CONFIG` to the credential file path. Do not place the token in host configuration. Copy the entire `lexbridge-notify` skill directory to the host's supported skill location when authorized.

An explicitly authorized alert:

```sh
python3 /absolute/lexbridge/mobile/integrations/notify.py --title 'Build finished' --body 'The requested build passed.' --source codex --severity success --event-id 90c454db-d540-488e-95fa-2daefffca1ad --json
```

Use a fresh event UUID for each distinct alert; retain it for retries of the same payload. There are no automatic retries. Exit `0` returns actual queued/received/displayed status, exit `3` means no recipients, and exit `2` means input, configuration, connection, or protocol failure. JSON errors go to stderr, success JSON to stdout.

```sh
python3 /absolute/lexbridge/mobile/integrations/notify.py --status '<returned-notification-UUID>' --json
```

Paperclip can expose an explicit tool that imports `send_phone_notification` from `paperclip_adapter.py`, with this directory on its Python module path. The adapter always sets `source="paperclip"`; it returns the bridge receipt and propagates safe client errors. Pass `title`, `body`, optional `severity`, `device_id`, `event_id`, and `config_path`. It does not register subscriptions or hooks. Other runtimes can invoke the same CLI with `--source paperclip`, or make an explicitly authorized `POST /v1/notifications` with their private agent credential and the shared protocol fields. Never embed the credential in an agent prompt.

MCP implementation uses newline-delimited UTF-8 JSON-RPC stdio, initialization negotiation, `notifications/initialized`, `tools/list`, `tools/call`, and bounded input. See the primary [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) specifications. No secrets or non-protocol logs are written to stdout.
