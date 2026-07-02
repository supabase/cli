// OpenCode-backed release-notes generator.
//
// Drives an agentic run through the OpenCode SDK, which is provider-agnostic:
// the same tools and prompt run against whichever `providerID/modelID` is
// selected (see select-model.ts). OpenCode spawns its own `opencode serve`
// process (the `opencode-ai` binary must be on PATH — `pnpm exec` handles
// that) and reads provider credentials from the environment
// (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).
import { createOpencode } from "@opencode-ai/sdk";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

// The SDK spawns the `opencode` binary by name via cross-spawn. Always prepend
// the workspace-pinned shim when present — a globally installed `opencode` on
// PATH (often a different version with OAuth plugins) must not shadow the
// `opencode-ai` dependency this script depends on.
function ensureOpencodeOnPath(): void {
  const delimiter = path.delimiter;
  let dir = import.meta.dir;
  for (;;) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (existsSync(path.join(bin, "opencode"))) {
      const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
      if (!pathEntries.includes(bin)) {
        process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not find the `opencode` binary. Run `pnpm install` so the opencode-ai dependency is available.",
      );
    }
    dir = parent;
  }
}

export interface GenerateNotesResult {
  /** Final assistant markdown — the release-notes body. */
  text: string;
  /** Run cost in USD, when the provider reports one. */
  costUsd?: number;
}

// Investigation uses `webfetch` only (to open PR/issue URLs and the public
// GitHub REST API). `bash` is deliberately OFF: the prompt embeds untrusted
// third-party commit messages / PR titles, so a bash-enabled agent could be
// prompt-injected into exfiltrating the provider key or GH_TOKEN from the
// process environment (a spawned shell inherits it). Denying the shell removes
// that path entirely. File-mutating tools stay off too — the script owns the
// final notes file (mutation is also denied via the `edit` permission below).
const TOOLS: Record<string, boolean> = {
  webfetch: true,
  bash: false,
  write: false,
  edit: false,
};

/** OpenCode server config for a non-interactive, API-key-only run. */
function serverConfig(model: string) {
  const providerId = model.slice(0, model.indexOf("/"));
  return {
    model,
    // Do not inherit a developer's global OpenCode plugins (OAuth auth shims,
    // skills, etc.) — CI has none, but locally they can hijack the provider
    // and crash API-key models like openai/gpt-5-mini.
    plugin: [] as string[],
    instructions: [] as string[],
    enabled_providers: [providerId],
    permission: {
      webfetch: "allow" as const,
      // No shell for an agent that processes untrusted commit text: denying
      // bash removes the prompt-injection → secret-exfil path entirely.
      bash: "deny" as const,
      // The script owns the final release-notes file — the agent must never
      // mutate the filesystem. `edit` gates edit/write and the patch
      // (`apply_patch`) tool, so denying it here is the real guard.
      edit: "deny" as const,
    },
  };
}

/** Pick a free localhost port so a stale `opencode serve` on 4096 cannot block runs. */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Failed to reserve a free port for OpenCode")));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function generateNotes(args: {
  prompt: string;
  /** OpenCode-valid model id in `provider/model` form, e.g. `openai/gpt-5-mini`. */
  model: string;
  log: (line: string) => void;
}): Promise<GenerateNotesResult> {
  const { prompt, model, log } = args;

  // Run in an empty scratch directory so OpenCode does not pick up this repo's
  // AGENTS.md as agent instructions — the prompt is self-contained, and
  // `gh`/`webfetch` are cwd-independent (auth via GH_TOKEN). This reproduces
  // the previous `settingSources: []` isolation.
  const directory = await mkdtemp(path.join(tmpdir(), "release-notes-"));

  // OpenCode always merges ~/.config/opencode (plugins, OAuth provider shims,
  // custom model tables). On a developer machine that hijacks API-key models
  // and crashes openai/* runs; CI has no such config. Point HOME at an empty
  // temp dir for the server lifetime so only OPENCODE_CONFIG_CONTENT applies.
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "release-notes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = isolatedHome;

  ensureOpencodeOnPath();
  log(`==> Starting OpenCode server`);
  // `config.model` sets the session's default model, so the prompt below omits
  // `body.model`. OpenCode resolves the provider and its credential (e.g.
  // ANTHROPIC_API_KEY / OPENAI_API_KEY) from the environment via ai-sdk +
  // models.dev — no provider wiring needed on our side.
  //
  // bash/webfetch/external_directory default to "ask", which hangs in CI and
  // other non-interactive runs — allow them explicitly for the investigation
  // tools the prompt requires.
  let server: { close(): void } | undefined;
  try {
    const opencode = await createOpencode({
      config: serverConfig(model),
      port: await reserveFreePort(),
      timeout: 30_000,
    });
    server = opencode.server;
    const { client } = opencode;
    const session = await client.session.create({ query: { directory } });
    if (session.error || !session.data) {
      throw new Error(`Failed to create OpenCode session: ${JSON.stringify(session.error)}`);
    }

    log(`==> Prompting ${model}`);
    const result = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory },
      body: {
        tools: TOOLS,
        parts: [{ type: "text", text: prompt }],
      },
    });
    if (result.error || !result.data) {
      throw new Error(`OpenCode prompt failed: ${JSON.stringify(result.error)}`);
    }

    const { info, parts } = result.data;
    if (info.error) {
      throw new Error(`OpenCode run errored: ${JSON.stringify(info.error)}`);
    }

    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();

    return { text, costUsd: info.cost };
  } finally {
    server?.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(isolatedHome, { recursive: true, force: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
