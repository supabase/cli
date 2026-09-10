import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  setupWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
} from "../../../../../tests/helpers/workers.ts";
import {
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
  WorkersApiUnexpectedStatusError,
} from "../../../../shared/workers/workers.errors.ts";
import { WorkersEnvNotSupportedError } from "../workers.errors.ts";
import { workersDelete } from "./delete.handler.ts";

const CONFIG = `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`;

/**
 * A project with `api` configured and on disk by default. Pass a bare config to
 * get the orphan case — a worker deployed from somebody else's checkout, with
 * nothing local behind it.
 */
function project(config = CONFIG) {
  const created = makeWorkersProject({
    "supabase/config.toml": config,
    ...(config === CONFIG ? { "supabase/workers/api/index.js": "export default {};\n" } : {}),
  });
  return {
    dir: created.dir,
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

const getRoute = `GET ${workersRoute("/api")}`;
const deleteRoute = `DELETE ${workersRoute("/api")}`;

const routes = {
  [getRoute]: {
    status: 200,
    body: { data: workerResource({ name: "api", runtime: "node", instances: 3 }) },
  },
  [deleteRoute]: { status: 204 },
};

describe("workers delete", () => {
  it.live("deletes after the name is typed back, and keeps the local files", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes,
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(out.stdoutText).toContain("permanently deletes");
      expect(out.stdoutText).toContain("3 declared instances");
      expect(out.stdoutText).toContain("Kept");

      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.js"))).toBe(true);
      expect(readFileSync(join(repo.dir, "supabase", "config.toml"), "utf8")).toBe(CONFIG);
      expect(out.stderrText).toContain("supabase experimental workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes a remote worker despite an unparseable local config", () => {
    const repo = project("project_id = [unclosed\n");
    const otherRef = "qrstuvwxyzabcdefghij";
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [`GET /v2/projects/${otherRef}/workers/api`]: {
          status: 200,
          body: { data: workerResource({ name: "api" }) },
        },
        [`DELETE /v2/projects/${otherRef}/workers/api`]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.some(otherRef) });

      expect(http.routeKeys).toContain(`DELETE /v2/projects/${otherRef}/workers/api`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes with --yes when the credential may not read the worker", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("still confirms interactively when the worker cannot be read", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["api"],
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("permanently deletes");
      expect(out.stdoutText).not.toContain("will be terminated");
      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports an unreadable worker as deleted, not as nothing to delete", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
      expect(out.stdoutText).not.toContain("nothing to delete");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before deleting anything", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes,
      yes: true,
      goOutput: "env",
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes nothing when the confirmation does not match", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes,
      promptTextResponses: ["nope"],
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteNotConfirmedError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps an explicit --project-ref in the retry it suggests", () => {
    const repo = project();
    const otherRef = "qrstuvwxyzabcdefghij";
    const { layer } = setupWorkers({
      workdir: repo.dir,
      format: "json",
      routes: {
        [`GET /v2/projects/${otherRef}/workers/api`]: {
          status: 200,
          body: { data: workerResource({ name: "api" }) },
        },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.some(otherRef),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      const suggestion =
        error instanceof WorkerDeleteConfirmationRequiredError ? error.suggestion : "";
      expect(suggestion).toContain(`--project-ref ${otherRef}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("leaves the retry bare when the ref came from the link", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      const suggestion =
        error instanceof WorkerDeleteConfirmationRequiredError ? error.suggestion : "";
      expect(suggestion).not.toContain("--project-ref");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps an explicit --project-ref in the confirmation-mismatch retry", () => {
    const repo = project();
    const otherRef = "qrstuvwxyzabcdefghij";
    const { layer } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["nope"],
      routes: {
        [`GET /v2/projects/${otherRef}/workers/api`]: {
          status: 200,
          body: { data: workerResource({ name: "api" }) },
        },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.some(otherRef),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteNotConfirmedError);
      const suggestion = error instanceof WorkerDeleteNotConfirmedError ? error.suggestion : "";
      expect(suggestion).toContain(`--project-ref ${otherRef}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips the confirmation with --yes", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(out.stdoutText).not.toContain("permanently deletes");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses to read the confirmation off a piped stdin", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes,
      stdinIsTty: false,
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).not.toContain(deleteRoute);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses to delete unattended rather than skipping the confirmation", () => {
    const repo = project();
    const { layer, http } = setupWorkers({ workdir: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses when stdout is redirected and no --yes was given", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      interactive: false,
      routes,
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes unattended when SUPABASE_YES or --yes authorises it", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      format: "json",
      routes,
      yes: true,
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with `not deployed` before asking anything", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain("supabase experimental workers list");
      expect(suggestion).not.toContain("workers push");
      expect(out.messages.filter((message) => message.type === "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("succeeds under --yes when the worker is already gone", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute]);
      expect(out.stdoutText).toContain("nothing to delete");
      expect(out.stdoutText).not.toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the same payload shape for a no-op delete", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
      yes: true,
      goOutput: "json",
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      const parsed: unknown = JSON.parse(out.stdoutText);
      expect(parsed).toMatchObject({
        worker_name: "api",
        project_ref: WORKERS_PROJECT_REF,
        kept_config_entry: true,
      });
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("treats a delete that races another one as done", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 404, body: { message: "already gone" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Kept");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected delete status", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 500, body: { message: "boom" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      format: "json",
      routes,
      yes: true,
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toEqual({
        worker_name: "api",
        project_ref: WORKERS_PROJECT_REF,
        kept_source: join("supabase", "workers", "api"),
        kept_config_entry: true,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses rather than prompting when -o json asked for the stdout", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes,
      goOutput: "json",
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(out.stdoutText).not.toContain("permanently deletes");
      expect(http.routeKeys).not.toContain(deleteRoute);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("counts the live instances in the confirmation when the API reports them", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["api"],
      routes: {
        ...routes,
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              instances: 3,
              instanceCounts: { declared: 3, live: 1, ready: 1, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("1 running instance will be terminated");
      expect(out.stdoutText).not.toContain("3 running");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("pluralizes the live instance count in the confirmation", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["api"],
      routes: {
        ...routes,
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              instances: 3,
              instanceCounts: { declared: 3, live: 2, ready: 2, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("2 running instances will be terminated");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("promises no terminations when nothing is running", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["api"],
      routes: {
        ...routes,
        [getRoute]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              instances: 2,
              instanceCounts: { declared: 2, live: 0, ready: 0, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("permanently deletes");
      expect(out.stdoutText).not.toContain("will be terminated");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not claim to have kept local files it never had", () => {
    const repo = project('project_id = "demo"\n');
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [`GET ${workersRoute("/stray")}`]: {
          status: 200,
          body: { data: workerResource({ name: "stray" }) },
        },
        [`DELETE ${workersRoute("/stray")}`]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "stray", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
      expect(out.stdoutText).not.toContain("Kept");
      expect(out.stdoutText).not.toContain("workers push stray");
      expect(out.stderrText).toContain("nothing was kept");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes a deployed worker named root", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [`GET ${workersRoute("/root")}`]: {
          status: 200,
          body: { data: workerResource({ name: "root" }) },
        },
        [`DELETE ${workersRoute("/root")}`]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "root", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps the config entry but does not advise redeploying without a source", () => {
    const repo = project();
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, out } = setupWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("supabase/config.toml entry");
      expect(out.stdoutText).not.toContain("workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes the remote worker even when the configured source is unusable", () => {
    const repo = project('project_id = "demo"\n\n[workers.api]\nsource = "../../elsewhere"\n');
    const { layer, out, http } = setupWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* workersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toContain(deleteRoute);
      expect(out.stdoutText).toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
