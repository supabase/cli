import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dirname, "sweep-live-projects.sh");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

type Scenario = {
  lists: Array<unknown>;
  deletes: Record<string, { status: number; body?: unknown }>;
};

async function runSweep(scenario: Scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), "sweep-live-projects-"));
  directories.push(directory);
  const fakeSleep = path.join(directory, "sleep");
  await writeFile(fakeSleep, "#!/bin/sh\nexit 0\n");
  await chmod(fakeSleep, 0o755);

  let listIndex = 0;
  const deletes: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const ref = url.pathname.split("/").pop() ?? "";
      if (request.method === "GET" && url.pathname === "/v1/projects") {
        const value = scenario.lists[Math.min(listIndex++, scenario.lists.length - 1)];
        return typeof value === "number"
          ? new Response("temporary failure", { status: value })
          : Response.json(value);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/v1/projects/")) {
        deletes.push(ref);
        const result = scenario.deletes[ref] ?? { status: 404 };
        return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
          status: result.status,
          headers: { "x-request-id": `delete-${ref}` },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const child = Bun.spawn(["bash", script, "e2e-"], {
      env: {
        ...globalThis.process.env,
        PATH: `${directory}:${globalThis.process.env.PATH}`,
        SUPABASE_ACCESS_TOKEN: "test-token",
        SUPABASE_LIVE_API_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    return { exitCode, stdout, stderr, deletes };
  } finally {
    await server.stop(true);
  }
}

const active = (ref: string, name = `e2e-${ref}`) => ({ ref, name, status: "ACTIVE" });

describe("sweep-live-projects.sh", () => {
  test("accepts refused deletion when a fresh authenticated list shows absence", async () => {
    const result = await runSweep({
      lists: [[active("gone")], []],
      deletes: { gone: { status: 403, body: { message: "already removed" } } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.deletes).toEqual(["gone"]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("test-token");
  });

  test("accepts a terminal status and converges after a stale list", async () => {
    const result = await runSweep({
      lists: [[active("stale")], [active("stale")], [{ ...active("stale"), status: "REMOVED" }]],
      deletes: { stale: { status: 202 } },
    });
    expect(result.exitCode).toBe(0);
  });

  test("retries a transient read failure but rejects malformed evidence", async () => {
    const transient = await runSweep({
      lists: [503, [active("retry")], []],
      deletes: { retry: { status: 202 } },
    });
    expect(transient.exitCode).toBe(0);

    const malformed = await runSweep({ lists: [{ projects: [] }], deletes: {} });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.deletes).toEqual([]);
  });

  test("fails terminal listing errors without retrying or deleting", async () => {
    const forbidden = await runSweep({ lists: [403, []], deletes: {} });
    expect(forbidden.exitCode).not.toBe(0);
    expect(forbidden.deletes).toEqual([]);

    const unavailable = await runSweep({ lists: [503, 503, 503], deletes: {} });
    expect(unavailable.exitCode).not.toBe(0);
    expect(unavailable.deletes).toEqual([]);

    const malformedReconciliation = await runSweep({
      lists: [[active("bad-evidence")], { projects: [] }],
      deletes: { "bad-evidence": { status: 403 } },
    });
    expect(malformedReconciliation.exitCode).not.toBe(0);
  });

  test("attempts every owned project and fails if one remains active", async () => {
    const result = await runSweep({
      lists: [
        [active("stuck"), active("other"), { ref: "foreign", name: "unrelated", status: "ACTIVE" }],
        [active("stuck"), { ref: "foreign", name: "unrelated", status: "ACTIVE" }],
      ],
      deletes: { stuck: { status: 403 }, other: { status: 204 } },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.deletes).toEqual(["stuck", "other"]);
  });
});
