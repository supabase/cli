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
} from "../../../../../../tests/helpers/legacy-workers.ts";
import {
  WorkerDeleteConfirmationRequiredError,
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
  WorkersApiUnexpectedStatusError,
} from "../../../../../shared/workers/workers.errors.ts";
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
      // The redeploy hint is a success trailer, which lands on stderr.
      expect(out.stderrText).toContain("supabase experimental workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The refusal has to precede the DELETE. At emit time `--yes -o env` would
  // remove the worker and then exit non-zero with no payload, which a script
  // reads as "the delete failed" and may retry.
  // Deletion never touches local files, so a malformed local config has no
  // business standing between the user and a worker they named explicitly.
  it.live("deletes a remote worker despite an unparseable local config", () => {
    const repo = project("project_id = [unclosed\n");
    const otherRef = "qrstuvwxyzabcdefghij";
    const { layer, http } = setupLegacyWorkers({
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
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.some(otherRef) });

      expect(http.routeKeys).toContain(`DELETE /v2/projects/${otherRef}/workers/api`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The API grants `edge_functions:read` for the GET and `edge_functions:write`
  // for the DELETE separately, so a credential holding only write could not
  // delete a worker it is entitled to delete.
  it.live("deletes with --yes when the credential may not read the worker", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("still confirms interactively when the worker cannot be read", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      promptTextResponses: ["api"],
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("permanently deletes");
      // No count is quoted: the read that would have supplied one was refused.
      expect(out.stdoutText).not.toContain("will be terminated");
      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A refusal is not an absence: only a real 404 means there was nothing there.
  it.live("reports an unreadable worker as deleted, not as nothing to delete", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      yes: true,
      routes: {
        [getRoute]: { status: 403, body: { message: "insufficient scope" } },
        [deleteRoute]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("Deleted Worker");
      expect(out.stdoutText).not.toContain("nothing to delete");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

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

  // The suggested retry is copy-pasted verbatim and carries `--yes`, so dropping
  // an explicit ref points a no-prompt delete at whatever this checkout is
  // linked to — a same-named worker in a project the user never named.
  it.live("keeps an explicit --project-ref in the retry it suggests", () => {
    const repo = project();
    const otherRef = "qrstuvwxyzabcdefghij";
    const { layer } = setupLegacyWorkers({
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
      const error = yield* legacyWorkersDelete({
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
    const { layer } = setupLegacyWorkers({ workdir: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
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
    const { layer } = setupLegacyWorkers({
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
      const error = yield* legacyWorkersDelete({
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
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(out.stdoutText).not.toContain("permanently deletes");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `printf 'api\n' | supabase experimental workers delete api`: stdout is still a TTY, so
  // `output.interactive` stayed true and the prompt read the worker name off the
  // pipe — a confirmation the user never typed.
  it.live("refuses to read the confirmation off a piped stdin", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes,
      stdinIsTty: false,
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersDelete({
        name: "api",
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteConfirmationRequiredError);
      expect(http.routeKeys).not.toContain(deleteRoute);
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

  // `interactive` follows stdout, so a plain `>` redirect reaches this branch even
  // from a live terminal — the case where deleting without asking would be worst.
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
      // Not `workers push`: somebody deleting "api" does not want to deploy it.
      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain("supabase experimental workers list");
      expect(suggestion).not.toContain("workers push");
      expect(out.messages.filter((message) => message.type === "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `deleteWorker` already treats a DELETE 404 as done; the pre-flight GET used
  // to contradict that, so a teardown script run twice failed the second time
  // for a worker in exactly the state it asked for.
  it.live("succeeds under --yes when the worker is already gone", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
      yes: true,
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      // Nothing to delete, so nothing is asked of the API beyond the lookup.
      expect(http.routeKeys).toEqual([getRoute]);
      expect(out.stdoutText).toContain("nothing to delete");
      expect(out.stdoutText).not.toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the same payload shape for a no-op delete", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
      yes: true,
      goOutput: "json",
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

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

  it.live("pluralizes the live instance count in the confirmation", () => {
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
              instanceCounts: { declared: 3, live: 2, ready: 2, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("2 running instances will be terminated");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Scaled to zero: there is a tally, and it says nothing is running. Warning
  // about terminated instances there would invent a consequence.
  it.live("promises no terminations when nothing is running", () => {
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
              instances: 2,
              instanceCounts: { declared: 2, live: 0, ready: 0, stale: 0 },
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(out.stdoutText).toContain("permanently deletes");
      expect(out.stdoutText).not.toContain("will be terminated");
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

  // Deletion never reads the local source, so a `source` that does not resolve
  // inside the project must not block removing the remote worker.
  it.live("deletes the remote worker even when the configured source is unusable", () => {
    const repo = project('project_id = "demo"\n\n[workers.api]\nsource = "../../../elsewhere"\n');
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes, yes: true });

    return Effect.gen(function* () {
      yield* legacyWorkersDelete({ name: "api", projectRef: Option.none() });

      expect(http.routeKeys).toContain(deleteRoute);
      expect(out.stdoutText).toContain("Deleted Worker");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
