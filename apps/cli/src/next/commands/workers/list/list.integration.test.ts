import { rmSync } from "node:fs";
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
import { ProjectNotLinkedError } from "../../../config/project-link-state.service.ts";
import { WorkersUnavailableError } from "../../../../shared/workers/workers.errors.ts";
import { workersList } from "./list.handler.ts";

const CONFIG = `project_id = "demo"

[workers.api]
runtime = "node"
size = "2gb"

[workers.old]
runtime = "deno"
`;

function project(config = CONFIG) {
  const created = makeWorkersProject({ "supabase/config.toml": config });
  return {
    dir: created.dir,
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

const listRoute = `GET ${workersRoute()}`;

describe("workers list", () => {
  it.live("shows configured and deployed workers as one inventory", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: {
            data: [
              workerResource({ name: "api", runtime: "node", imageVersion: "v3" }),
              workerResource({
                name: "box",
                runtime: "sandbox",
                exposure: "private",
                instances: 2,
              }),
            ],
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.none() });

      const lines = messagesOfType(out, "info");
      const header = lines.find((line) => line.startsWith("NAME"));
      expect(header).toBeDefined();

      const rows = lines.filter((line) => /^(api|box|old)\s/.test(line));
      expect(rows).toHaveLength(3);
      // Sorted by name, so `api`, `box`, then the scaffolded-but-undeployed `old`.
      expect(rows[0]).toContain("2gb · 1 vCPU");
      expect(rows[0]).toContain(`https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`);
      expect(rows[1]).toContain("sandbox");
      expect(rows[2]).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not assert a runtime for a worker that has never been deployed", () => {
    const repo = project(`project_id = "demo"\n\n[workers.ghost]\n`);
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.none() });

      const row = messagesOfType(out, "info").find((line) => line.startsWith("ghost"));
      expect(row).toBeDefined();
      expect(row).not.toContain("dockerfile");
      expect(row).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("calls out a deployed worker that config.toml does not know about", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "stray", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.none() });

      expect(
        messagesOfType(out, "warn").some(
          (line) => line.includes("stray") && line.includes("guess the runtime"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so when the project has no workers at all", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.none() });

      expect(messagesOfType(out, "info")).toContain(
        "No workers yet. Scaffold one with `supabase workers new <name>`.",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the inventory as structured data in json mode", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      format: "json",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toMatchObject({ project_ref: WORKERS_PROJECT_REF });
      expect(success?.data?.["workers"]).toEqual([
        {
          name: "api",
          configured: true,
          deployed: true,
          runtime: "node",
          size: "2gb-1vcpu",
          state: "active",
          instances: 1,
          url: `https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`,
        },
        {
          name: "old",
          configured: true,
          deployed: false,
          runtime: "deno",
          size: undefined,
          state: "not deployed",
          instances: undefined,
          url: undefined,
        },
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha as unavailable", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: { [listRoute]: { status: 404, body: { message: "not available" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected status rather than showing an empty list", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: { [listRoute]: { status: 500, body: { message: "boom" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error._tag).toBe("WorkersApiUnexpectedStatusError");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("uses an explicit --project-ref without a linked project", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      linked: false,
      routes: {
        "GET /v2/projects/qrstuvwxyzabcdefghij/workers": { status: 200, body: { data: [] } },
      },
    });

    return Effect.gen(function* () {
      yield* workersList({ projectRef: Option.some("qrstuvwxyzabcdefghij") });

      expect(http.routeKeys).toEqual(["GET /v2/projects/qrstuvwxyzabcdefghij/workers"]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("requires a linked project when no ref is given", () => {
    const repo = project();
    const { layer } = setupWorkers({ cwd: repo.dir, linked: false });

    return Effect.gen(function* () {
      const error = yield* workersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotLinkedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
