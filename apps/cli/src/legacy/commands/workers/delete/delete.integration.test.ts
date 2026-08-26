import { existsSync, readFileSync, rmSync } from "node:fs";
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
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
  WorkersApiUnexpectedStatusError,
} from "../../../../shared/workers/workers.errors.ts";
import { LegacyWorkersEnvNotSupportedError } from "../workers.errors.ts";
import { legacyWorkersDelete } from "./delete.handler.ts";

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

describe("legacy workers delete", () => {
  it.live("deletes after the name is typed back, and keeps the local files", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes,
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(out.stdoutText).toContain("permanently deletes");
      // Labelled "declared" because this response carries no live tally.
      // `spec.instances` is the target, not what is running.
      expect(out.stdoutText).toContain("3 declared instances");
      expect(out.stdoutText).toContain("Kept");

      // Nothing local is touched — that is what makes `push` a one-command undo.
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.js"))).toBe(true);
      expect(readFileSync(join(repo.dir, "supabase", "config.toml"), "utf8")).toBe(CONFIG);
      expect(out.stdoutText).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The refusal used to live at emit time, which on this command is *after* the
  // DELETE: `--yes -o env` removed the worker and then exited non-zero with no
  // payload, which a script reads as "the delete failed" and may retry.
  it.live("refuses -o env before deleting anything", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes,
      yes: true,
      goOutput: "env",
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes nothing when the confirmation does not match", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes,
      promptTextResponses: ["nope"],
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteNotConfirmedError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips the confirmation with --yes", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(out.stdoutText).not.toContain("permanently deletes");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses to delete unattended rather than skipping the confirmation", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `interactive` follows stdout, so a plain `>` redirect reaches this branch
  // even from a live terminal — the case that used to delete without asking.
  it.live("refuses when stdout is redirected and no --yes was given", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      interactive: false,
      routes,
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes unattended when SUPABASE_YES or --yes authorises it", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes,
      yes: true,
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with `not deployed` before asking anything", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      expect(out.messages.filter((message) => message.type === "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("treats a delete that races another one as done", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 404, body: { message: "already gone" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Kept");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected delete status", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 500, body: { message: "boom" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes,
      yes: true,
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

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

  // `-o json` leaves `output.format` as `text`, so the interactive check alone
  // still ran the warning and the prompt — onto the stdout the payload was
  // supposed to own.
  it.live("refuses rather than prompting when -o json asked for the stdout", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes,
      goOutput: "json",
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(out.stdoutText).not.toContain("permanently deletes");
      expect(http.routeKeys).not.toContain(deleteRoute);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The live tally is what is actually running; `spec.instances` is the target.
  // For a worker mid-provision the two differ, and a destructive confirmation is
  // the worst place to overstate.
  it.live("counts the live instances in the confirmation when the API reports them", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("1 running instance will be terminated");
      expect(out.stdoutText).not.toContain("3 running");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // An orphan — deployed from another checkout — has no local entry and no local
  // directory, so there is nothing that was "kept" and `push` has no source to
  // redeploy from.
  it.live("does not claim to have kept local files it never had", () => {
    const repo = project('project_id = "demo"\n');
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersDelete({ name: "stray", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
      expect(out.stdoutText).not.toContain("Kept");
      expect(out.stdoutText).not.toContain("workers push stray");
      expect(out.stderrText).toContain("nothing was kept");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes a deployed worker named root", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersDelete({ name: "root", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A `config.toml` entry on its own is not something `push` can deploy from, so
  // recommending it would send the user at a command that fails.
  it.live("keeps the config entry but does not advise redeploying without a source", () => {
    const repo = project();
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("supabase/config.toml entry");
      expect(out.stdoutText).not.toContain("workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Deletion never reads the local source, so a `source` that no longer resolves
  // inside the project must not block removing the remote worker.
  it.live("deletes the remote worker even when the configured source is unusable", () => {
    const repo = project('project_id = "demo"\n\n[workers.api]\nsource = "../../elsewhere"\n');
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toContain(deleteRoute);
      expect(out.stdoutText).toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
