import { existsSync, readFileSync, rmSync } from "node:fs";
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
  WorkerDeleteNotConfirmedError,
  WorkerNotDeployedError,
} from "../../../../shared/workers/workers.errors.ts";
import { workersDelete } from "./delete.handler.ts";

const CONFIG = `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`;

function project() {
  const created = makeWorkersProject({
    "supabase/config.toml": CONFIG,
    "supabase/workers/api/index.js": "export default {};\n",
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
      cwd: repo.dir,
      routes,
      promptTextResponses: ["api"],
    });

    return Effect.gen(function* () {
      yield* workersDelete({
        name: Option.some("api"),
        yes: false,
        projectRef: Option.none(),
      });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(
        messagesOfType(out, "warn").some(
          (line) => line.includes("permanently deletes") && line.includes("3 running instances"),
        ),
      ).toBe(true);
      expect(messagesOfType(out, "success")).toContain("Deleted worker.");

      // Nothing local is touched — that is what makes `push` a one-command undo.
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.js"))).toBe(true);
      expect(readFileSync(join(repo.dir, "supabase", "config.toml"), "utf8")).toBe(CONFIG);
      expect(messagesOfType(out, "outro")).toContain(
        "Redeploy any time: supabase workers push api",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes nothing when the confirmation does not match", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      routes,
      promptTextResponses: ["nope"],
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: Option.some("api"),
        yes: false,
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDeleteNotConfirmedError);
      expect(http.routeKeys).toEqual([getRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips the confirmation with --yes", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({ cwd: repo.dir, routes });

    return Effect.gen(function* () {
      yield* workersDelete({ name: Option.some("api"), yes: true, projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
      expect(messagesOfType(out, "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips the confirmation when there is no interactive session to read from", () => {
    const repo = project();
    const { layer, http } = setupWorkers({ cwd: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      yield* workersDelete({ name: Option.some("api"), yes: false, projectRef: Option.none() });

      expect(http.routeKeys).toEqual([getRoute, deleteRoute]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with `not deployed` before asking anything", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: { [getRoute]: { status: 404, body: { message: "worker not found" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: Option.some("api"),
        yes: false,
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      expect(out.messages.filter((message) => message.type === "warn")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("treats a delete that races another one as done", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 404, body: { message: "already gone" } } },
    });

    return Effect.gen(function* () {
      yield* workersDelete({ name: Option.some("api"), yes: true, projectRef: Option.none() });

      expect(messagesOfType(out, "success")).toContain("Deleted worker.");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected delete status", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: { ...routes, [deleteRoute]: { status: 500, body: { message: "boom" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersDelete({
        name: Option.some("api"),
        yes: true,
        projectRef: Option.none(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("WorkersApiUnexpectedStatusError");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir, format: "json", routes });

    return Effect.gen(function* () {
      yield* workersDelete({ name: Option.some("api"), yes: true, projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toEqual({
        worker_name: "api",
        project_ref: WORKERS_PROJECT_REF,
        kept_source: join("supabase", "workers", "api"),
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
