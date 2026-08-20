# agent-channel

This is the client (hooks, listener, setup, share, send). The server is a separate private service.

Send your Claude Code or Codex session, or a file, to another person in one typed line. Encrypted on your machine. They read it with nothing installed.

```
npx @amkentech/agent-channel share ./notes.md                 # prints a link; no account, no invite
npx @amkentech/agent-channel share --conversation --last 40   # this session's transcript, redacted, as a link
```

Inside Claude Code, once you have joined (invite code from a member):

```
@sam send-conversation --last 40 the auth thread   # typed as a prompt: a hook sends it, the model never sees it
@sam send ./export.txt why it matters              # encrypted file into Sam's inbox
@sam are you around?                               # a human message, no model turn
```

Sam's agent reads what arrives as data and triages it for Sam. If Sam opens a link in a browser instead, there is a box to send a note back, and the same `npx` line to send one of their own.

## Install

Node 22+. Sharing needs nothing else. To join the channel (messages, files into an inbox, contracts):

```
npx @amkentech/agent-channel join <invite_code> <handle> "Your Name"        # --runtime codex for Codex CLI; both works
npx @amkentech/agent-channel doctor
```

`join` registers the MCP server in your client and merges two hooks into its config (`SessionStart`, `UserPromptSubmit`); it prints what it wrote. Restart the client. claude.ai, Claude Desktop, ChatGPT and Codex cloud connect by URL instead: see [/docs](https://agent-channel-production.up.railway.app/docs).

## What is underneath, in one paragraph each

**Links.** Files and transcripts are encrypted in your process with a random AES-256-GCM key; the server stores ciphertext and the key rides in the URL fragment, which browsers do not send. Links expire (72 h default, 7 days max), can be view-limited, and can be revoked. The page that decrypts is served by us, so you trust our JavaScript the way you trust any hosted E2E viewer.

**Files between members.** X25519 + HKDF + AES-256-GCM to the recipient's registered keys, decrypted only on their machine, then inspected (injection phrases, secrets, executables, hidden unicode) and quarantined on hits. The server hands out the keys, so this protects against a passive server and a leaked database, not against an operator who adds a key; keys are pinned after the first send and new ones are refused until you say so.

**Messages** are plain text over TLS, stored in Postgres for 3 days (longer while a contract they belong to is open). Typed `@handle` lines are sent by a hook on Claude Code with no model turn; on Codex, claude.ai, Claude Desktop and ChatGPT the model relays.

**Contracts and the ledger.** When work crosses between people, both humans approve the same written version in their own words, a counterparty with no account approves from a one-time emailed link and gets a copy back, and every authorization lands in an append-only, hash-chained ledger (triggers refuse UPDATE/DELETE for the app role; `db/ledger.sql` is the DDL). Exports are Ed25519-signed; the record page verifies itself in the browser and `scripts/audit-verify.mjs` does it offline. Tamper-evident to anyone holding an earlier export; not tamper-proof against the database owner.

## More

- the reference (ask a member; the server repo is private): every endpoint, tool, hook, adapter, the OAuth flow, ops, deploy.
- [SECURITY.md](SECURITY.md): what the design protects, what it does not, and how to report something.
- Live: [about](https://agent-channel-production.up.railway.app/) · [connect](https://agent-channel-production.up.railway.app/docs) · [status](https://agent-channel-production.up.railway.app/status) · [security.txt](https://agent-channel-production.up.railway.app/.well-known/security.txt)

Operated by Amken (amkentech.com), hello@amkentech.com. Single operator, no SOC 2, no SLA, no DPA yet; the about page says where data sits and how to leave.
