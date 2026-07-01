// OpenCode-backed release-notes generator.
//
// Drives an agentic run through the OpenCode SDK, which is provider-agnostic:
// the same tools and prompt run against whichever `providerID/modelID` is
// selected (see select-model.ts). OpenCode spawns its own `opencode serve`
// process (the `opencode-ai` binary must be on PATH — `pnpm exec` handles
// that) and reads provider credentials from the environment
// (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).
import { createOpencode } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { ModelRef } from "./select-model.ts";

// The SDK spawns the `opencode` binary by name via cross-spawn, so it must be
// resolvable on PATH. `pnpm exec` adds node_modules/.bin automatically, but a
// bare `bun apps/cli/scripts/...` invocation does not — walk up from this file
// to the nearest node_modules/.bin that carries the shim and prepend it.
function ensureOpencodeOnPath(): void {
  const delimiter = path.delimiter;
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(path.join(dir, "opencode")));
  if (onPath) return;

  let dir = import.meta.dir;
  for (;;) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (existsSync(path.join(bin, "opencode"))) {
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
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

// Investigation needs `bash` (for authenticated `gh` queries) and `webfetch`
// (to open PR/issue URLs). File-mutating tools stay off — the calling script
// owns the final release-notes file, matching the previous Claude setup that
// deliberately excluded Edit/Write.
const TOOLS: Record<string, boolean> = {
  bash: true,
  webfetch: true,
  write: false,
  edit: false,
  patch: false,
};

export async function generateNotes(args: {
  prompt: string;
  model: ModelRef;
  log: (line: string) => void;
}): Promise<GenerateNotesResult> {
  const { prompt, model, log } = args;

  // Run in an empty scratch directory so OpenCode does not pick up this repo's
  // AGENTS.md as agent instructions — the prompt is self-contained, and
  // `gh`/`webfetch` are cwd-independent (auth via GH_TOKEN). This reproduces
  // the previous `settingSources: []` isolation.
  const directory = await mkdtemp(path.join(tmpdir(), "release-notes-"));

  ensureOpencodeOnPath();
  log(`==> Starting OpenCode server`);
  const { client, server } = await createOpencode({ timeout: 30_000 });
  try {
    const session = await client.session.create({ query: { directory } });
    if (session.error || !session.data) {
      throw new Error(`Failed to create OpenCode session: ${JSON.stringify(session.error)}`);
    }

    log(`==> Prompting ${model.providerID}/${model.modelID}`);
    const result = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory },
      body: {
        model,
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
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
