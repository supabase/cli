import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { parseWorkloadManifest, validateWorkloads } from "./bench-report.ts";

const manifestPath = new URL("../bench/workloads.pr.json", import.meta.url).pathname;
const scenariosDir = new URL("../../cli-e2e/fixtures/scenarios/", import.meta.url).pathname;

const loadManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* parseWorkloadManifest(yield* fs.readFileString(manifestPath));
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
