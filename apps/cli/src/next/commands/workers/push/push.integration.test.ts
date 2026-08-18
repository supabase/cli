import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schedule } from "effect";
import {
  makeWorkersProject,
  messagesOfType,
  setupWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
  type WorkersHttpRoutes,
} from "../../../../../tests/helpers/workers.ts";
import { ProjectNotLinkedError } from "../../../config/project-link-state.service.ts";
import {
  MissingWorkerNameError,
  WorkerBuildFailedError,
  WorkersUnavailableError,
  WorkerSourceMissingError,
  WorkerUploadFailedError,
} from "../../../../shared/workers/workers.errors.ts";
import { workersPush } from "./push.handler.ts";
import type { WorkersPushFlags } from "./push.command.ts";

const UPLOAD_URL = "https://storage.example/deploy-context/api.tar.gz?signed";
const UPLOAD_ID = "cafe0000000000000000000000000000";

/** Polls run with no delay so a build sequence resolves at test speed. */
const IMMEDIATE = Schedule.recurs(20);

const uploadSlot = {
  data: {
    type: "project_worker_upload",
    id: UPLOAD_ID,
    attributes: { url: UPLOAD_URL, method: "PUT", expires_at: "2026-08-12T00:15:00Z" },
  },
};

function flags(overrides: Partial<WorkersPushFlags> = {}): WorkersPushFlags {
  return {
    name: Option.some("api"),
    instances: 1,
    projectRef: Option.none(),
    ...overrides,
  };
}

function project(files: Readonly<Record<string, string>> = {}) {
  const created = makeWorkersProject({
    "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
    "supabase/workers/api/index.js": "export default { fetch: () => new Response('ok') };\n",
    ...files,
  });
  return {
    dir: created.dir,
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

function routes(overrides: WorkersHttpRoutes = {}): WorkersHttpRoutes {
  return {
    [`POST ${workersRoute("/api/uploads")}`]: { status: 201, body: uploadSlot },
    "PUT /deploy-context/api.tar.gz": { status: 200 },
    [`POST ${workersRoute("/api/deploy")}`]: {
      status: 202,
      body: { data: workerResource({ name: "api", runtime: "node", buildState: "building" }) },
    },
    [`GET ${workersRoute("/api")}`]: {
      status: 200,
      body: {
        data: workerResource({
          name: "api",
          runtime: "node",
          buildState: "active",
          imageVersion: "v1",
        }),
      },
    },
    ...overrides,
  };
}

function push(flagOverrides: Partial<WorkersPushFlags> = {}) {
  return workersPush(flags(flagOverrides), { pollSchedule: IMMEDIATE });
}

describe("workers push", () => {
  it.live("packages, uploads, deploys and waits for the build to settle", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      expect(http.routeKeys).toEqual([
        `POST ${workersRoute("/api/uploads")}`,
        "PUT /deploy-context/api.tar.gz",
        `POST ${workersRoute("/api/deploy")}`,
        `GET ${workersRoute("/api")}`,
      ]);

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}")).toEqual({
        data: {
          type: "project_worker",
          attributes: {
            spec: {
              runtime: "node",
              size: "2gb-1vcpu",
              exposure: "public",
              instances: 1,
            },
            context_upload_id: UPLOAD_ID,
          },
        },
      });

      const upload = http.requests.find((request) => request.method === "PUT");
      expect(upload?.byteLength).toBeGreaterThan(0);

      expect(messagesOfType(out, "success")).toContain("Deployed worker.");
      expect(messagesOfType(out, "info")).toContain(
        `url       https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("omits the runtime for a Dockerfile worker and builds from the uploaded context", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "dockerfile"\n`,
      "supabase/workers/api/Dockerfile": "FROM node:24-alpine\nEXPOSE 8080\n",
    });
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", buildState: "active" }) },
        },
      }),
    });

    return Effect.gen(function* () {
      yield* push();

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      const attributes = JSON.parse(deploy?.body ?? "{}").data.attributes;
      expect(attributes.spec).toEqual({
        size: "2gb-1vcpu",
        exposure: "public",
        instances: 1,
      });
      expect(attributes.context_upload_id).toBe(UPLOAD_ID);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips packaging entirely for a bare sandbox and reports no URL", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.box]\nruntime = "sandbox"\n`,
    });
    const { layer, out, http } = setupWorkers({
      cwd: repo.dir,
      routes: {
        [`POST ${workersRoute("/box/deploy")}`]: {
          status: 202,
          body: {
            data: workerResource({
              name: "box",
              runtime: "sandbox",
              exposure: "private",
              buildState: "building",
            }),
          },
        },
        [`GET ${workersRoute("/box")}`]: {
          status: 200,
          body: {
            data: workerResource({
              name: "box",
              runtime: "sandbox",
              exposure: "private",
              buildState: "active",
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* push({ name: Option.some("box") });

      expect(http.routeKeys).toEqual([
        `POST ${workersRoute("/box/deploy")}`,
        `GET ${workersRoute("/box")}`,
      ]);

      const deploy = http.requests[0];
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes).toEqual({
        spec: {
          runtime: "sandbox",
          size: "2gb-1vcpu",
          exposure: "private",
          instances: 1,
        },
      });
      expect(messagesOfType(out, "info")).toContain("access    private (no HTTP endpoint)");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("guesses the runtime for a directory with no config entry and says so", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n`,
      "supabase/workers/api/package.json": "{}\n",
    });
    const { layer, out, http } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      expect(
        messagesOfType(out, "warn").some(
          (line) => line.includes("guessed node") && line.includes("found package.json"),
        ),
      ).toBe(true);

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec.runtime).toBe("node");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("sends the recorded size and the requested instance count", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "4gb"\n`,
    });
    const { layer, http } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push({ instances: 3 });

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec).toEqual({
        runtime: "node",
        size: "4gb-2vcpu",
        exposure: "public",
        instances: 3,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("polls until the build leaves `building`", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: [
          {
            status: 200,
            body: { data: workerResource({ name: "api", buildState: "building" }) },
          },
          {
            status: 200,
            body: { data: workerResource({ name: "api", buildState: "building" }) },
          },
          {
            status: 200,
            body: {
              data: workerResource({ name: "api", buildState: "active", imageVersion: "v2" }),
            },
          },
        ],
      }),
    });

    return Effect.gen(function* () {
      yield* push();

      const polls = http.routeKeys.filter((key) => key === `GET ${workersRoute("/api")}`);
      expect(polls).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails with the build's own reason when the build fails", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              buildState: "failed",
              stateReason: "error building image: exit status 1",
            }),
          },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerBuildFailedError);
      expect((error as WorkerBuildFailedError).detail).toContain("error building image");
      expect((error as WorkerBuildFailedError).suggestion).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("stops waiting on a build that never settles, and says where to look", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", buildState: "building" }) },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* workersPush(flags(), { pollSchedule: Schedule.recurs(2) }).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("WorkerBuildTimeoutError");
      expect((error as { suggestion: string }).suggestion).toContain("supabase workers status api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails before deploying when the presigned upload is rejected", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      routes: routes({ "PUT /deploy-context/api.tar.gz": { status: 403, body: "expired" } }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerUploadFailedError);
      expect(http.routeKeys).not.toContain(`POST ${workersRoute("/api/deploy")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha as unavailable", () => {
    const repo = project();
    const { layer } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`POST ${workersRoute("/api/uploads")}`]: {
          status: 404,
          body: { message: "Workers are not available for this project" },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
      expect((error as WorkersUnavailableError).suggestion).toContain("private alpha");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails when the worker has no source on disk", () => {
    const repo = project({});
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, http } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect((error as WorkerSourceMissingError).suggestion).toContain("supabase workers new api");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses an empty source directory instead of deploying nothing", () => {
    const repo = project({});
    rmSync(join(repo.dir, "supabase", "workers", "api", "index.js"), { force: true });
    const { layer, http } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect((error as WorkerSourceMissingError).detail).toContain("is empty");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rides out a transient failure while polling the build", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: [
          { status: 500, body: { message: "blip" } },
          {
            status: 200,
            body: { data: workerResource({ name: "api", buildState: "active" }) },
          },
        ],
      }),
    });

    return Effect.gen(function* () {
      yield* push();

      // The blip was retried rather than aborting a deploy already in flight.
      expect(
        http.routeKeys.filter((key) => key === `GET ${workersRoute("/api")}`).length,
      ).toBeGreaterThan(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("infers the worker from the current directory", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      cwd: join(repo.dir, "supabase", "workers", "api"),
      routes: routes(),
    });

    return Effect.gen(function* () {
      yield* push({ name: Option.none() });

      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("asks for a name when the current directory is not a worker", () => {
    const repo = project();
    const { layer } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push({ name: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(MissingWorkerNameError);
      expect((error as MissingWorkerNameError).suggestion).toContain(
        "supabase workers push <name>",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("requires a linked project or an explicit --project-ref", () => {
    const repo = project();
    const { layer } = setupWorkers({ cwd: repo.dir, linked: false, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotLinkedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("packages a --source worker from where its code actually lives", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsource = "packages/api"\n`,
      "packages/api/index.js": "export default {};\n",
    });
    rmSync(join(repo.dir, "supabase", "workers"), { recursive: true, force: true });
    const { layer, out } = setupWorkers({ cwd: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      expect(
        messagesOfType(out, "success").some((line) => line.includes(join("packages", "api"))),
      ).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir, format: "json", routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toMatchObject({
        worker_name: "api",
        project_ref: WORKERS_PROJECT_REF,
        runtime: "node",
        size: "2gb-1vcpu",
        exposure: "public",
        instances: 1,
        build_state: "active",
        image_version: "v1",
        url: `https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
