import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schedule, Schema } from "effect";
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { controlEndpoint, type ControlEndpoint } from "./managed/control.ts";
import { deriveStackId, type EnvironmentIdentity } from "./managed/environment.ts";
import { managedStackDocumentPathEffect } from "./managed/paths.ts";
import {
  CompiledSupervisorParentEventSchema,
  type CompiledSupervisorStartMessage,
} from "../tests/helpers/compiled-supervisor-parent.ts";
import { SupervisorStartCommandSchema } from "./SupervisorProtocol.ts";

const execFileAsync = promisify(execFile);
const bunExecutable = process.env["BUN_EXECUTABLE"] ?? "bun";
const parentEntryPoint = fileURLToPath(
  new URL("../tests/helpers/compiled-supervisor-parent.ts", import.meta.url),
);

interface TestRoots {
  readonly root: string;
  readonly stateRoot: string;
  readonly stackId: string;
}

interface CompiledParent {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
}

let artifactRoot: string;
let compiledParentPath: string;

const makeWorkspace = (): TestRoots => {
  const root = mkdtempSync(join(tmpdir(), "sup-stack-compiled-workspace-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "sup-stack-compiled-state-"));
  const identity: EnvironmentIdentity = {
    workspaceId: crypto.randomUUID(),
    checkoutId: crypto.randomUUID(),
    contextId: crypto.randomUUID(),
    localProjectKey: ".",
  };
  mkdirSync(join(root, ".supabase"), { recursive: true });
  writeFileSync(
    join(root, ".supabase", "identity.json"),
    `${JSON.stringify({ version: 1, ...identity }, null, 2)}\n`,
  );
  return { root, stateRoot, stackId: deriveStackId(identity, "default") };
};

const messageFor = (
  roots: TestRoots,
  overrides: Partial<CompiledSupervisorStartMessage> = {},
): CompiledSupervisorStartMessage => ({
  type: "start",
  cliVersion: "2.61.0",
  stackId: roots.stackId,
  workspacePath: roots.root,
  stackName: "default",
  stateRoot: roots.stateRoot,
  config: {
    cwd: roots.root,
    projectDir: roots.root,
    mode: "native",
    auth: false,
    postgrest: false,
    realtime: false,
    storage: false,
    imgproxy: false,
    localSmtp: false,
    pgmeta: false,
    studio: false,
    analytics: false,
    vector: false,
    pooler: false,
  },
  portIntents: { activeFields: ["apiPort", "dbPort"], document: {} },
  launch: {
    mode: "native",
    versions: { postgres: "pinned-postgres" },
    excludedServices: ["analytics"],
  },
  ...overrides,
});

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

const spawnCompiledParent = (
  input: CompiledSupervisorStartMessage,
  environment: Readonly<Record<string, string>> = {},
): CompiledParent => {
  const child = fork(parentEntryPoint, [], {
    execPath: compiledParentPath,
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      SUPABASE_STACK_TEST_PLATFORM: "bun",
      ...environment,
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderr += new TextDecoder().decode(chunk);
  });
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      let event: Schema.Schema.Type<typeof CompiledSupervisorParentEventSchema>;
      try {
        event = Schema.decodeUnknownSync(CompiledSupervisorParentEventSchema)(raw);
      } catch {
        return;
      }
      if (event.type === "ready") {
        cleanup();
        resolve();
      } else {
        cleanup();
        reject(new Error(`${event.message}\n${stderr}`));
      }
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `compiled supervisor parent exited (${String(code)}, ${String(signal)})\n${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const encoded = Schema.encodeSync(SupervisorStartCommandSchema)(input);
  child.send(encoded);
  return { child, ready, exited: waitForExit(child) };
};

const owner = async (endpoint: ControlEndpoint) => {
  const response = await fetch(`${endpoint.url}/owner`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    readonly ownershipId: string;
    readonly ownerSessionId: string;
    readonly daemonCliVersion: string;
    readonly state: string;
    readonly ready: boolean;
  };
};

const stop = async (
  endpoint: ControlEndpoint,
  ownershipId: string,
  ownerSessionId: string,
): Promise<Response> =>
  fetch(`${endpoint.url}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ ownershipId, ownerSessionId }),
  });

const waitForProcessExit = (pid: number): Promise<void> => {
  const attempt = Effect.try({
    try: () => {
      process.kill(pid, 0);
      return false;
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(true)));
  const probe = attempt.pipe(
    Effect.flatMap((exited) => (exited ? Effect.succeed(true) : Effect.fail(new Error("alive")))),
    Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
    Effect.asVoid,
  );
  return Effect.runPromise(probe);
};

const documentFor = (roots: TestRoots) => {
  const path = Effect.runSync(managedStackDocumentPathEffect(roots.stateRoot, roots.stackId));
  return { path, value: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
};

const waitForDocumentLifecycle = (roots: TestRoots, lifecycle: string): Promise<void> => {
  const path = Effect.runSync(managedStackDocumentPathEffect(roots.stateRoot, roots.stackId));
  const probe = Effect.try({
    try: () => {
      const value = JSON.parse(readFileSync(path, "utf8")) as { readonly lifecycle?: string };
      if (value.lifecycle !== lifecycle) throw new Error("document lifecycle has not settled");
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
    Effect.asVoid,
  );
  return Effect.runPromise(probe);
};

class EndpointStillAliveError extends Error {}

const waitForEndpointUnavailable = (endpoint: ControlEndpoint): Promise<void> => {
  const attempt = Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${endpoint.url}/owner`);
      if (response.ok) throw new EndpointStillAliveError();
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof EndpointStillAliveError ? Effect.fail(cause) : Effect.succeed(undefined),
    ),
    Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
    Effect.asVoid,
  );
  return Effect.runPromise(attempt);
};

const endpointFor = (roots: TestRoots): Promise<ControlEndpoint> =>
  Effect.runPromise(controlEndpoint(roots.stackId));

const cleanup = (roots: TestRoots): void => {
  rmSync(roots.root, { recursive: true, force: true });
  rmSync(roots.stateRoot, { recursive: true, force: true });
};

const killPid = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

describe("compiled Bun detached supervisor", () => {
  beforeAll(async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), "sup-stack-compiled-artifact-"));
    compiledParentPath = join(artifactRoot, "compiled-supervisor-parent");
    await execFileAsync(bunExecutable, [
      "build",
      parentEntryPoint,
      "--compile",
      `--outfile=${compiledParentPath}`,
    ]);
  }, 120_000);

  afterAll(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  test("starts, attaches, session-stops, and upgrade-restarts through compiled child re-entry", async () => {
    const roots = makeWorkspace();
    let first: CompiledParent | undefined;
    let attached: CompiledParent | undefined;
    let upgradeRestart: CompiledParent | undefined;
    const runtimePids = new Set<number>();
    try {
      const endpoint = await endpointFor(roots);
      first = spawnCompiledParent(messageFor(roots));
      await first.ready;
      const firstOwner = await owner(endpoint);
      expect(firstOwner).toMatchObject({
        ownershipId: roots.stackId,
        daemonCliVersion: "2.61.0",
        state: "running",
        ready: true,
      });
      const before = documentFor(roots).value;
      const runtime = before["runtime"] as { readonly pid: number };
      runtimePids.add(runtime.pid);
      const pathsRoot = dirname(documentFor(roots).path);
      const sentinel = join(pathsRoot, "data", "compiled-preservation.txt");
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, "compiled-preserve");

      attached = spawnCompiledParent(messageFor(roots));
      await attached.ready;
      expect(await owner(endpoint)).toMatchObject({
        ownerSessionId: firstOwner.ownerSessionId,
        daemonCliVersion: firstOwner.daemonCliVersion,
        state: "running",
      });
      await attached.exited;

      const stopped = await stop(endpoint, firstOwner.ownershipId, firstOwner.ownerSessionId);
      expect(stopped.status).toBe(202);
      await waitForProcessExit(runtime.pid);
      await first.exited;
      await waitForDocumentLifecycle(roots, "stopped");
      await waitForEndpointUnavailable(endpoint);
      expect(documentFor(roots).value["lifecycle"] as string).toBe("stopped");

      first = spawnCompiledParent(
        messageFor(roots, {
          cliVersion: "2.60.0",
          launch: {
            mode: "native",
            versions: { postgres: "old-pinned" },
            excludedServices: ["analytics"],
          },
        }),
      );
      await first.ready;
      const oldOwner = await owner(endpoint);
      const oldDocument = documentFor(roots).value;
      const oldRuntime = oldDocument["runtime"] as { readonly pid: number };
      runtimePids.add(oldRuntime.pid);
      const oldLaunch = oldDocument["launch"];
      const oldPorts = oldDocument["ports"];
      writeFileSync(sentinel, "upgrade-restart-preserve");

      upgradeRestart = spawnCompiledParent(
        messageFor(roots, {
          type: "upgrade-restart",
          cliVersion: "2.61.0",
          launch: {
            mode: "native",
            versions: { postgres: "new-default" },
            excludedServices: [],
          },
        }),
      );
      await upgradeRestart.ready;
      await waitForProcessExit(oldRuntime.pid);
      await first.exited;
      const currentOwner = await owner(endpoint);
      expect(currentOwner).toMatchObject({
        daemonCliVersion: "2.61.0",
        state: "running",
        ready: true,
      });
      expect(currentOwner.ownerSessionId).not.toBe(oldOwner.ownerSessionId);
      const staleStop = await stop(endpoint, oldOwner.ownershipId, oldOwner.ownerSessionId);
      expect(staleStop.status).toBe(409);
      const after = documentFor(roots).value;
      expect(after["id"]).toBe(oldDocument["id"]);
      expect(after["createdAt"]).toBe(oldDocument["createdAt"]);
      expect(after["launch"]).toEqual(oldLaunch);
      expect(after["ports"]).toEqual(oldPorts);
      expect(readFileSync(sentinel, "utf8")).toBe("upgrade-restart-preserve");

      const restartedRuntime = after["runtime"] as { readonly pid: number };
      runtimePids.add(restartedRuntime.pid);
      expect(
        await stop(endpoint, currentOwner.ownershipId, currentOwner.ownerSessionId),
      ).toMatchObject({
        status: 202,
      });
      await waitForProcessExit(restartedRuntime.pid);
      await upgradeRestart.exited;
    } finally {
      for (const pid of runtimePids) killPid(pid);
      for (const handle of [first, attached, upgradeRestart]) {
        if (handle?.child.exitCode === null) handle.child.kill("SIGKILL");
      }
      cleanup(roots);
    }
  }, 120_000);

  test("recovers a stale current-build owner through compiled re-entry", async () => {
    const roots = makeWorkspace();
    let ownerParent: CompiledParent | undefined;
    let recovery: CompiledParent | undefined;
    const runtimePids = new Set<number>();
    try {
      const endpoint = await endpointFor(roots);
      ownerParent = spawnCompiledParent(messageFor(roots));
      await ownerParent.ready;
      const stale = await owner(endpoint);
      const document = documentFor(roots).value;
      const staleRuntime = document["runtime"] as { readonly pid: number };
      runtimePids.add(staleRuntime.pid);
      process.kill(staleRuntime.pid, "SIGKILL");
      await waitForProcessExit(staleRuntime.pid);
      await ownerParent.exited;

      recovery = spawnCompiledParent(messageFor(roots));
      await recovery.ready;
      const current = await owner(endpoint);
      expect(current).toMatchObject({
        ownershipId: roots.stackId,
        daemonCliVersion: "2.61.0",
        state: "running",
        ready: true,
      });
      expect(current.ownerSessionId).not.toBe(stale.ownerSessionId);
      const currentDocument = documentFor(roots).value;
      const currentRuntime = currentDocument["runtime"] as { readonly pid: number };
      runtimePids.add(currentRuntime.pid);
      expect(await stop(endpoint, current.ownershipId, current.ownerSessionId)).toMatchObject({
        status: 202,
      });
      await waitForProcessExit(currentRuntime.pid);
      await recovery.exited;
    } finally {
      for (const pid of runtimePids) killPid(pid);
      for (const handle of [ownerParent, recovery]) {
        if (handle?.child.exitCode === null) handle.child.kill("SIGKILL");
      }
      cleanup(roots);
    }
  }, 120_000);
});
