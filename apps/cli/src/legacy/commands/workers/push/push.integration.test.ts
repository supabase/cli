import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schedule } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
  type WorkersHttpRoutes,
} from "../../../../../tests/helpers/legacy-workers.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import {
  NoWorkersToDeployError,
  WorkerBuildFailedError,
  WorkersUnavailableError,
  WorkerSourceMissingError,
  WorkerUploadFailedError,
} from "../../../../shared/workers/workers.errors.ts";
import { legacyWorkersPush } from "./push.handler.ts";
import type { LegacyWorkersPushFlags } from "./push.command.ts";

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

function flags(overrides: Partial<LegacyWorkersPushFlags> = {}): LegacyWorkersPushFlags {
  return {
    names: ["api"],
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

function push(flagOverrides: Partial<LegacyWorkersPushFlags> = {}) {
  return legacyWorkersPush(flags(flagOverrides), { pollSchedule: IMMEDIATE });
}

describe("legacy workers push", () => {
  it.live("packages, uploads, deploys and waits for the build to settle", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

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

      expect(out.stdoutText).toContain("runtime");
      expect(out.stdoutText).toContain(`https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("omits the runtime for a Dockerfile worker and builds from the uploaded context", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "dockerfile"\n`,
      "supabase/workers/api/Dockerfile": "FROM node:24-alpine\nEXPOSE 8080\n",
    });
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
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
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
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
      yield* push({ names: ["box"] });

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
      expect(out.stdoutText).toContain("private (no HTTP endpoint)");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("guesses the runtime for a directory with no config entry and says so", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n`,
      "supabase/workers/api/package.json": "{}\n",
    });
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      expect(out.stderrText).toContain("guessed node");
      expect(out.stderrText).toContain("found package.json");

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec.runtime).toBe("node");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("sends the recorded size and the requested instance count", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "4gb"\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

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
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
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
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
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
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", buildState: "building" }) },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersPush(flags(), { pollSchedule: Schedule.recurs(2) }).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("WorkerBuildTimeoutError");
      expect((error as { suggestion: string }).suggestion).toContain("supabase workers status api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails before deploying when the presigned upload is rejected", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
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
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
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
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

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
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect((error as WorkerSourceMissingError).detail).toContain("is empty");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rides out a transient failure while polling the build", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
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

  it.live("acts on the workdir's project, not the process's directory", () => {
    // `--workdir`/`SUPABASE_WORKDIR` names the project every legacy command acts
    // on, so the worker discovered here comes from that tree even though the
    // process is somewhere else entirely.
    const repo = project();
    const elsewhere = makeWorkersProject();
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push({ names: [] });

      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          repo.cleanup();
          rmSync(elsewhere.dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("deploys every worker in the project when none are named", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\n\n[workers.web]\nruntime = "node"\n`,
      "supabase/workers/web/index.js": "export default {};\n",
    });
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        ...routes(),
        [`POST ${workersRoute("/web/uploads")}`]: { status: 201, body: uploadSlot },
        [`POST ${workersRoute("/web/deploy")}`]: {
          status: 202,
          body: { data: workerResource({ name: "web", runtime: "node", buildState: "building" }) },
        },
        [`GET ${workersRoute("/web")}`]: {
          status: 200,
          body: { data: workerResource({ name: "web", runtime: "node", buildState: "active" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* push({ names: [] });

      // Both deployed, in a stable (sorted) order.
      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
      expect(http.routeKeys).toContain(`POST ${workersRoute("/web/deploy")}`);
      expect(http.routeKeys.indexOf(`POST ${workersRoute("/api/deploy")}`)).toBeLessThan(
        http.routeKeys.indexOf(`POST ${workersRoute("/web/deploy")}`),
      );
      expect(out.stdoutText).toContain("web");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails when there are no workers to deploy at all", () => {
    const repo = project({ "supabase/config.toml": `project_id = "demo"\n` });
    rmSync(join(repo.dir, "supabase", "workers"), { recursive: true, force: true });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push({ names: [] }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NoWorkersToDeployError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("requires a linked project or an explicit --project-ref", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({ workdir: repo.dir, linked: false, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyProjectNotLinkedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("packages a --source worker from where its code actually lives", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsource = "packages/api"\n`,
      "packages/api/index.js": "export default {};\n",
    });
    rmSync(join(repo.dir, "supabase", "workers"), { recursive: true, force: true });
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      expect(out.stdoutText).toContain("runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a structured result in json mode", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: routes(),
    });

    return Effect.gen(function* () {
      yield* push();

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      // One entry per worker deployed, since a bare push can deploy several.
      expect(success?.data).toMatchObject({ project_ref: WORKERS_PROJECT_REF });
      expect(success?.data?.["workers"]).toEqual([
        {
          worker_name: "api",
          runtime: "node",
          size: "2gb-1vcpu",
          exposure: "public",
          instances: 1,
          build_state: "active",
          image_version: "v1",
          url: `https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`,
        },
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
