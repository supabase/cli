import { expect } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Schema } from "effect";
import { service, type Runtime, type WholeStack } from "./fixture.ts";

export const WorkloadSnapshot = Schema.Struct({
  identities: Schema.Array(Schema.String),
  markers: Schema.Array(Schema.String),
});
export type WorkloadSnapshot = Schema.Schema.Type<typeof WorkloadSnapshot>;

const commandOutput = Effect.fn("WholeStack.commandOutput")(
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
      return { identities, markers: [stackMarker, databaseMarker] } satisfies WorkloadSnapshot;
    }
    const marker = `com.supabase.stack=${fixture.stack.id}`;
    const output = yield* commandOutput("docker", [
      "ps",
      ...(includeStopped ? ["--all"] : []),
      "--filter",
      `label=${marker}`,
      "--format",
      '{{.ID}} {{.Label "com.supabase.instance"}}',
    ]);
    return {
      identities: output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      markers: [marker],
    } satisfies WorkloadSnapshot;
  });

export const captureWorkloads = Effect.fn("WholeStack.captureWorkloads")(
  (runtime: Runtime, fixture: WholeStack, includeStopped = false) =>
    snapshotOutput(runtime, fixture, includeStopped),
);

export const assertWorkloadsGone = Effect.fn("WholeStack.assertWorkloadsGone")(
  (runtime: Runtime, fixture: WholeStack, snapshot: WorkloadSnapshot, includeStopped = false) =>
    Effect.gen(function* () {
      expect(snapshot.identities.length).toBeGreaterThan(0);
      const current = yield* snapshotOutput(runtime, fixture, includeStopped);
      if (runtime === "docker") expect(current.identities).toEqual([]);
      for (const marker of snapshot.markers)
        expect(current.identities.some((identity) => identity.includes(marker))).toBe(false);
      for (const identity of snapshot.identities)
        expect(current.identities).not.toContain(identity);
    }),
);
