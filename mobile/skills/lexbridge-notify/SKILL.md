---
name: lexbridge-notify
description: Send a brief explicit agent alert to the user's paired LexBridge phone, or check its receipt, when the user requests phone notification. Supports Codex, Claude Code, Paperclip and other agents through MCP or the shared CLI.
---

# LexBridge phone notification

Send only a brief alert the user explicitly requested, including a completion alert authorized as part of their task. Permission to work on a task alone does not authorize a phone alert. Use your own concise summary; never copy raw conversation transcripts, session files, logs, credentials, or private tool output into an alert.

Prefer the MCP tool `send_phone_notification` with `title`, `body`, `source` (`codex`, `claude-code`, `paperclip`, or `agent`) and `severity` (`info`, `success`, `warning`, `error`). Optional `deviceId` targets one paired device. Without it, the bridge targets paired devices at send time. For an authorized retry, reuse the same UUID `eventId` and identical payload so the bridge can deduplicate. Do not retry indefinitely or retry an uncertain send with a new event ID.

Report the returned receipt accurately. `queued` means accepted by the bridge; `received` means persisted by the phone; `displayed` means the phone reported presenting it. Never claim that a queued alert reached the phone. Use `get_phone_notification_status` with the returned notification `id` when asked to verify. No recipients is a failure to reach a phone; report it plainly. A timeout means the outcome is unconfirmed.

When MCP is unavailable, use the standalone Python CLI from the configured LexBridge installation path. Read [references/integration.md](references/integration.md) for invocation and host configuration examples. Credentials remain outside the skill and repository in the private agent configuration. Never put tokens in command arguments, URLs, model context, or output.

Do not add automatic Stop/Notification hooks, subscribe to lifecycle events, scan Codex or Claude session storage, or turn normal agent replies into notifications. This skill does not authorize pairing, changing device settings, modifying agent host configuration, or sending to unpaired devices.
