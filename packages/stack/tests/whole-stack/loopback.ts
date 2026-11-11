import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { captureWorkloads, commandOutput } from "./workloads.ts";
import type { WholeStack } from "./fixture.ts";

export type LoopbackViolation = Readonly<{
  readonly pid: number;
  readonly address: string;
  readonly command: string;
}>;

type ProcessEntry = Readonly<{
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}>;

const processTable = Effect.fn("WholeStack.loopback.processTable")(() =>
  Effect.gen(function* () {
    const output = yield* commandOutput("ps", ["-axo", "pid=,ppid=,command="]);
    const entries: Array<ProcessEntry> = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
    }
    return entries;
  }),
);

const rootWorkloadPids = (identities: ReadonlyArray<string>): ReadonlyArray<number> =>
  identities
    .map((identity) => /^\s*(\d+)\s/.exec(identity)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);

/** Walks the host's process table so a workload's descendants are covered: the native launcher
 * spawns each workload into its own separate process group, not the launcher's. */
const descendantsOf = (roots: ReadonlyArray<number>, entries: ReadonlyArray<ProcessEntry>) => {
  const byParent = new Map<number, Array<number>>();
  for (const entry of entries) {
    const list = byParent.get(entry.ppid) ?? [];
    list.push(entry.pid);
    byParent.set(entry.ppid, list);
  }
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const child of byParent.get(current) ?? [])
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
  }
  return [...seen];
};

type RawSocket = Readonly<{ readonly pid: number; readonly address: string }>;

const darwinListeners = Effect.fn("WholeStack.loopback.darwinListeners")(
  (pids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      if (pids.length === 0) return [] as ReadonlyArray<RawSocket>;
      const output = yield* commandOutput("lsof", [
        "-nP",
        "-a",
        "-iTCP",
        "-sTCP:LISTEN",
        "-p",
        pids.join(","),
      ]);
      const sockets: Array<RawSocket> = [];
      for (const line of output.split("\n").slice(1)) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const fields = trimmed.split(/\s+/);
        const pid = Number(fields[1]);
        const address = fields.at(-2);
        if (!Number.isFinite(pid) || address === undefined) continue;
        sockets.push({ pid, address });
      }
      return sockets;
    }),
);

const linuxListeners = Effect.fn("WholeStack.loopback.linuxListeners")(
  (pids: ReadonlySet<number>) =>
    Effect.gen(function* () {
      const output = yield* commandOutput("ss", ["-ltnpH"]);
      const sockets: Array<RawSocket> = [];
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const fields = trimmed.split(/\s+/);
        const address = fields[3];
        const processField = fields.at(-1);
        const pidMatch = processField === undefined ? null : /pid=(\d+)/.exec(processField);
        if (address === undefined || pidMatch === null) continue;
        const pid = Number(pidMatch[1]);
        if (!pids.has(pid)) continue;
        sockets.push({ pid, address });
      }
      return sockets;
    }),
);

const hostOf = (address: string): string => {
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    return end === -1 ? address : address.slice(1, end);
  }
  const lastColon = address.lastIndexOf(":");
  return lastColon === -1 ? address : address.slice(0, lastColon);
};

const isLoopbackAddress = (address: string): boolean => {
  const host = hostOf(address);
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
};

/**
 * Enumerates every listening TCP socket owned by a native stack's workload process trees (the
 * launcher and every descendant it spawns) and reports the ones bound outside loopback. Windows'
 * native backend is out of scope; callers skip this on `process.platform === "win32"`.
 */
export const captureLoopbackViolations = Effect.fn("WholeStack.loopback.captureLoopbackViolations")(
  (fixture: WholeStack) =>
    Effect.gen(function* () {
      const workloads = yield* captureWorkloads("native", fixture);
      const roots = rootWorkloadPids(workloads.identities);
      expect(roots.length).toBeGreaterThan(0);
      const entries = yield* processTable();
      const pids = descendantsOf(roots, entries);
      const commands = new Map(entries.map((entry) => [entry.pid, entry.command] as const));
      const sockets =
        process.platform === "linux"
          ? yield* linuxListeners(new Set(pids))
          : yield* darwinListeners(pids);
      return sockets
        .filter((socket) => !isLoopbackAddress(socket.address))
        .map((socket): LoopbackViolation => ({
          pid: socket.pid,
          address: socket.address,
          command: commands.get(socket.pid) ?? `pid ${socket.pid}`,
        }));
    }),
);
