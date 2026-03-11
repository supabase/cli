import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

interface AgentConfig {
  readonly name: string;
  readonly displayName: string;
  readonly skillsDir: string;
  readonly detect: () => boolean;
}

const home = homedir();
const configHome = join(home, ".config");
const cwd = process.cwd();
const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");

// Agent registry ported from:
// https://github.com/vercel-labs/skills/blob/b248cdf08f647faf8b7a00e4d89344d9b83ab0e1/src/agents.ts
const agents: ReadonlyArray<AgentConfig> = [
  {
    name: "amp",
    displayName: "Amp",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(configHome, "amp")),
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
    skillsDir: ".agent/skills",
    detect: () => existsSync(join(home, ".gemini/antigravity")),
  },
  {
    name: "augment",
    displayName: "Augment",
    skillsDir: ".augment/skills",
    detect: () => existsSync(join(home, ".augment")),
  },
  {
    name: "claude-code",
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    detect: () => existsSync(claudeHome),
  },
  {
    name: "openclaw",
    displayName: "OpenClaw",
    skillsDir: "skills",
    detect: () =>
      existsSync(join(home, ".openclaw")) ||
      existsSync(join(home, ".clawdbot")) ||
      existsSync(join(home, ".moltbot")),
  },
  {
    name: "cline",
    displayName: "Cline",
    skillsDir: ".cline/skills",
    detect: () => existsSync(join(home, ".cline")),
  },
  {
    name: "codebuddy",
    displayName: "CodeBuddy",
    skillsDir: ".codebuddy/skills",
    detect: () => existsSync(join(cwd, ".codebuddy")) || existsSync(join(home, ".codebuddy")),
  },
  {
    name: "codex",
    displayName: "Codex",
    skillsDir: ".agents/skills",
    detect: () => existsSync(codexHome) || existsSync("/etc/codex"),
  },
  {
    name: "command-code",
    displayName: "Command Code",
    skillsDir: ".commandcode/skills",
    detect: () => existsSync(join(home, ".commandcode")),
  },
  {
    name: "continue",
    displayName: "Continue",
    skillsDir: ".continue/skills",
    detect: () => existsSync(join(cwd, ".continue")) || existsSync(join(home, ".continue")),
  },
  {
    name: "cortex",
    displayName: "Cortex Code",
    skillsDir: ".cortex/skills",
    detect: () => existsSync(join(home, ".snowflake/cortex")),
  },
  {
    name: "crush",
    displayName: "Crush",
    skillsDir: ".crush/skills",
    detect: () => existsSync(join(configHome, "crush")),
  },
  {
    name: "cursor",
    displayName: "Cursor",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(home, ".cursor")),
  },
  {
    name: "droid",
    displayName: "Droid",
    skillsDir: ".factory/skills",
    detect: () => existsSync(join(home, ".factory")),
  },
  {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(home, ".gemini")),
  },
  {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(home, ".copilot")),
  },
  {
    name: "goose",
    displayName: "Goose",
    skillsDir: ".goose/skills",
    detect: () => existsSync(join(configHome, "goose")),
  },
  {
    name: "iflow-cli",
    displayName: "iFlow CLI",
    skillsDir: ".iflow/skills",
    detect: () => existsSync(join(home, ".iflow")),
  },
  {
    name: "junie",
    displayName: "Junie",
    skillsDir: ".junie/skills",
    detect: () => existsSync(join(home, ".junie")),
  },
  {
    name: "kilo",
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    detect: () => existsSync(join(home, ".kilocode")),
  },
  {
    name: "kimi-cli",
    displayName: "Kimi Code CLI",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(home, ".kimi")),
  },
  {
    name: "kiro-cli",
    displayName: "Kiro CLI",
    skillsDir: ".kiro/skills",
    detect: () => existsSync(join(home, ".kiro")),
  },
  {
    name: "kode",
    displayName: "Kode",
    skillsDir: ".kode/skills",
    detect: () => existsSync(join(home, ".kode")),
  },
  {
    name: "mcpjam",
    displayName: "MCPJam",
    skillsDir: ".mcpjam/skills",
    detect: () => existsSync(join(home, ".mcpjam")),
  },
  {
    name: "mistral-vibe",
    displayName: "Mistral Vibe",
    skillsDir: ".vibe/skills",
    detect: () => existsSync(join(home, ".vibe")),
  },
  {
    name: "mux",
    displayName: "Mux",
    skillsDir: ".mux/skills",
    detect: () => existsSync(join(home, ".mux")),
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(configHome, "opencode")),
  },
  {
    name: "openhands",
    displayName: "OpenHands",
    skillsDir: ".openhands/skills",
    detect: () => existsSync(join(home, ".openhands")),
  },
  {
    name: "pi",
    displayName: "Pi",
    skillsDir: ".pi/skills",
    detect: () => existsSync(join(home, ".pi/agent")),
  },
  {
    name: "pochi",
    displayName: "Pochi",
    skillsDir: ".pochi/skills",
    detect: () => existsSync(join(home, ".pochi")),
  },
  {
    name: "qoder",
    displayName: "Qoder",
    skillsDir: ".qoder/skills",
    detect: () => existsSync(join(home, ".qoder")),
  },
  {
    name: "qwen-code",
    displayName: "Qwen Code",
    skillsDir: ".qwen/skills",
    detect: () => existsSync(join(home, ".qwen")),
  },
  {
    name: "replit",
    displayName: "Replit",
    skillsDir: ".agents/skills",
    detect: () => existsSync(join(cwd, ".replit")),
  },
  {
    name: "roo",
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    detect: () => existsSync(join(home, ".roo")),
  },
  {
    name: "trae",
    displayName: "Trae",
    skillsDir: ".trae/skills",
    detect: () => existsSync(join(home, ".trae")),
  },
  {
    name: "trae-cn",
    displayName: "Trae CN",
    skillsDir: ".trae/skills",
    detect: () => existsSync(join(home, ".trae-cn")),
  },
  {
    name: "windsurf",
    displayName: "Windsurf",
    skillsDir: ".windsurf/skills",
    detect: () => existsSync(join(home, ".codeium/windsurf")),
  },
  {
    name: "zencoder",
    displayName: "Zencoder",
    skillsDir: ".zencoder/skills",
    detect: () => existsSync(join(home, ".zencoder")),
  },
  {
    name: "neovate",
    displayName: "Neovate",
    skillsDir: ".neovate/skills",
    detect: () => existsSync(join(home, ".neovate")),
  },
  {
    name: "adal",
    displayName: "AdaL",
    skillsDir: ".adal/skills",
    detect: () => existsSync(join(home, ".adal")),
  },
];

interface DetectedAgent {
  readonly displayName: string;
  readonly skillsDir: string;
}

export function detectAgents(): ReadonlyArray<DetectedAgent> {
  const seen = new Set<string>();
  const result: DetectedAgent[] = [];
  for (const agent of agents) {
    if (agent.detect() && !seen.has(agent.skillsDir)) {
      seen.add(agent.skillsDir);
      result.push({ displayName: agent.displayName, skillsDir: agent.skillsDir });
    }
  }
  return result;
}
