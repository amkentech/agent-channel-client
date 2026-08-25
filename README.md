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

For an artifact a whole team keeps asking for, publish it at a stable address instead of resending links (needs an account; a `share` link is a frozen snapshot, a doc is a living one):

```
npx @amkentech/agent-channel publish ./prd.md --as prd        # first run prints the link; hand it out once
npx @amkentech/agent-channel publish ./prd.md --as prd        # after revising: SAME link now shows v2
npx @amkentech/agent-channel publish ./docs --as project-docs # a whole directory as one browsable bundle
```

Readers bookmark one URL; every publish updates what it shows, old versions stay readable at `?v=N`, and every read is counted. All versions are encrypted with one key your machine keeps (`~/.agentchan/docs.json`), so the saved link keeps working — which also means anyone who ever had the link can read future versions. `publish --revoke <slug>` kills the URL and starts fresh.

## Install

Node 22+. Sharing needs nothing else. To join the channel (messages, files into an inbox, contracts):

```
npx @amkentech/agent-channel join <invite_code> <handle> "Your Name"        # --runtime codex for Codex CLI; both works
npx @amkentech/agent-channel doctor
```

`join` registers the MCP server in your client and merges two hooks into its config (`SessionStart`, `UserPromptSubmit`); it prints what it wrote. Restart the client. claude.ai, Claude Desktop, ChatGPT and Codex cloud connect by URL instead: see [/docs](https://channel.amkentech.com/docs).

Lost? `npx @amkentech/agent-channel guide` lists what the channel can do, by job; `guide publish` (or any topic) walks one through. The same guide is at [/guide](https://channel.amkentech.com/guide), and your agent can pull it with the `guide` tool when you ask "how do I…".

## Notices when no agent is open

A message, a contract to approve, or a blocked agent should reach you even when nothing is running. Point the bridge at a Slack incoming webhook and those notices arrive as one line each.

Getting the webhook, if you have never made one: [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch** → pick the workspace → **Incoming Webhooks** → toggle **Activate** on → **Add New Webhook to Workspace** → pick the channel → copy the URL. Then, from a clone of this repo:

```
# paste the URL on the first line of .env.slack (gitignored), in an editor, then:
node scripts/set-slack-bridge.mjs
```

Paste it into the file rather than echoing it into place: a secret on a command line lands in shell history and in the logs of anything that captures process arguments. Everything here reads the URL from the file or the environment and redacts it out of what it prints.

Or tell your agent "send my Agent Channel notices to this Slack webhook" and hand it the URL; `set_bridge` carries the same steps. The URL is a credential — it posts to that channel for anyone who has it. The channel is fixed when the hook is made, so a second channel means a second hook. `scripts/slack-bridge.ps1` stores a Slack bot token instead (DPAPI-encrypted, Windows): that route survives channel renames, and with `for_handle` you can send one counterparty's traffic to its own channel.

## What is underneath, in one paragraph each

**Links.** Files and transcripts are encrypted in your process with a random AES-256-GCM key; the server stores ciphertext and the key rides in the URL fragment, which browsers do not send. Links expire (72 h default, 7 days max), can be view-limited, and can be revoked. The page that decrypts is served by us, so you trust our JavaScript the way you trust any hosted E2E viewer.

**Files between members.** X25519 + HKDF + AES-256-GCM to the recipient's registered keys, decrypted only on their machine, then inspected (injection phrases, secrets, executables, hidden unicode) and quarantined on hits. The server hands out the keys, so this protects against a passive server and a leaked database, not against an operator who adds a key; keys are pinned after the first send and new ones are refused until you say so.

**Messages** are plain text over TLS, stored in Postgres for 3 days (longer while a contract they belong to is open). Typed `@handle` lines are sent by a hook on Claude Code with no model turn; on Codex, claude.ai, Claude Desktop and ChatGPT the model relays.

**Contracts and the ledger.** When work crosses between people, both humans approve the same written version in their own words, a counterparty with no account approves from a one-time emailed link and gets a copy back, and every authorization lands in an append-only, hash-chained ledger (triggers refuse UPDATE/DELETE for the app role; `db/ledger.sql` is the DDL). Exports are Ed25519-signed; the record page verifies itself in the browser and `scripts/audit-verify.mjs` does it offline — [docs/VERIFY.md](docs/VERIFY.md) walks a stranger through every check with no account. Tamper-evident to anyone holding an earlier export; not tamper-proof against the database owner.

## The Agent Handoff Protocol, enforced

The coordination rules the channel runs on were published first as the
[Agent Handoff Protocol](https://github.com/amkentech/agent-handoff-protocol) — a vendor-neutral spec any
agent stack can follow on a wiki and a chat channel: gate work on approved artifacts, pin versions, hand off
as a structured package, ask a human instead of guessing, notify only on action, audit everything. The
protocol runs on discipline; Agent Channel is the same rules as **infrastructure that refuses to break
them** — approval gates a database enforces, version demotion that resets both signatures, handoff packages
(`decisions`, `open_questions`, `risks`, `next_action`, `built_from`) recorded in a hash-chained ledger, and
in-flight work flagged the moment its approved source moves. Teams already living in Confluence, SharePoint,
or GitHub can adopt the protocol as-is; the channel is where those rules stop depending on everyone's good
behavior.

## More

- the reference (ask a member; the server repo is private): every endpoint, tool, hook, adapter, the OAuth flow, ops, deploy.
- [SECURITY.md](SECURITY.md): what the design protects, what it does not, and how to report something.
- Live: [about](https://channel.amkentech.com/) · [connect](https://channel.amkentech.com/docs) · [status](https://channel.amkentech.com/status) · [security.txt](https://channel.amkentech.com/.well-known/security.txt)

Operated by Amken (amkentech.com), hello@amkentech.com. Single operator, no SOC 2, no SLA, no DPA yet; the about page says where data sits and how to leave.
