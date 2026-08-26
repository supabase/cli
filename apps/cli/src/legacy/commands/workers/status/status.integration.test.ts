import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
} from "../../../../../tests/helpers/legacy-workers.ts";
import {
  InvalidWorkerNameError,
  WorkerNotDeployedError,
} from "../../../../shared/workers/workers.errors.ts";
import { LegacyWorkersEnvNotSupportedError } from "../workers.errors.ts";
import { legacyWorkersStatus } from "./status.handler.ts";

const CONFIG = `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`;

function project(files: Readonly<Record<string, string>> = {}) {
  const created = makeWorkersProject({
    "supabase/config.toml": CONFIG,
    "supabase/workers/api/index.js": "export default {};\n",
    ...files,
  });
  return {
    dir: created.dir,
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

const getRoute = `GET ${workersRoute("/api")}`;

describe("legacy workers status", () => {
  it.live("reports the deployment facts and the live instance tally", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              imageVersion: "v3",
              instances: 3,
              instanceCounts: { declared: 3, live: 3, ready: 2, stale: 1 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      const stdout = out.stdoutText;
      expect(stdout).toContain("State");
      expect(stdout).toContain("active");
      expect(stdout).toContain("node");
      expect(stdout).toContain("2gb (1 vCPU)");
      expect(stdout).toContain("public");
      expect(stdout).toContain(WORKERS_PROJECT_REF);
      expect(stdout).toContain("v3");
      expect(stdout).toContain("2/3 ready, 3 live, 1 stale");
      expect(stdout).toContain(`https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`);
      expect(stdout).toContain(join("supabase", "workers", "api"));
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports the deployed runtime, not a stale config.toml entry", () => {
    // config.toml says node; the deployment carries no spec.runtime, which the
    // API only omits for a context-only (Dockerfile) build.
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      const runtimeLine = out.stdoutText
        .split("\n")
        .find((line) => line.trim().startsWith("Runtime"));
      expect(runtimeLine).toContain("dockerfile");
      expect(runtimeLine).not.toContain("node");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the declared count when no tally came back", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", instances: 2 }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("2 declared");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("warns rather than lying when the instance read-through failed", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              instancesError: "backend unreachable",
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      expect(out.stderrText).toContain("backend unreachable");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("points a failed build at the retry, with the reason", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              buildState: "failed",
              stateReason: "exit status 1",
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("failed");
      expect(out.stdoutText).toContain("exit status 1");
      expect(out.stdoutText).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("shows a worker being torn down as deleting", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", deleting: true }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("deleting");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with `not deployed` and points at push", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersStatus({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      expect((error as WorkerNotDeployedError).suggestion).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a name that could never have been written", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersStatus({
        name: "My_Worker",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports the worker's source directory even when it lives outside supabase/", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsource = "packages/api"\n`,
      "packages/api/index.js": "export default {};\n",
    });
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain(join("packages", "api"));
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the same facts as structured data in json mode", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: {
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              imageVersion: "v3",
              instanceCounts: { declared: 1, live: 1, ready: 1, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toMatchObject({
        worker_name: "api",
        project_ref: WORKERS_PROJECT_REF,
        runtime: "node",
        size: "2gb-1vcpu",
        exposure: "public",
        build_state: "active",
        image_version: "v3",
        declared_instances: 1,
        instances: { declared: 1, live: 1, ready: 1, stale: 0 },
      });
      // The detail lines are text-mode only.
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The JSON layer appends each success to stdout, so emitting the payload twice
  // made `JSON.parse(stdout)` fail outright and gave `stream-json` two terminal
  // result events.
  it.live("emits exactly one structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: {
        [getRoute]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() });

      const results = out.messages.filter(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(results).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A worker deployed from another checkout has no entry and no directory here,
  // so `supabase/workers/<name>` is pure inference — reporting it as the
  // worker's source named a path that was not there.
  it.live("omits the source for a worker with nothing local to point at", () => {
    const repo = project({ "supabase/config.toml": 'project_id = "demo"\n' });
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [`GET ${workersRoute("/stray")}`]: {
          status: 200,
          body: { data: workerResource({ name: "stray" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "stray", projectRef: Option.none() });

      expect(out.stdoutText).not.toContain("workers/stray");
      expect(out.stdoutText).not.toContain("Source");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `root` is only unusable *locally*, because `[workers] root` occupies the key.
  // The API accepts it as a DNS label, and `status` writes no config, so it has
  // no business refusing a worker `workers list` will happily show.
  it.live("inspects a deployed worker named root", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [`GET ${workersRoute("/root")}`]: {
          status: 200,
          body: { data: workerResource({ name: "root" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "root", projectRef: Option.none() });

      expect(out.stdoutText).toContain("active");
      expect(http.routeKeys).toEqual([`GET ${workersRoute("/root")}`]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before making any request at all", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "env",
      routes: { [getRoute]: { status: 200, body: { data: workerResource({ name: "api" }) } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersStatus({ name: "api", projectRef: Option.none() }).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("flushes telemetry when the worker name is invalid", () => {
    const repo = project();
    const { layer, telemetry } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersStatus({ name: "Not_A_Label", projectRef: Option.none() }).pipe(
        Effect.flip,
      );

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
