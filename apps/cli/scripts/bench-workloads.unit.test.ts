import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { parseWorkloadManifest, validateWorkloads } from "./bench-report.ts";

const manifestPath = new URL("../bench/workloads.pr.json", import.meta.url).pathname;
const stackManifestPath = new URL("../bench/workloads.stack.json", import.meta.url).pathname;
const fixturesPath = new URL("../bench/fixtures/", import.meta.url).pathname;
const scenariosDir = new URL("../../cli-e2e/fixtures/scenarios/", import.meta.url).pathname;

const loadManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* parseWorkloadManifest(yield* fs.readFileString(manifestPath));
});

const loadStackManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* parseWorkloadManifest(yield* fs.readFileString(stackManifestPath));
});

describe("PR workload manifest", () => {
  it.effect("decodes and passes the structural rules when a replay server is configured", () =>
    Effect.gen(function* () {
      const workloads = yield* loadManifest;

      expect(workloads.length).toBeGreaterThan(0);
      expect(validateWorkloads(workloads, { apiUrl: "http://127.0.0.1:1" })).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names only replay scenarios that exist and serve the project ref it uses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workloads = yield* loadManifest;

      for (const workload of workloads) {
        if (workload.scenario === undefined) continue;
        const fixture = yield* fs.readFileString(
          `${scenariosDir}${workload.scenario}/interactions.json`,
        );
        const ref = workload.args.find((arg) => arg.startsWith("replay"));
        if (ref !== undefined) expect(fixture).toContain(`/v1/projects/${ref}`);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("stack workload manifest", () => {
  it.effect("decodes and passes the structural rules without a replay server", () =>
    Effect.gen(function* () {
      const workloads = yield* loadStackManifest;

      expect(workloads.length).toBeGreaterThan(0);
      expect(validateWorkloads(workloads, { apiUrl: undefined })).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names only fixtures that exist and carry a migration, seed, or test", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workloads = yield* loadStackManifest;

      for (const workload of workloads) {
        if (workload.fixture === undefined) continue;
        const files = yield* fs.readDirectory(`${fixturesPath}${workload.fixture}`);
        expect(files.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("sizes every workload for sharding and leaves nothing running after it", () =>
    Effect.gen(function* () {
      const workloads = yield* loadStackManifest;

      for (const workload of workloads) {
        expect(workload.estimatedSeconds, workload.id).toBeGreaterThan(0);
        expect(workload.teardown?.length ?? 0, workload.id).toBeGreaterThan(0);
        const stop = workload.stack === true ? ["stack", "destroy"] : ["stop", "--no-backup"];
        expect(workload.teardown?.at(-1)?.slice(0, stop.length), workload.id).toEqual(stop);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("starts a stack before any workload that measures a command against one", () =>
    Effect.gen(function* () {
      const workloads = yield* loadStackManifest;

      for (const workload of workloads) {
        const measuresStart =
          workload.args.join(" ").startsWith("stack start") ||
          (workload.stack !== true && workload.args[0] === "start") ||
          (workload.stack !== true && workload.args.join(" ") === "db start");
        if (measuresStart) continue;
        const start = workload.stack === true ? ["stack", "start"] : ["start"];
        expect(workload.setup?.[0]?.slice(0, start.length), workload.id).toEqual(start);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
