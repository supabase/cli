import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { terminateChildProcess } from "../../src/terminateChild.ts";

const STANDALONE_SCRIPT = resolve(import.meta.dirname, "standalone-stack.ts");
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 2_000;

export interface SpawnedStackInfo {
  readonly url: string;
  readonly dbUrl: string;
  readonly process: ChildProcess;
}

export interface SpawnStandaloneStackOptions {
  /** Overridable for unit tests only; the e2e suite always runs the real script. */
  readonly command?: readonly [string, ...string[]];
  readonly readinessTimeoutMs?: number;
  /**
   * Fired the moment the child exists, before readiness. Callers register the
   * handle here so teardown can terminate every spawned child even when the
   * readiness promise never resolved — a `Promise.all` that dies on one stack
   * must not orphan its siblings.
   */
  readonly onSpawn?: (child: ChildProcess) => void;
}

/**
 * Spawns one standalone stack subprocess and resolves when it reports
 * readiness (a single JSON line on stdout). Unlike a bare spawn-and-parse,
 * every way the child can fail settles the promise with the evidence attached:
 *
 * - exit before readiness — ANY code, including 0 — rejects with the code and
 *   the child's stderr, so a stack that dies cleanly during bring-up cannot
 *   turn into an opaque hook timeout with its error discarded;
 * - readiness not reported within `readinessTimeoutMs` rejects with the
 *   stdout/stderr collected so far and terminates the child, so a bring-up
 *   that wedges (e.g. a port race) fails fast and names the last thing the
 *   stack said instead of burning the whole hook budget.
 */
export function spawnStandaloneStack(
  opts: SpawnStandaloneStackOptions = {},
): Promise<SpawnedStackInfo> {
  const [command, ...args] = opts.command ?? [
    "bun",
    "run",
    STANDALONE_SCRIPT,
    "--parent-pid",
    String(process.pid),
  ];
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    opts.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (outcome: { info?: SpawnedStackInfo; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(readinessTimer);
      if (outcome.info !== undefined) resolvePromise(outcome.info);
      else rejectPromise(outcome.error);
    };

    const outputTail = () =>
      `stdout: ${stdout.slice(-OUTPUT_TAIL_CHARS) || "(none)"}\nstderr: ${
        stderr.slice(-OUTPUT_TAIL_CHARS) || "(none)"
      }`;

    const readinessTimer = setTimeout(() => {
      settle({
        error: new Error(
          `Stack did not report readiness within ${readinessTimeoutMs}ms\n${outputTail()}`,
        ),
      });
      // Reclaim the unusable child; the 30s window matches the suite's own
      // sweep so SIGKILL doesn't cut a wedged stack's dispose short.
      void terminateChildProcess(child, { timeoutMs: 30_000 });
    }, readinessTimeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        try {
          const info = JSON.parse(stdout.slice(0, newline));
          settle({ info: { url: info.url, dbUrl: info.dbUrl, process: child } });
        } catch {
          settle({ error: new Error(`Failed to parse stack info: ${stdout.slice(0, newline)}`) });
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => settle({ error: err }));
    // Any exit before readiness is a failure — including a clean 0.
    child.on("exit", (code) => {
      settle({
        error: new Error(
          `Stack process exited with code ${code} before readiness\n${outputTail()}`,
        ),
      });
    });
  });
}
