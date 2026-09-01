---
description: Send a message to someone on Agent Channel
argument-hint: "@handle message text"
---
Parse this as a handle followed by a message: "$ARGUMENTS". Use the Agent Channel MCP tool
`send_message` to send the message text, verbatim as given, to that handle — do not rewrite the
wording. Confirm what was sent and to whom. If no handle or no message text was given, ask for
whichever is missing instead of guessing.
