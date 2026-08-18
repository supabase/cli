import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { terminateChildProcess } from "../../src/terminateChild.ts";
import { spawnStandaloneStack } from "./spawn-stack.ts";

const dir = mkdtempSync(join(tmpdir(), "spawn-stack-unit-"));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

function stub(name: string, source: string): readonly [string, ...string[]] {
  const path = join(dir, name);
  writeFileSync(path, source);
  return ["bun", "run", path];
}

const track = (child: ChildProcess) => children.push(child);

describe("spawnStandaloneStack", () => {
  test("resolves with the reported url/dbUrl and a live process handle", async () => {
    const command = stub(
      "ok.ts",
      `console.log(JSON.stringify({ url: "http://127.0.0.1:59991", dbUrl: "postgresql://127.0.0.1:59992/x" }));
       setInterval(() => {}, 60_000);`,
    );
    const info = await spawnStandaloneStack({ command, onSpawn: track });
    expect(info.url).toBe("http://127.0.0.1:59991");
    expect(info.dbUrl).toBe("postgresql://127.0.0.1:59992/x");
    expect(info.process.exitCode).toBeNull();
  });

  test("rejects with the exit code and stderr when the child dies cleanly before readiness", async () => {
    // The pre-fix harness only rejected on a NON-zero exit, so this exact
    // child left the promise pending until the 90s hook timeout, with the
    // stderr below discarded — the opaque paired-timeout CI failure.
    const command = stub(
      "silent-exit0.ts",
      `process.stderr.write("boot: port 54322 already bound, giving up\\n");
       process.exit(0);`,
    );
    await expect(spawnStandaloneStack({ command, onSpawn: track })).rejects.toThrow(
      /exited with code 0 before readiness[\s\S]*port 54322 already bound/,
    );
  });

  test("rejects on readiness timeout and reclaims the child", async () => {
    const command = stub(
      "hang.ts",
      `process.stderr.write("boot: waiting for postgres socket...\\n");
       setInterval(() => {}, 60_000);`,
    );
    const spawned: ChildProcess[] = [];
    let exited:
      | Promise<{
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }>
      | undefined;
    await expect(
      spawnStandaloneStack({
        command,
        readinessTimeoutMs: 1_500,
        onSpawn: (child) => {
          track(child);
          spawned.push(child);
          exited = new Promise((resolve) =>
            child.once("exit", (code, signal) => resolve({ code, signal })),
          );
        },
      }),
    ).rejects.toThrow(/did not report readiness within 1500ms/);
    // The helper terminates its own unusable child rather than leaving an
    // interval-driven zombie for suite teardown to hunt.
    const exit = await exited;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(spawned[0]?.killed).toBe(true);
  });

  test("rejects on an unparseable readiness line", async () => {
    const command = stub("garbage.ts", `console.log("not json"); setInterval(() => {}, 60_000);`);
    await expect(spawnStandaloneStack({ command, onSpawn: track })).rejects.toThrow(
      /Failed to parse stack info: not json/,
    );
  });

  test("registers every child via onSpawn before readiness, so a failed sibling cannot orphan a healthy one", async () => {
    const okCommand = stub(
      "ok-sibling.ts",
      `console.log(JSON.stringify({ url: "http://127.0.0.1:59993", dbUrl: "postgresql://127.0.0.1:59994/x" }));
       setInterval(() => {}, 60_000);`,
    );
    const badCommand = stub("bad-sibling.ts", `process.exit(0);`);

    const registered: ChildProcess[] = [];
    const results = await Promise.allSettled([
      spawnStandaloneStack({ onSpawn: (c) => registered.push(c), command: okCommand }),
      spawnStandaloneStack({ onSpawn: (c) => registered.push(c), command: badCommand }),
    ]);
    children.push(...registered);

    expect(registered).toHaveLength(2);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    // The healthy sibling's handle is reachable through the registry even
    // though Promise.all-style consumption would have discarded its value.
    const healthy = registered.find((c) => c.exitCode === null);
    expect(healthy).toBeDefined();
  });

  test("teardown sweep over a dead child is a no-op", async () => {
    // The incident replay: one sibling died before readiness, teardown then
    // sweeps every registered child with a 30s timeout. Before the
    // already-exited guard in terminateChildProcess this call burned 60s
    // doing nothing — reproducing the afterAll hook timeout it was meant to
    // prevent.
    const command = stub("dead-sweep.ts", `process.exit(0);`);
    const registered: ChildProcess[] = [];
    await spawnStandaloneStack({ command, onSpawn: (c) => registered.push(c) }).catch(() => {});
    expect(registered[0]?.exitCode).toBe(0);
    await terminateChildProcess(registered[0]!, { timeoutMs: 30_000 });
    expect(registered[0]?.exitCode).toBe(0);
  });
});
