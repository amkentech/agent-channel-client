// Runtime adapters. Agent Channel is a conduit between AI workspaces; the workspace is not ours. Each adapter says how one
// runtime (Claude Code, Codex, ...) is wired and how it behaves, so hooks/setup/listener never hardcode a runtime and a
// third runtime is a new entry here, not a rewrite. Capabilities are probed where possible and degrade loudly.
//
// Contract per adapter:
//   key                 short name used in owner.<key> markers, .tok.<key>.json, hook argv
//   runtime             the runtime string stored on the agent (claude-code, codex, ...)
//   tokenEnv            env var the hook/listener read the token from
//   rendersSystemMessage  does the runtime show hook `systemMessage` to the human? (Claude Code yes, Codex no)
//   blocksPrompt        can a UserPromptSubmit hook block the prompt with a visible reason? (Claude Code yes)
//   supportsFileChanged Claude Code's FileChanged hook (idle notifications)
//   supportsStatusLine  Claude Code statusLine
//   supportsPreExec     can a hook intercept a shell command BEFORE it runs? Decides whether the credential guard
//                       (hooks/secret-guard.mjs) can protect this runtime. Where false, nothing here can stop a
//                       secret reaching argv; doctor must say so out loud, not stay silent (silence is how the
//                       2026-08-22 leak happened, in a runtime the guard cannot cover).
//   hooksFile / mcp     where the wiring lives, and how to write it
//   transcripts         where session transcripts live (for export-conversation)
import { homedir, platform } from "node:os";
import { join, dirname as dirnameOf } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const H = homedir();
// hook command lines run through a shell on every OS; forward slashes work on Windows too, and a path with spaces
// ("/Users/Jo Smith/.agentchan/client") must stay quoted
const nodeCmd = (repo, rel, ...a) => { const p = join(repo, rel).replace(/\\/g, "/"); return ["node", /\s/.test(p) ? '"' + p + '"' : p, ...a].join(" "); };

export const ADAPTERS = {
  claude: {
    key: "claude", runtime: "claude-code", label: "Claude Code", tokenEnv: "AGENTCHAN_TOKEN", listener: true,
    rendersSystemMessage: true, blocksPrompt: true, supportsFileChanged: true, supportsStatusLine: true, supportsPreExec: true,
    hooksFile: join(H, ".claude", "settings.json"),
    transcripts: { dir: join(H, ".claude", "projects"), note: "one folder per cwd slug, <session>.jsonl" },
    detect: () => existsSync(join(H, ".claude")) || !!which("claude"),
    mcpWire: ({ url, token }) => ({
      command: 'claude mcp add --transport http --scope user agent-channel ' + url + '/mcp --header "Authorization: Bearer ' + token + '"',
      apply: () => { const c = which("claude"); if (!c) return { ok: false, why: "claude CLI not on PATH; run the command yourself" };
        try { execFileSync(c, ["mcp", "remove", "--scope", "user", "agent-channel"], { stdio: "ignore" }); } catch {}
        try { execFileSync(c, ["mcp", "add", "--transport", "http", "--scope", "user", "agent-channel", url + "/mcp", "--header", "Authorization: Bearer " + token], { stdio: "pipe" }); return { ok: true }; }
        catch (e) { return { ok: false, why: String(e.stderr || e.message).trim().slice(0, 200) }; } },
      check: () => { const c = which("claude"); if (!c) return null; try { return execFileSync(c, ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("agent-channel"); } catch { return null; } },
    }),
    hooksWire: ({ repo }) => ({
      // merged into settings.json; existing hooks for other purposes are preserved (setup.mjs dedups by command substring)
      hooks: {
        // a credential given to a subprocess on the command line is captured by shell history, npm/CLI argv logs,
        // and the agent's own tool output, which is how it reaches a model provider — block that before it runs
        PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: nodeCmd(repo, "hooks/secret-guard.mjs"), timeout: 5, statusMessage: "Checking for credentials on the command line..." }] }],
        SessionStart: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "claude", "SessionStart"), timeout: 8, statusMessage: "Checking Agent Channel..." }, { type: "command", command: nodeCmd(repo, "hooks/claude-status.mjs", "working"), timeout: 6 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "claude", "UserPromptSubmit"), timeout: 8, statusMessage: "Checking Agent Channel..." }] }],
        // mid-turn arrivals: FileChanged output is discarded by Claude Code and UserPromptSubmit waits for the human,
        // so a message landing during a long working turn reaches the model here — after any tool call, local files
        // only, cursor-deduped, silent when nothing arrived (which is almost always)
        PostToolUse: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/btw.mjs", "claude"), timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/claude-status.mjs", "idle"), timeout: 6 }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/claude-status.mjs", "offline"), timeout: 6 }] }],
        FileChanged: [{ matcher: "agentchan_notify", hooks: [{ type: "command", command: nodeCmd(repo, "hooks/notify.mjs", "claude"), timeout: 5 }] }],
      },
      statusLine: { type: "command", command: nodeCmd(repo, "hooks/statusline.mjs", "claude"), refreshInterval: 2 },
    }),
    // Claude Code's own extension point: .md files under ~/.claude/commands/<subdir>/ become /<subdir>:<name>,
    // namespaced by directory so they can never collide with someone else's top-level command of the same name.
    commandsWire: ({ repo }) => ({
      dir: join(H, ".claude", "commands", "agent-channel"),
      source: join(repo, "commands"),
      files: ["inbox.md", "send.md", "handoff.md"],
      invokeAs: (f) => "/agent-channel:" + f.replace(/\.md$/, ""),
    }),
  },
  codex: {
    key: "codex", runtime: "codex", label: "Codex CLI", tokenEnv: "AGENTCHAN_CODEX_TOKEN", listener: true,
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false, supportsPreExec: false,
    hooksFile: join(H, ".codex", "hooks.json"),
    configFile: join(H, ".codex", "config.toml"),
    transcripts: { dir: join(H, ".codex", "sessions"), note: "YYYY/MM/DD/rollout-*.jsonl" },
    detect: () => existsSync(join(H, ".codex")) || !!which("codex"),
    // Windows: setup.mjs sets AGENTCHAN_CODEX_TOKEN with setx, so the env-var form works. macOS/Linux have no per-user env
    // store the Codex app reads, so the header goes into config.toml itself (same trust level as ~/.claude.json for Claude Code).
    mcpWire: ({ url, token }) => {
      const block = platform() === "win32" || !token
        ? "[mcp_servers.agent_channel]\nurl = \"" + url + "/mcp\"\nbearer_token_env_var = \"AGENTCHAN_CODEX_TOKEN\"\n"
        : "[mcp_servers.agent_channel]\nurl = \"" + url + "/mcp\"\nhttp_headers = { Authorization = \"Bearer " + token + "\" }\n";
      return {
      command: "add to ~/.codex/config.toml:\n" + block.replace(/Bearer ac_[^"]+/, "Bearer <your token>"),
      apply: () => {
        const f = join(H, ".codex", "config.toml");
        let cur = existsSync(f) ? readFileSync(f, "utf8") : "";
        if (cur.includes("[mcp_servers.agent_channel]")) return { ok: true, note: "already present" };
        mkdirSync(join(H, ".codex"), { recursive: true });
        writeFileSync(f, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + "\n" + block);
        return { ok: true };
      },
      check: () => { const f = join(H, ".codex", "config.toml"); return existsSync(f) ? readFileSync(f, "utf8").includes("[mcp_servers.agent_channel]") : false; },
      }; },
    hooksWire: ({ repo }) => ({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "codex", "SessionStart"), timeout: 8, statusMessage: "Checking Agent Channel..." }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "codex", "UserPromptSubmit"), timeout: 8, statusMessage: "Checking Agent Channel..." }] }],
      },
      note: "Codex asks you to trust hooks once via /hooks. It does not render systemMessage, so the model relays messages to you.",
    }),
    // Codex custom prompts live flat in ~/.codex/prompts/ (no subdirectory namespacing), so the filename itself carries
    // the agent-channel- prefix to avoid colliding with any prompt file someone already has. (OpenAI marks custom
    // prompts deprecated in favor of "Skills" as of 2026; still the working mechanism today — revisit if Codex drops it.)
    commandsWire: ({ repo }) => ({
      dir: join(H, ".codex", "prompts"),
      source: join(repo, "commands"),
      files: ["inbox.md", "send.md", "handoff.md"],
      prefix: "agent-channel-",
      invokeAs: (f) => "/prompts:agent-channel-" + f.replace(/\.md$/, ""),
    }),
  },
  "claude-desktop": {
    key: "claude-desktop", runtime: "claude-desktop", label: "Claude Desktop", tokenEnv: "AGENTCHAN_DESKTOP_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false, supportsPreExec: false,
    configFile: platform() === "win32" ? join(process.env.APPDATA || join(H, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
              : platform() === "darwin" ? join(H, "Library", "Application Support", "Claude", "claude_desktop_config.json")
              : join(H, ".config", "Claude", "claude_desktop_config.json"),
    detect() { return existsSync(dirnameOf(this.configFile)); },
    // Desktop launches stdio servers only, so bridge with mcp-remote. With a token: static header. Without: mcp-remote runs the OAuth flow in the browser.
    mcpWire({ url, token, oauth }) {
      const file = this.configFile;
      const args = ["-y", "mcp-remote", url + "/mcp", ...(token && !oauth ? ["--header", "Authorization: Bearer " + token] : [])];
      return {
        command: "add to " + file + ':\n"mcpServers": { "agent-channel": { "command": "npx", "args": ' + JSON.stringify(args) + " } }\n(or in Desktop: Settings > Connectors > Add custom connector > " + url + "/mcp and sign in)",
        apply: () => {
          let cur = {}; try { cur = JSON.parse(readFileSync(file, "utf8")); } catch {}
          cur.mcpServers = { ...(cur.mcpServers || {}), "agent-channel": { command: "npx", args } };
          mkdirSync(dirnameOf(file), { recursive: true });
          writeFileSync(file, JSON.stringify(cur, null, 2));
          return { ok: true, note: "restart Claude Desktop" };
        },
        check: () => { try { return !!JSON.parse(readFileSync(file, "utf8")).mcpServers?.["agent-channel"]; } catch { return false; } },
      };
    },
    hooksWire: () => ({ note: "Claude Desktop has no hooks: typed @handle messages go through the model (send_message); inbound arrives via my_inbox or the listener's toast." }),
  },
  gemini: geminiAdapter(),
  grok: grokAdapter(),
  // JSON-config MCP clients (no hooks; the model does the messaging and reads my_inbox). Each writes one entry into the
  // client's mcpServers file; tokens go in a header exactly like Claude Code's `claude mcp add --header`.
  // GitHub Copilot in VS Code. Verified against VS Code 1.121.0 and Copilot Chat 0.48.1 on 2026-08-27, not
  // documentation: the extension contributes `mcpServerDefinitions`, and VS Code resolves `mcpResource` to
  // mcp.json in the user profile. Its shape is NOT the mcpServers shape every other client uses -- workbench's
  // own sanitizeServer reads a top-level `servers` map and normalises `type` to "http" or "stdio", defaulting to
  // "http" when there is no `command`; `headers` is an object of strings in the same schema. A wrong container
  // key is silent: the server simply never appears, which is why this was read out of the binary.
  //
  // No hooks, by nature of being an editor extension: delivery is the model reading my_inbox plus the server's
  // `btw` piggyback on tool results (src/tools.js). That path is what test/btw-delivery.test.mjs exercises.
  copilot: jsonMcpAdapter({
    key: "copilot", runtime: "copilot", label: "GitHub Copilot (VS Code)",
    file: platform() === "win32" ? join(process.env.APPDATA || join(H, "AppData", "Roaming"), "Code", "User", "mcp.json")
        : platform() === "darwin" ? join(H, "Library", "Application Support", "Code", "User", "mcp.json")
        : join(H, ".config", "Code", "User", "mcp.json"),
    shape: "vscode", container: "servers",
    // its own agent, so /peek and /ack runtime scoping cannot confuse it with Claude Code
    tokenEnv: "AGENTCHAN_COPILOT_TOKEN",
  }),
  cursor: jsonMcpAdapter({ key: "cursor", runtime: "cursor", label: "Cursor", file: join(H, ".cursor", "mcp.json"), shape: "url", tokenEnv: "AGENTCHAN_CURSOR_TOKEN" }),
  windsurf: jsonMcpAdapter({ key: "windsurf", runtime: "windsurf", label: "Windsurf", file: join(H, ".codeium", "windsurf", "mcp_config.json"), shape: "serverUrl", tokenEnv: "AGENTCHAN_WINDSURF_TOKEN" }),
  generic: {
    // The fallback for any client we have no entry for, and for `wire --runtime <something-we-do-not-know>`.
    // Its tokenEnv used to be AGENTCHAN_TOKEN -- Claude Code's -- while its runtime is "other". On any machine
    // wired for Claude Code on Windows (where setup.mjs sets that variable with setx) wire therefore read
    // Claude Code's token, correctly saw the mismatch, minted an "other" agent, saved it to the file, and on
    // the next run read the environment again and never looked at the file it had just written. It minted
    // every run until the per-runtime cap of 4 stopped it, after which wire was a silent no-op. A shared
    // identity variable is a shared identity: /peek and /ack scope unread mail by the requesting agent's
    // runtime, so this one also let an unknown client read and ack Claude Code's handoffs.
    key: "generic", runtime: "other", label: "Any MCP client", tokenEnv: "AGENTCHAN_OTHER_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false, supportsPreExec: false,
    detect: () => true,
    mcpWire: ({ url, token }) => ({ command: "Streamable HTTP MCP: " + url + "/mcp with header Authorization: Bearer " + token, apply: () => ({ ok: false, why: "wire it in your client's MCP settings" }), check: () => null }),
    hooksWire: () => ({ note: "No hook system: use scripts/cli.mjs and the listener; type-to-send needs a UserPromptSubmit-style hook in your client." }),
  },
};

// ---------------------------------------------------------------- Gemini CLI
//
// Gemini CLI's hook system IS Claude Code's, renamed. Verified against an installed gemini 0.56.0 rather than
// documentation: the binary ships `gemini hooks migrate` ("Migrate hooks from Claude Code to Gemini CLI") and
// its own migrate.ts carries the table below verbatim. The payload on stdin is the same snake_case shape
// (hook_event_name, session_id, transcript_path, cwd, prompt, tool_name, tool_input, tool_response), the output
// contract is the same object (continue / stopReason / suppressOutput / systemMessage / decision / reason /
// hookSpecificOutput.additionalContext), and it even substitutes $CLAUDE_PROJECT_DIR. So the existing hooks run
// unmodified; only the event names and the tool names inside a matcher differ.
//
// The one behavioural difference that matters, and it decides the capability flags below: on a plain allow,
// BeforeAgent returns ONLY { additionalContext } and drops systemMessage on the floor. systemMessage reaches the
// human solely through AgentExecutionBlocked / AgentExecutionStopped, which the interactive UI renders as
// addItem({type:"warning"|"info"}). So the waiting banner reaches the model, not the human -- the same posture
// as Codex -- while the typed-@handle receipt, which blocks by design, IS shown. Claiming otherwise would make
// the banner silently invisible, which is the failure this file exists to prevent.
export const GEMINI_EVENTS = {
  PreToolUse: "BeforeTool",
  PostToolUse: "AfterTool",
  UserPromptSubmit: "BeforeAgent",
  Stop: "AfterAgent",
  SubAgentStop: "AfterAgent",
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  PreCompact: "PreCompress",
  Notification: "Notification",
};
export const GEMINI_TOOLS = { Edit: "replace", Bash: "run_shell_command", Read: "read_file", Write: "write_file", Glob: "glob", Grep: "grep", LS: "ls" };

/** Translate a Claude-shaped hooks block into Gemini's names. Event names AND the tool names inside a matcher:
 *  a matcher of "Bash" never fires in Gemini, whose shell tool is run_shell_command. Anything with no mapping is
 *  dropped rather than written under a name Gemini will ignore, and dropped events are returned so a caller can
 *  say so out loud instead of silently wiring less than it claims. */
export function toGeminiHooks(hooks) {
  const out = {};
  const dropped = [];
  for (const [ev, entries] of Object.entries(hooks || {})) {
    const g = GEMINI_EVENTS[ev];
    if (!g) { dropped.push(ev); continue; }
    const mapped = entries.map((e) => (e.matcher
      ? { ...e, matcher: e.matcher.split("|").map((t) => GEMINI_TOOLS[t] || t).join("|") }
      : e));
    out[g] = [...(out[g] || []), ...mapped];
  }
  return { hooks: out, dropped };
}

/** Read the event table out of the INSTALLED gemini, so a future release that renames an event is caught here
 *  instead of silently writing hooks that never fire. Returns null when the bundle cannot be located (npx cache,
 *  an unusual install) -- unknown is not the same as wrong, and the caller reports it as unverified. */
export function probeGeminiEvents() {
  const bin = which("gemini");
  if (!bin) return null;
  const roots = [
    join(H, "AppData", "Roaming", "npm", "node_modules", "@google", "gemini-cli", "bundle"),
    join(dirnameOf(bin), "node_modules", "@google", "gemini-cli", "bundle"),
    join(dirnameOf(bin), "..", "lib", "node_modules", "@google", "gemini-cli", "bundle"),
  ];
  for (const dir of roots) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".js")); } catch { continue; }
    for (const f of files) {
      let s = "";
      try { s = readFileSync(join(dir, f), "utf8"); } catch { continue; }
      const i = s.indexOf("EVENT_MAPPING");
      if (i < 0) continue;
      // stop at TOOL_NAME_MAPPING, which follows it: the two tables have the same shape and merging them would
      // put Bash/Edit/Read into an event table
      const rest = s.slice(i, i + 1200);
      const end = rest.indexOf("TOOL_NAME_MAPPING");
      const body = end > 0 ? rest.slice(0, end) : rest;
      const map = {};
      for (const m of body.matchAll(/(\w+):\s*"(\w+)"/g)) map[m[1]] = m[2];
      if (Object.keys(map).length) return { source: join(dir, f), mapping: map };
    }
  }
  return null;
}

function geminiAdapter() {
  const file = join(H, ".gemini", "settings.json");
  // Hooks and MCP servers share settings.json; mergeHooks + setup.mjs rewrite the whole file, so mcpWire is
  // reused unchanged and the two never clobber each other.
  const base = jsonMcpAdapter({ key: "gemini", runtime: "gemini-cli", label: "Gemini CLI", file, shape: "httpUrl" });
  return {
    ...base,
    // Its own token, not AGENTCHAN_TOKEN. Gemini pairs as a separate agent with runtime 'gemini-cli', and /peek
    // and /ack scope unread mail by that runtime; borrowing Claude Code's token would make Gemini claim-code's
    // handoffs and consume them.
    tokenEnv: "AGENTCHAN_GEMINI_TOKEN",
    rendersSystemMessage: false,   // only via a blocking decision; see the note above
    blocksPrompt: true,            // BeforeAgent honours decision:"block" -> AgentExecutionBlocked, and renders it
    supportsFileChanged: false,
    supportsStatusLine: false,
    supportsPreExec: true,         // BeforeTool + matcher run_shell_command can deny: the credential guard covers Gemini
    hooksFile: file,
    transcripts: { dir: join(H, ".gemini", "tmp"), note: "per-project chat logs; format differs from Claude Code" },
    detect: () => existsSync(join(H, ".gemini")) || !!which("gemini"),
    hooksWire: ({ repo }) => {
      const claudeShaped = {
        // --deny-shape: Gemini blocks on a TOP-LEVEL `decision`, Claude Code on hookSpecificOutput
        // .permissionDecision, and the shapes are mutually exclusive -- emitting both made Claude Code discard
        // the output and run the command (tested live 2026-08-27). The runtime's contract lives here, in its
        // adapter, so hooks/secret-guard.mjs needs to know no runtime names.
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: nodeCmd(repo, "hooks/secret-guard.mjs", "--deny-shape=decision"), timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "gemini", "SessionStart"), timeout: 8 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/inbox.mjs", "gemini", "UserPromptSubmit"), timeout: 8 }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: nodeCmd(repo, "hooks/btw.mjs", "gemini"), timeout: 5 }] }],
      };
      // The hooks keep taking Claude's event name on argv (inbox.mjs branches on it); only the KEY is renamed,
      // because argv wins over the stdin hook_event_name Gemini sends.
      const { hooks, dropped } = toGeminiHooks(claudeShaped);
      const probe = probeGeminiEvents();
      const drift = probe ? Object.entries(GEMINI_EVENTS).filter(([c, g]) => probe.mapping[c] && probe.mapping[c] !== g) : [];
      return {
        hooks,
        note: "Gemini renames Claude Code's hook events (UserPromptSubmit -> BeforeAgent, PostToolUse -> AfterTool). It does not show systemMessage on a normal turn, so the waiting banner reaches the model and the model relays it; a typed @handle receipt blocks, and that IS shown."
          + (dropped.length ? "\n  dropped (no Gemini equivalent): " + dropped.join(", ") : "")
          + (drift.length ? "\n  WARNING: the installed gemini maps " + drift.map(([c, g]) => c + " -> " + probe.mapping[c] + ", not " + g).join("; ") + ". These hooks may not fire; re-check lib/adapters.mjs." : "")
          + (probe ? "" : "\n  note: could not read the installed gemini's event table, so the names above are unverified on this machine."),
      };
    },
  };
}

// ---------------------------------------------------------------- Grok CLI
//
// xAI's grok 1.0.5. Verified against the installed grok.exe and the hook reference embedded in it, not against
// the 109KB README on disk, which documents only PreToolUse and never names the other events.
//
// It keeps Claude Code's event NAMES verbatim -- PreToolUse, PostToolUse, UserPromptSubmit, SessionStart,
// SessionEnd, Stop, SubagentStop all appear in the binary and BeforeAgent/AfterAgent appear nowhere -- so
// unlike Gemini there is no event table to translate. Two things differ, and both fail silently if assumed:
//
//  1. The stdin envelope is camelCase where every other runtime here is snake_case (`toolInput`, `hookEventName`,
//     `stopHookActive`, and `toolResult` for Claude's `tool_response`). hooks/secret-guard.mjs reads both
//     spellings for exactly this reason; a hook added later that reads only snake_case is blind on grok.
//  2. UserPromptSubmit is OBSERVE-ONLY. Its own reference says it plainly: "grok ignores its exit code and its
//     stdout, so an imported prompt-validation hook silently stops blocking. Use PreToolUse to enforce." The
//     wider rule in the same document is that every event except PreToolUse (deny) and Stop/SubagentStop
//     (block) is passive: "its output is recorded but does not change control flow."
//
// (2) is why this adapter wires ONE hook. The typed-@handle fast path in hooks/inbox.mjs works by sending the
// message and then BLOCKING the prompt so the model never sees it. On grok the block is discarded, so the
// prompt reaches the model too -- which reads "@sam ..." and sends it a second time through send_message.
// Wiring inbox.mjs here would buy a receipt nobody can see at the price of double-sending every typed message
// (the delivery bug 92d2aad already paid for once). So grok takes the Copilot posture for delivery: the model
// reads my_inbox and the server piggybacks `btw` on tool results (src/tools.js), which needs no hook at all.
//
// What IS worth wiring is the credential guard: PreToolUse can deny, its reason is shown to the model, and the
// refusal shape is the top-level {decision:"deny"} that --deny-shape=decision already emits for Gemini.
// So supportsPreExec is true and doctor is entitled to stay quiet about it.
//
// Hooks and MCP servers both live in ~/.grok/config.toml, which is a trusted config layer (a project's own
// .grok/config.toml may not define hooks at all, and global hooks "are always trusted and need no entry"), so
// there is no /hooks-trust step for the human to remember.
function grokAdapter() {
  const file = join(H, ".grok", "config.toml");
  const tokenEnv = "AGENTCHAN_GROK_TOKEN";
  return {
    key: "grok", runtime: "grok-cli", label: "Grok CLI", tokenEnv,
    rendersSystemMessage: false,   // no hook here renders to the human; the model relays, as on Codex
    blocksPrompt: false,           // UserPromptSubmit is observe-only: stdout and exit code are both ignored
    supportsFileChanged: false,
    supportsStatusLine: false,
    supportsPreExec: true,         // PreToolUse can deny, so the credential guard covers grok
    configFile: file,
    hooksFile: file,
    transcripts: { dir: join(H, ".grok", "sessions"), note: "one file per session; format differs from Claude Code" },
    detect: () => existsSync(join(H, ".grok")) || !!which("grok"),
    // Grok expands ${VAR} in MCP headers (user-guide/07-mcp-servers.md). A literal Bearer ac_ in this
    // file is how a Grok session silently authenticated as another runtime: the header was that
    // runtime's token, baked. The env-var form is the only form apply() writes.
    mcpWire: ({ url }) => {
      const block = '[mcp_servers.agent-channel]\nurl = "' + url + '/mcp"\nheaders = { Authorization = "Bearer ${' + tokenEnv + '}" }\n';
      return {
        command: "add to " + file + ":\n" + block,
        apply: () => { try { grokRewriteToml(file, "mcp", block); return { ok: true, note: "restart Grok CLI" }; } catch (e) { return { ok: false, why: String(e.message).slice(0, 200) }; } },
        check: () => { try { return readFileSync(file, "utf8").includes("[mcp_servers.agent-channel]"); } catch { return false; } },
        auth: () => grokMcpAuth(file, tokenEnv),
      };
    },
    hooksWire: ({ repo }) => ({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: nodeCmd(repo, "hooks/secret-guard.mjs", "--deny-shape=decision"), timeout: 5 }] }],
      },
      note: "Grok's UserPromptSubmit is observe-only (its stdout and exit code are ignored), so typing @handle does NOT send from the prompt here and no waiting banner is shown: the model reads my_inbox and the server attaches new mail to tool results. Only the credential guard is wired, on PreToolUse, which can deny.",
    }),
    // Grok's slash commands live flat in ~/.grok/commands/; /inbox /send /handoff, no namespace prefix.
    commandsWire: ({ repo }) => ({
      dir: join(H, ".grok", "commands"),
      source: join(repo, "commands"),
      files: ["inbox.md", "send.md", "handoff.md"],
      invokeAs: (f) => "/" + f.replace(/\.md$/, ""),
    }),
    // config.toml is TOML, so setup.mjs's JSON merge cannot write it. The adapter owns its own file.
    hooksApply({ repo }) {
      const hooks = this.hooksWire({ repo }).hooks;
      let toml = "";
      for (const [event, groups] of Object.entries(hooks)) {
        for (const g of groups) {
          toml += "[[hooks." + event + "]]\n";
          if (g.matcher) toml += 'matcher = "' + g.matcher + '"\n';
          for (const h of g.hooks || []) {
            toml += "  [[hooks." + event + ".hooks]]\n";
            toml += '  type = "' + (h.type || "command") + '"\n';
            toml += '  command = "' + h.command.replace(/"/g, '\\"') + '"\n';
            if (h.timeout) toml += "  timeout = " + h.timeout + "\n";
          }
        }
      }
      try { grokRewriteToml(file, "hooks", toml); return { ok: true, wrote: Object.keys(hooks) }; }
      catch (e) { return { ok: false, why: String(e.message).slice(0, 200) }; }
    },
  };
}

const GROK_MCP = "mcp_servers.agent-channel";
const grokMcpOurs = (name) => name === GROK_MCP || name.startsWith(GROK_MCP + ".");

function tomlTables(txt) {
  const out = [];
  const re = /^[ \t]*(\[\[)([^\]\r\n]+)(\]\])[ \t]*(?:#.*)?\r?$|^[ \t]*(\[)([^\]\r\n]+)(\])[ \t]*(?:#.*)?\r?$/gm;
  for (const m of txt.matchAll(re)) {
    if (m[1]) out.push({ start: m.index, name: m[2].trim(), array: true });
    else out.push({ start: m.index, name: m[5].trim(), array: false });
  }
  return out;
}

function grokFences(txt, name) {
  const open = "# >>> agent-channel " + name, close = "# <<< agent-channel " + name;
  const ranges = [];
  let i = 0;
  while (i < txt.length) {
    const a = txt.indexOf(open, i);
    if (a < 0) break;
    const b = txt.indexOf(close, a);
    ranges.push([a, b < 0 ? txt.length : b + close.length]);
    i = b < 0 ? txt.length : b + close.length;
  }
  return ranges;
}

function inRanges(pos, ranges) {
  for (const [a, b] of ranges) if (pos >= a && pos < b) return true;
  return false;
}

function cutRanges(txt, cuts) {
  if (!cuts.length) return txt;
  const merged = [];
  for (const c of cuts.slice().sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([c[0], c[1]]);
  }
  let out = "", pos = 0;
  for (const [a, b] of merged) { out += txt.slice(pos, a); pos = b; }
  return out + txt.slice(pos);
}

function grokTableEnd(tables, i, len) {
  return i + 1 < tables.length ? tables[i + 1].start : len;
}

// Grok (or its config rewrite) stores nested tables and drops our managed-section comments.
// writeTomlSection only replaces a fenced block; without a pre-strip it would append a second copy.
function stripUnfencedGrokMcp(txt) {
  const fences = grokFences(txt, "mcp");
  const tables = tomlTables(txt);
  const cuts = [];
  for (let i = 0; i < tables.length; i++) {
    if (!grokMcpOurs(tables[i].name) || inRanges(tables[i].start, fences)) continue;
    cuts.push([tables[i].start, grokTableEnd(tables, i, txt.length)]);
  }
  return cutRanges(txt, cuts);
}

function stripUnfencedGrokHooks(txt) {
  const fences = grokFences(txt, "hooks");
  const tables = tomlTables(txt);
  const cuts = [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (!t.array || !/^hooks\.[^.]+$/.test(t.name) || inRanges(t.start, fences)) continue;
    let end = txt.length;
    for (let j = i + 1; j < tables.length; j++) {
      if (tables[j].name.startsWith(t.name + ".")) continue;
      end = tables[j].start;
      break;
    }
    if (!txt.slice(t.start, end).includes("secret-guard.mjs")) continue;
    cuts.push([t.start, end]);
  }
  return cutRanges(txt, cuts);
}

function grokRewriteToml(file, name, body) {
  let cur = "";
  try { cur = readFileSync(file, "utf8"); } catch {}
  const stripped = name === "mcp" ? stripUnfencedGrokMcp(cur)
    : name === "hooks" ? stripUnfencedGrokHooks(cur)
    : cur;
  if (stripped !== cur) {
    mkdirSync(dirnameOf(file), { recursive: true });
    writeFileSync(file, stripped);
  }
  return writeTomlSection(file, name, body);
}

/** How the Grok MCP Authorization header is stored. check() is only "is the section present"; this is the
 *  identity question. A baked Bearer ac_ is the other runtime's token sitting in Grok's config.
 *  Grok rewrites headers as a nested [mcp_servers.agent-channel.headers] table; cutting at the first
 *  \n[ stops there and never sees Authorization, which is how doctor called the live env form baked. */
export function grokMcpAuth(file, tokenEnv) {
  let txt = "";
  try { txt = readFileSync(file, "utf8"); } catch { return { mode: "missing" }; }
  const tables = tomlTables(txt);
  let section = "";
  for (let i = 0; i < tables.length; i++) {
    if (!grokMcpOurs(tables[i].name)) continue;
    section += txt.slice(tables[i].start, grokTableEnd(tables, i, txt.length));
  }
  if (!section) return { mode: "missing" };
  const vals = [...section.matchAll(/(?:^|[{\s,])(?:"Authorization"|Authorization)\s*=\s*"([^"]*)"/gim)].map((m) => m[1]);
  if (!vals.length) return { mode: "missing" };
  const needle = "${" + tokenEnv + "}";
  const nonempty = vals.filter((v) => v.length > 0);
  if (!nonempty.length) return { mode: "missing" };
  if (nonempty.some((v) => !v.includes(needle))) return { mode: "baked" };
  return { mode: "env" };
}

/** Replace (or append) one delimited block in a TOML file, leaving every other line untouched. TOML has no
 *  merge semantics we can rely on and the file is the human's own, so ours is fenced by sentinels and rewritten
 *  whole; anything outside the fence -- their [cli], [marketplace], their own hooks -- survives verbatim. */
export function writeTomlSection(file, name, body) {
  const open = "# >>> agent-channel " + name, close = "# <<< agent-channel " + name;
  let cur = "";
  try { cur = readFileSync(file, "utf8"); } catch {}
  const fenced = open + " (managed; edits here are overwritten by setup.mjs)\n" + body.trimEnd() + "\n" + close + "\n";
  const re = new RegExp("^" + open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n?", "m");
  const next = re.test(cur) ? cur.replace(re, fenced) : cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "\n" + fenced;
  mkdirSync(dirnameOf(file), { recursive: true });
  writeFileSync(file, next);
  return next;
}

function jsonMcpAdapter({ key, runtime, label, file, shape, container = "mcpServers", tokenEnv = "AGENTCHAN_TOKEN" }) {
  // Each client names the same three things differently, and a wrong key is not an error anywhere -- the server
  // simply never appears. `container` is the top-level map: VS Code calls it `servers`, everyone else
  // `mcpServers`. Verified per client rather than assumed; see the copilot entry.
  const entry = (url, token) => shape === "httpUrl" ? { httpUrl: url + "/mcp", headers: { Authorization: "Bearer " + token } }
    : shape === "serverUrl" ? { serverUrl: url + "/mcp", headers: { Authorization: "Bearer " + token } }
    : shape === "vscode" ? { type: "http", url: url + "/mcp", headers: { Authorization: "Bearer " + token } }
    : { url: url + "/mcp", headers: { Authorization: "Bearer " + token } };
  return {
    key, runtime, label, tokenEnv,
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false, supportsPreExec: false,
    configFile: file,
    detect: () => existsSync(dirnameOf(file)),
    mcpWire: ({ url, token }) => ({
      command: "add to " + file + ':\n"' + container + '": { "agent-channel": ' + JSON.stringify(entry(url, "<your token>")) + " }",
      apply: () => {
        let cur = {}; try { cur = JSON.parse(readFileSync(file, "utf8")); } catch {}
        cur[container] = { ...(cur[container] || {}), "agent-channel": entry(url, token) };
        mkdirSync(dirnameOf(file), { recursive: true });
        writeFileSync(file, JSON.stringify(cur, null, 2));
        return { ok: true, note: "restart " + label };
      },
      check: () => { try { return !!JSON.parse(readFileSync(file, "utf8"))[container]?.["agent-channel"]; } catch { return false; } },
    }),
    hooksWire: () => ({ note: label + " has no hook system: typed @handle messages go through the model (send_message); inbound arrives when the model reads my_inbox (the server instructions tell it to at session start)." }),
  };
}

export const adapterFor = (nameOrRuntime) => {
  const k = String(nameOrRuntime || "").toLowerCase().replace(/-code$/, "").replace(/-cli$/, "");
  return ADAPTERS[k] || (k === "claude-code" ? ADAPTERS.claude : null) || ADAPTERS.generic;
};

export function which(bin) {
  try { return execFileSync(platform() === "win32" ? "where" : "which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean)[0] || null; }
  catch { return null; }
}

/** Merge our hook entries into an existing hooks JSON without clobbering unrelated hooks (dedup by command substring 'agent-channel/hooks'). */
export function mergeHooks(existing, ours) {
  const out = { ...(existing || {}) };
  out.hooks = { ...(out.hooks || {}) };
  for (const [ev, entries] of Object.entries(ours.hooks || {})) {
    const cur = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    const isOurs = (h) => /(agent-channel|\.agentchan[\\/]client)[\\/]hooks[\\/]/i.test(h.command || "");
    const kept = cur.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => (g.hooks || []).length || g.matcher);
    out.hooks[ev] = [...kept.filter((g) => (g.hooks || []).length), ...entries];
  }
  if (ours.statusLine && !out.statusLine) out.statusLine = ours.statusLine;
  return out;
}
