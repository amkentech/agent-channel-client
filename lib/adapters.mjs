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
//   hooksFile / mcp     where the wiring lives, and how to write it
//   transcripts         where session transcripts live (for export-conversation)
import { homedir, platform } from "node:os";
import { join, dirname as dirnameOf } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const H = homedir();
// hook command lines run through a shell on every OS; forward slashes work on Windows too, and a path with spaces
// ("/Users/Jo Smith/.agentchan/client") must stay quoted
const nodeCmd = (repo, rel, ...a) => { const p = join(repo, rel).replace(/\\/g, "/"); return ["node", /\s/.test(p) ? '"' + p + '"' : p, ...a].join(" "); };

export const ADAPTERS = {
  claude: {
    key: "claude", runtime: "claude-code", label: "Claude Code", tokenEnv: "AGENTCHAN_TOKEN",
    rendersSystemMessage: true, blocksPrompt: true, supportsFileChanged: true, supportsStatusLine: true,
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
      files: ["inbox.md", "send.md"],
      invokeAs: (f) => "/agent-channel:" + f.replace(/\.md$/, ""),
    }),
  },
  codex: {
    key: "codex", runtime: "codex", label: "Codex CLI", tokenEnv: "AGENTCHAN_CODEX_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false,
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
      files: ["inbox.md", "send.md"],
      prefix: "agent-channel-",
      invokeAs: (f) => "/prompts:agent-channel-" + f.replace(/\.md$/, ""),
    }),
  },
  "claude-desktop": {
    key: "claude-desktop", runtime: "claude-desktop", label: "Claude Desktop", tokenEnv: "AGENTCHAN_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false,
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
  // JSON-config MCP clients (no hooks; the model does the messaging and reads my_inbox). Each writes one entry into the
  // client's mcpServers file; tokens go in a header exactly like Claude Code's `claude mcp add --header`.
  cursor: jsonMcpAdapter({ key: "cursor", runtime: "cursor", label: "Cursor", file: join(H, ".cursor", "mcp.json"), shape: "url" }),
  gemini: jsonMcpAdapter({ key: "gemini", runtime: "gemini-cli", label: "Gemini CLI", file: join(H, ".gemini", "settings.json"), shape: "httpUrl" }),
  windsurf: jsonMcpAdapter({ key: "windsurf", runtime: "windsurf", label: "Windsurf", file: join(H, ".codeium", "windsurf", "mcp_config.json"), shape: "serverUrl" }),
  generic: {
    key: "generic", runtime: "other", label: "Any MCP client", tokenEnv: "AGENTCHAN_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false,
    detect: () => true,
    mcpWire: ({ url, token }) => ({ command: "Streamable HTTP MCP: " + url + "/mcp with header Authorization: Bearer " + token, apply: () => ({ ok: false, why: "wire it in your client's MCP settings" }), check: () => null }),
    hooksWire: () => ({ note: "No hook system: use scripts/cli.mjs and the listener; type-to-send needs a UserPromptSubmit-style hook in your client." }),
  },
};

function jsonMcpAdapter({ key, runtime, label, file, shape }) {
  const entry = (url, token) => shape === "httpUrl" ? { httpUrl: url + "/mcp", headers: { Authorization: "Bearer " + token } }
    : shape === "serverUrl" ? { serverUrl: url + "/mcp", headers: { Authorization: "Bearer " + token } }
    : { url: url + "/mcp", headers: { Authorization: "Bearer " + token } };
  return {
    key, runtime, label, tokenEnv: "AGENTCHAN_TOKEN",
    rendersSystemMessage: false, blocksPrompt: false, supportsFileChanged: false, supportsStatusLine: false,
    configFile: file,
    detect: () => existsSync(dirnameOf(file)),
    mcpWire: ({ url, token }) => ({
      command: "add to " + file + ':\n"mcpServers": { "agent-channel": ' + JSON.stringify(entry(url, "<your token>")) + " }",
      apply: () => {
        let cur = {}; try { cur = JSON.parse(readFileSync(file, "utf8")); } catch {}
        cur.mcpServers = { ...(cur.mcpServers || {}), "agent-channel": entry(url, token) };
        mkdirSync(dirnameOf(file), { recursive: true });
        writeFileSync(file, JSON.stringify(cur, null, 2));
        return { ok: true, note: "restart " + label };
      },
      check: () => { try { return !!JSON.parse(readFileSync(file, "utf8")).mcpServers?.["agent-channel"]; } catch { return false; } },
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
