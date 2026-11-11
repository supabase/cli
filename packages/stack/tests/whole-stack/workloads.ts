import { expect } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Schema } from "effect";
import { service, type Runtime, type WholeStack } from "./fixture.ts";

export const WorkloadSnapshot = Schema.Struct({
  identities: Schema.Array(Schema.String),
  managedIdentities: Schema.Array(Schema.String),
  markers: Schema.Array(Schema.String),
});
export type WorkloadSnapshot = Schema.Schema.Type<typeof WorkloadSnapshot>;

const PodmanContainers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Labels: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

export const commandOutput = Effect.fn("WholeStack.commandOutput")(
  (command: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* spawner.string(
        ChildProcess.make(command, args, { stdout: "pipe", stderr: "pipe" }),
      );
    }),
);

const snapshotOutput = (runtime: Runtime, fixture: WholeStack, includeStopped: boolean) =>
  Effect.gen(function* () {
    if (runtime === "native") {
      const stackMarker = `supabase-stack-id=${fixture.stack.id}`;
      const databaseMarker = `supabase-workload-id=${service(fixture, "database").id}`;
      const output = yield* commandOutput("ps", ["-axo", "pid=,command="]);
      const identities = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(stackMarker) || line.includes(databaseMarker));
      return {
        identities,
        managedIdentities: [],
        markers: [stackMarker, databaseMarker],
      } satisfies WorkloadSnapshot;
    }
    const marker = `com.supabase.stack=${fixture.stack.id}`;
    const listArgs = ["ps", ...(includeStopped ? ["--all"] : []), "--filter", `label=${marker}`];
    // Podman's `ps` templates read labels differently across versions; its JSON is stable.
    const listed =
      runtime === "docker"
        ? (yield* commandOutput(runtime, [
            ...listArgs,
            "--format",
            '{{.ID}}\t{{.Label "com.supabase.instance"}}\t{{.Label "com.supabase.stack-managed"}}',
          ]))
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => {
              const [id, instance, managed] = line.split("\t");
              return { id, instance, managed };
            })
        : (yield* Schema.decodeEffect(PodmanContainers)(
            yield* commandOutput(runtime, [...listArgs, "--format", "json"]),
          )).map(({ Id, Labels }) => ({
            id: Id,
            instance: Labels["com.supabase.instance"],
            managed: Labels["com.supabase.stack-managed"],
          }));
    const records = listed
      .map(({ id, instance, managed }) => ({
        identity: `${id ?? ""} ${instance ?? ""}`.trim(),
        instance,
        managed,
      }))
      // The stack label alone also tags best-effort containers that carry neither an instance
      // nor a `stack-managed` identity, such as the host-gateway probe (see `readProbeHosts` in
      // `Container.ts`); only the two documented identity labels promise a workload.
      .filter((record) => (record.instance ?? "") !== "" || record.managed === "true");
    return {
      identities: records
        .filter((record) => record.managed !== "true")
        .map((record) => record.identity),
      managedIdentities: records
        .filter((record) => record.managed === "true")
        .map((record) => record.identity),
      markers: [marker],
    } satisfies WorkloadSnapshot;
  });

export const captureWorkloads = Effect.fn("WholeStack.captureWorkloads")(
  (runtime: Runtime, fixture: WholeStack, includeStopped = false) =>
    snapshotOutput(runtime, fixture, includeStopped),
);

/**
 * Kills one instance's workload the way a crash would: SIGKILL of the native workload process
 * (the launcher's child, so the launcher survives to report the exit), or `kill` of its container.
 */
export const killWorkload = Effect.fn("WholeStack.killWorkload")(
  (runtime: Runtime, fixture: WholeStack, instanceId: string) =>
    Effect.gen(function* () {
      const { identities } = yield* snapshotOutput(runtime, fixture, false);
      if (runtime !== "native") {
        const container = identities
          .map((identity) => identity.split(" "))
          .find(([, instance]) => instance === instanceId)?.[0];
        if (container === undefined) return yield* Effect.die(`No container for ${instanceId}`);
        yield* commandOutput(runtime, ["kill", container]);
        return;
      }
      const launcher = identities
        .map((identity) => /^(\d+)\s.*supabase-workload-id=(\S+)$/.exec(identity))
        .find((match) => match?.[2] === instanceId)?.[1];
      if (launcher === undefined) return yield* Effect.die(`No launcher for ${instanceId}`);
      const children = (yield* commandOutput("ps", ["-axo", "pid=,ppid="]))
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
        .filter((match) => match?.[2] === launcher)
        .map((match) => match?.[1] ?? "");
      if (children.length === 0) return yield* Effect.die(`No workload under launcher ${launcher}`);
      yield* commandOutput("kill", ["-9", ...children]);
    }),
);

export const assertWorkloadsGone = Effect.fn("WholeStack.assertWorkloadsGone")(
  (runtime: Runtime, fixture: WholeStack, snapshot: WorkloadSnapshot, includeStopped = false) =>
    Effect.gen(function* () {
      expect(snapshot.identities.length).toBeGreaterThan(0);
      const current = yield* snapshotOutput(runtime, fixture, includeStopped);
      if (runtime !== "native") expect(current.identities).toEqual([]);
      if (runtime !== "native" && includeStopped) expect(current.managedIdentities).toEqual([]);
      for (const marker of snapshot.markers)
        expect(current.identities.some((identity) => identity.includes(marker))).toBe(false);
      for (const identity of snapshot.identities)
        expect(current.identities).not.toContain(identity);
    }),
);
