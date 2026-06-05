import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type BinaryResolution } from "../../shared/legacy/go-proxy.layer.ts";
import { type CompletePassthroughDeps, tryCompletePassthrough } from "./complete-passthrough.ts";

function spawnResult(status: number | null, error?: Error): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status,
    signal: null,
    error,
  };
}

function makeDeps(overrides: Partial<CompletePassthroughDeps> = {}): {
  deps: CompletePassthroughDeps;
  spawnCalls: Array<{ cmd: string; args: ReadonlyArray<string> }>;
  stderr: Array<string>;
  exits: Array<number>;
} {
  const spawnCalls: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const stderr: Array<string> = [];
  const exits: Array<number> = [];
  const deps: CompletePassthroughDeps = {
    argv: ["__complete", "migration", "li"],
    resolveBinary: (): BinaryResolution => ({ found: "/path/to/supabase-go" }),
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return spawnResult(0);
    },
    stderrWrite: (msg) => {
      stderr.push(msg);
    },
    exit: (code) => {
      exits.push(code);
    },
    ...overrides,
  };
  return { deps, spawnCalls, stderr, exits };
}

describe("tryCompletePassthrough", () => {
  it("returns false and does nothing when first argv is not __complete", () => {
    const { deps, spawnCalls, exits } = makeDeps({ argv: ["migration", "list"] });
    expect(tryCompletePassthrough(deps)).toBe(false);
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("returns false on empty argv (e.g. bare `supabase`)", () => {
    const { deps, spawnCalls, exits } = makeDeps({ argv: [] });
    expect(tryCompletePassthrough(deps)).toBe(false);
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("forwards verbatim argv (including flag-like tokens) to the Go binary on __complete", () => {
    const { deps, spawnCalls, exits } = makeDeps({
      argv: ["__complete", "--debug", "migration", "--de"],
    });
    expect(tryCompletePassthrough(deps)).toBe(true);
    expect(spawnCalls).toEqual([
      { cmd: "/path/to/supabase-go", args: ["__complete", "--debug", "migration", "--de"] },
    ]);
    expect(exits).toEqual([0]);
  });

  it("propagates the child's non-zero exit code", () => {
    const spawn = vi.fn(() => spawnResult(7));
    const { deps, exits } = makeDeps({ spawn });
    tryCompletePassthrough(deps);
    expect(exits).toEqual([7]);
  });

  it("exits 1 when the child has a null status (e.g. signal-terminated)", () => {
    const spawn = vi.fn(() => spawnResult(null));
    const { deps, exits } = makeDeps({ spawn });
    tryCompletePassthrough(deps);
    expect(exits).toEqual([1]);
  });

  it("prints the diagnostic and exits 1 when the Go binary cannot be resolved", () => {
    const { deps, spawnCalls, stderr, exits } = makeDeps({
      resolveBinary: () => ({ notFound: ["a", "b"] }),
    });
    tryCompletePassthrough(deps);
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([1]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("Could not find the `supabase-go` binary.");
  });

  it("prints the spawn error and exits 1 when spawnSync surfaces an error", () => {
    const spawn = vi.fn(() => spawnResult(0, new Error("ENOENT")));
    const { deps, stderr, exits } = makeDeps({ spawn });
    tryCompletePassthrough(deps);
    expect(exits).toEqual([1]);
    expect(stderr).toEqual(["ENOENT\n"]);
  });
});
