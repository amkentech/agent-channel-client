---
description: Hand a task to another of this person's own runtimes
argument-hint: "runtime task text"
---
When the human says "hand this to X" (claude, claude-code, Codex, grok, grok-cli, gemini, or another
of their CLIs), call the Agent Channel MCP tool `handoff` with `to_runtime` set to that runtime and
`text` set to the task in the human's words, or a faithful brief of what they asked for. If this
command was invoked with arguments, parse "$ARGUMENTS" the same way: a runtime, then the task. Do
not use `send_message`; that is another person. Only do this when the human asked. Do not consume a
handoff addressed to another of this person's runtimes. After sending, say which runtime it is
flagged for and that it waits in their inbox.
