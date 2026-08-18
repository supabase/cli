import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  messagesOfType,
  setupWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
} from "../../../../../tests/helpers/workers.ts";
import {
  MissingWorkerNameError,
  WorkerNotDeployedError,
} from "../../../../shared/workers/workers.errors.ts";
import { workersStatus } from "./status.handler.ts";

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

describe("workers status", () => {
  it.live("reports the deployment facts and the live instance tally", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
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
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      const lines = messagesOfType(out, "info");
      expect(lines).toContain("state     active");
      expect(lines).toContain("runtime   node");
      expect(lines).toContain("size      2gb · 1 vCPU");
      expect(lines).toContain("access    public");
      expect(lines).toContain(`project   ${WORKERS_PROJECT_REF}`);
      expect(lines).toContain("image     v3");
      expect(lines).toContain("instances 2/3 ready · 3 live · 1 stale");
      expect(lines).toContain(
        `url       https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`,
      );
      expect(lines).toContain(`source    ${join("supabase", "workers", "api")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports the deployed runtime, not a stale config.toml entry", () => {
    // config.toml says node; the deployment carries no spec.runtime, which the
    // API only omits for a context-only (Dockerfile) build.
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain("runtime   dockerfile");
      expect(messagesOfType(out, "info")).not.toContain("runtime   node");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the declared count when no tally came back", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", instances: 2 }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain("instances 2 declared");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("warns rather than lying when the instance read-through failed", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
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
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "warn").some((line) => line.includes("backend unreachable"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("points a failed build at the retry, with the reason", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
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
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain("state     failed");
      expect(messagesOfType(out, "info")).toContain("reason    exit status 1");
      expect(messagesOfType(out, "outro")).toContain("Try again: supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("shows a worker being torn down as deleting", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", deleting: true }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain("state     deleting");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with `not deployed` and points at push", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersStatus({
        name: Option.some("api"),
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      expect((error as WorkerNotDeployedError).suggestion).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("infers the worker from the current directory", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: join(repo.dir, "supabase", "workers", "api"),
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersStatus({ name: Option.none(), projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("asks for a name from a directory that is not a worker", () => {
    const repo = project();
    const { layer, http } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersStatus({
        name: Option.none(),
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(MissingWorkerNameError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports the worker's source directory even when it lives outside supabase/", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsource = "packages/api"\n`,
      "packages/api/index.js": "export default {};\n",
    });
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [getRoute]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain(`source    ${join("packages", "api")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the same facts as structured data in json mode", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
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
      yield* workersStatus({ name: Option.some("api"), projectRef: Option.none() });

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
      expect(messagesOfType(out, "info")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
