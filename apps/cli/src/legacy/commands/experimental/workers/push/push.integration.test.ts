import { chmodSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Schedule } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
  type WorkersHttpRoutes,
} from "../../../../../../tests/helpers/legacy-workers.ts";
import { LegacyProjectNotLinkedError } from "../../../../config/legacy-project-ref.errors.ts";
import { LegacyWorkersEnvNotSupportedError } from "../workers.errors.ts";
import {
  NoWorkersToDeployError,
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerBuildFailedError,
  WorkerBuildTimeoutError,
  WorkerProjectNotFoundError,
  WorkersUnavailableError,
  WorkerSourceEscapingLinkError,
  WorkerSourceMissingError,
  WorkerUploadFailedError,
} from "../../../../../shared/workers/workers.errors.ts";
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
    instances: Option.none(),
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

/**
 * Whether the current user can still list `path` after it was chmod-ed shut.
 * Root ignores the permission bits, and CI sometimes runs as root, so the
 * permission test below asserts the opposite outcome instead of skipping.
 */
function listableAsCurrentUser(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The same question one level down: can this path still be stat-ed? */
function stattableAsCurrentUser(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function push(flagOverrides: Partial<LegacyWorkersPushFlags> = {}) {
  // Both schedules are injected: the outer poll and the per-read retry. The
  // production retry is spaced in seconds, so leaving it in place made the
  // transient-failure test wait on a real clock.
  return legacyWorkersPush(flags(flagOverrides), {
    pollSchedule: IMMEDIATE,
    pollRetrySchedule: IMMEDIATE,
  });
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

      expect(out.stdoutText).toContain("Deployed Worker api");
      expect(out.stdoutText).toContain("Runtime");
      expect(out.stdoutText).toContain(`https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`);
      expect(out.stdoutText).toContain("v1");
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

  // `[workers.*] runtime` and `size` are plain strings in the config schema, so
  // an unrecognized value reaches the handler rather than failing the parse.
  // Naming the accepted values beats echoing a schema error, and the refusal
  // has to land before anything is packaged or uploaded.
  it.live("names the runtimes on offer when config records one it does not know", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "cobol"\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(UnknownWorkerRuntimeError);
      expect((error as UnknownWorkerRuntimeError).detail).toContain("cobol");
      expect((error as UnknownWorkerRuntimeError).suggestion).toContain("dockerfile, node, deno");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("names the sizes on offer when config records one it does not know", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "huge"\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(UnknownWorkerSizeError);
      expect((error as UnknownWorkerSizeError).detail).toContain("huge");
      expect((error as UnknownWorkerSizeError).suggestion).toContain("2gb, 4gb");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("sends the recorded size and the requested instance count", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "4gb"\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push({ instances: Option.some(3) });

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec).toEqual({
        runtime: "node",
        size: "4gb-2vcpu",
        exposure: "public",
        instances: 3,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps a worker scaled at the count recorded in config", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\ninstances = 4\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec.instances).toBe(4);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("lets --instances override the recorded count for one deploy", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "2gb"\ninstances = 4\n`,
    });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push({ instances: Option.some(1) });

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec.instances).toBe(1);
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
      expect((error as WorkerBuildFailedError).suggestion).toContain(
        "supabase experimental workers push api",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The reason is optional in the API contract, so the detail has to read as a
  // sentence without one rather than trailing a bare colon.
  it.live("reports a failed build that came with no reason", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", buildState: "failed" }) },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerBuildFailedError);
      expect((error as WorkerBuildFailedError).detail).toBe(`The build for "api" failed.`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Every deploy this CLI sends asks for public exposure, but the accepted spec
  // is the platform's answer, not the request echoed back. A worker it did not
  // expose has no URL to print, and inventing one from the ref would name an
  // address that does not resolve.
  it.live("omits the URL for a worker the platform did not expose publicly", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              buildState: "active",
              exposure: "private",
            }),
          },
        },
      }),
    });

    return Effect.gen(function* () {
      yield* push();

      expect(out.stdoutText).toContain("Deployed Worker api");
      expect(out.stdoutText).toContain("private");
      expect(out.stdoutText).not.toContain("https://");
      expect(out.stdoutText).not.toContain("URL");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The schedules every other test injects are a seam: the command itself calls
  // the handler with no options at all. The stubbed worker settles on the first
  // poll, so the production schedules never get to space anything out.
  it.live("deploys when called the way the command wires it, with no test seams", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* legacyWorkersPush(flags());

      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
      expect(out.stdoutText).toContain("Deployed Worker api");
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
      const error = yield* legacyWorkersPush(flags(), {
        pollSchedule: Schedule.recurs(2),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerBuildTimeoutError);
      expect((error as { suggestion: string }).suggestion).toContain(
        "supabase experimental workers status api",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Every "run this next" string here is copy-pasted verbatim. From an unlinked
  // checkout — or one linked elsewhere — dropping the `--project-ref` the user
  // typed either fails to resolve or silently addresses a same-named worker in
  // whatever project this checkout points at.
  describe("carries an explicit --project-ref into its hints", () => {
    const unlinked = (repoDir: string, routeOverrides = {}) =>
      setupLegacyWorkers({
        workdir: repoDir,
        linked: false,
        routes: routes(routeOverrides),
      });
    const withRef = { projectRef: Option.some(WORKERS_PROJECT_REF) };

    it.live("in the failed-build retry suggestion", () => {
      const repo = project();
      const { layer } = unlinked(repo.dir, {
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", buildState: "failed" }) },
        },
      });

      return Effect.gen(function* () {
        const error = yield* push(withRef).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerBuildFailedError);
        expect((error as WorkerBuildFailedError).suggestion).toContain(
          `supabase experimental workers push api --project-ref ${WORKERS_PROJECT_REF}`,
        );
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    });

    it.live("in the give-up-waiting suggestion", () => {
      const repo = project();
      const { layer } = unlinked(repo.dir, {
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", buildState: "building" }) },
        },
      });

      return Effect.gen(function* () {
        const error = yield* legacyWorkersPush(flags(withRef), {
          pollSchedule: Schedule.recurs(2),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerBuildTimeoutError);
        expect((error as { suggestion: string }).suggestion).toContain(
          `supabase experimental workers status api --project-ref ${WORKERS_PROJECT_REF}`,
        );
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    });

    // The mirror image: when the link supplied the ref, repeating it back is
    // noise on a command that already resolves to the right project.
    it.live("but leaves it off when the link supplied the ref", () => {
      const repo = project();
      const { layer } = setupLegacyWorkers({
        workdir: repo.dir,
        routes: routes({
          [`GET ${workersRoute("/api")}`]: {
            status: 200,
            body: { data: workerResource({ name: "api", buildState: "failed" }) },
          },
        }),
      });

      return Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect((error as WorkerBuildFailedError).suggestion).toContain(
          "supabase experimental workers push api",
        );
        expect((error as WorkerBuildFailedError).suggestion).not.toContain("--project-ref");
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    });
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

  // `config.json` is a supported project format. `push` only reads the workers
  // section, so it has to honour one: loading TOML-only left the section empty,
  // which meant a guessed runtime and default size and instance count for a
  // worker that had configured all three.
  // The context is already uploaded by the time the deploy is refused, so the
  // failure has to be reported as the deploy's, not the upload's.
  it.live("reports a rejected deploy after the context has been uploaded", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`POST ${workersRoute("/api/deploy")}`]: { status: 500, body: { message: "boom" } },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(Predicate.isTagged(error, "WorkersApiUnexpectedStatusError")).toBe(true);
      expect(http.routeKeys).toContain("PUT /deploy-context/api.tar.gz");
      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deploys a worker configured in config.json, not just config.toml", () => {
    const created = makeWorkersProject({
      "supabase/config.json": JSON.stringify({
        project_id: "demo",
        workers: { api: { runtime: "node", size: "2gb", instances: 3 } },
      }),
      "supabase/workers/api/index.js": "export default { fetch: () => new Response('ok') };\n",
    });
    const repo = {
      dir: created.dir,
      cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
    };
    const { layer, http, out } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push();

      const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
      expect(JSON.parse(deploy?.body ?? "{}").data.attributes.spec).toEqual({
        runtime: "node",
        size: "2gb-1vcpu",
        exposure: "public",
        instances: 3,
      });
      // Every value came from config, so nothing was inferred from the files.
      expect(out.stderrText).not.toContain("guessed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The presigned URL's query string is a write-capable credential, so it must
  // not ride along in the error text — which rules out the library's own
  // `HttpClientError.message`, since that appends the method and URL that
  // failed. A transport failure is the case that would carry it.
  it.live("keeps the presigned signature out of an upload transport failure", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        "PUT /deploy-context/api.tar.gz": { transportError: "connection reset by peer" },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerUploadFailedError);
      const failure = error as WorkerUploadFailedError;
      expect(failure.detail).toContain("connection reset by peer");
      expect(failure.detail).not.toContain("signed");
      expect(failure.detail).not.toContain(UPLOAD_URL);
      expect(http.routeKeys).not.toContain(`POST ${workersRoute("/api/deploy")}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Both of the next two arrive as a 404 on the same route; only `error.code`
  // separates them, so they are asserted against the bodies the API really
  // sends rather than a shape of our own invention.
  it.live("reports a project outside the alpha as unavailable", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`POST ${workersRoute("/api/uploads")}`]: {
          status: 404,
          body: {
            error: {
              code: "generic_not_found",
              message: "Workers are not available for this project",
            },
          },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
      expect((error as WorkersUnavailableError).suggestion).toContain("private alpha");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("points at the project ref when no such project exists", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`POST ${workersRoute("/api/uploads")}`]: {
          status: 404,
          body: { error: { code: "not_found", message: "Not Found" } },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerProjectNotFoundError);
      expect((error as WorkerProjectNotFoundError).suggestion).not.toContain("private alpha");
      expect((error as WorkerProjectNotFoundError).suggestion).toContain("supabase link");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps the enrolment answer for a 404 body it does not recognize", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        [`POST ${workersRoute("/api/uploads")}`]: { status: 404, body: { unexpected: true } },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails when the worker has no source on disk", () => {
    const repo = project({});
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      // `api` is under `[workers.api]`, and `new` refuses a name the config
      // already carries — so the answer is the absent directory, not a scaffold.
      expect((error as WorkerSourceMissingError).suggestion).not.toContain("workers new");
      expect((error as WorkerSourceMissingError).suggestion).toContain(
        "supabase/workers/api and add your worker's code",
      );
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
      // `workers new` defines no `--force`, and refuses both a name already in
      // `config.toml` and a directory that is not empty — so recovery advice
      // that names it would answer with a second error instead of a fix.
      expect((error as WorkerSourceMissingError).suggestion).not.toContain("--force");
      expect((error as WorkerSourceMissingError).suggestion).not.toContain("workers new");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The one case `workers new` really does answer: a name that reached `push`
  // from argv alone, with no `[workers.<name>]` entry and nothing on disk.
  // Names are only validated as DNS labels before dispatch, so this is
  // reachable — a typo, or a worker nobody has scaffolded yet.
  it.live("offers to scaffold a worker the config has never heard of", () => {
    const repo = project({ "supabase/config.toml": 'project_id = "demo"\n' });
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect((error as WorkerSourceMissingError).suggestion).toContain(
        "supabase experimental workers new api",
      );
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A worker whose `source` points somewhere that is not there: the path in
  // config is as likely to be the mistake as the absent directory, so the
  // suggestion names both.
  it.live("points at the config entry when a configured source is missing", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsource = "./services/api"\n`,
    });
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      const failure = error as WorkerSourceMissingError;
      expect(failure.suggestion).not.toContain("workers new");
      expect(failure.suggestion).toContain("[workers.api]");
      expect(failure.suggestion).toContain("source");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A file sitting where the source directory should be is not a missing
  // worker: the path is occupied, and `workers new` refuses a destination that
  // exists and is not a directory, so pointing there would answer with a second
  // error.
  it.live("reports a file at the source path as not a directory", () => {
    const repo = project({});
    const source = join(repo.dir, "supabase", "workers", "api");
    rmSync(source, { recursive: true, force: true });
    writeFileSync(source, "not a directory");
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      const failure = error as WorkerSourceMissingError;
      expect(failure.detail).toContain("is not a directory");
      expect(failure.detail).not.toContain("There is no worker source");
      expect(failure.suggestion).not.toContain("workers new");
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // "Cannot read it" and "it is not there" want opposite things from the user,
  // and `Effect.option` on the stat collapsed them into the second — so an
  // unreadable source was reported as an unscaffolded worker, with a suggestion
  // to run `workers new` over a path that is already occupied. A symlink loop
  // is the cheapest stat failure that is not a missing path, and unlike a
  // chmod it behaves the same when the suite runs as root.
  it.live("reports an unstattable source rather than calling it missing", () => {
    const repo = project({});
    const source = join(repo.dir, "supabase", "workers", "api");
    rmSync(source, { recursive: true, force: true });
    symlinkSync("api", source);
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).not.toBeInstanceOf(WorkerSourceMissingError);
      expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Same rule one line down: `orElseSucceed([])` on the read reported a
  // directory the CLI cannot open as a directory with nothing in it.
  it.live("reports an unreadable source rather than calling it empty", () => {
    const repo = project({});
    const source = join(repo.dir, "supabase", "workers", "api");
    chmodSync(source, 0o000);
    // Probed before the run, not inside it: root ignores the permission bits, so
    // the deploy would succeed, and `Effect.flip` turns a success into a failure
    // — the branch below would never be reached to handle that case.
    const unreadable = !listableAsCurrentUser(source);
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      if (!unreadable) {
        yield* push();
        expect(http.requests.length).toBeGreaterThan(0);
        return;
      }

      const error = yield* push().pipe(Effect.flip);

      expect(error).not.toBeInstanceOf(WorkerSourceMissingError);
      expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
      expect(http.requests).toHaveLength(0);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          chmodSync(source, 0o700);
          repo.cleanup();
        }),
      ),
    );
  });

  // Packaging stores symlinks rather than following them, so a link out of the
  // tree would package a path the build cannot resolve. It is refused while
  // packaging — before a slot is minted — so nothing is uploaded for a context
  // that could never build.
  it.live("refuses a source that links outside itself, before minting a slot", () => {
    const repo = project();
    symlinkSync("../../config.toml", join(repo.dir, "supabase", "workers", "api", "escape.toml"));
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceEscapingLinkError);
      expect((error as WorkerSourceEscapingLinkError).detail).toContain("escape.toml");
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
      // Each worker is announced with its place in the run, and the run closes
      // by naming everything it deployed.
      expect(out.stderrText).toContain("Deploying Worker 1/2: api");
      expect(out.stderrText).toContain("Deploying Worker 2/2: web");
      expect(out.stdoutText).toContain(
        `Deployed 2 Workers to project ${WORKERS_PROJECT_REF}: api, web`,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The other half of that stat: an entry that is there but cannot be read is a
  // real filesystem problem, not a name to skip. Dropping it would deploy a
  // subset of the project and report success. Root ignores the permission bits,
  // and CI sometimes runs as root, so this asserts the outcome that actually
  // applies rather than skipping.
  it.live("fails rather than skipping a workers entry it cannot stat", () => {
    const repo = project();
    const workersRoot = join(repo.dir, "supabase", "workers");
    // Readable, so the listing still names `api`; not traversable, so stat-ing
    // anything inside it fails with a permission error.
    chmodSync(workersRoot, 0o600);
    const stattable = stattableAsCurrentUser(join(workersRoot, "api"));
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      if (stattable) {
        yield* push({ names: [] });
        expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
        return;
      }
      const error = yield* push({ names: [] }).pipe(Effect.flip);

      expect(error).not.toBeInstanceOf(NoWorkersToDeployError);
      expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
      expect(http.requests).toHaveLength(0);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          chmodSync(workersRoot, 0o700);
          repo.cleanup();
        }),
      ),
    );
  });

  // A dangling link in the workers root is listed by the directory read but has
  // nothing to stat. Discovery skips it rather than failing the whole run over a
  // path that names no worker.
  it.live("skips a dangling link in the workers root while discovering", () => {
    const repo = project();
    symlinkSync("nowhere", join(repo.dir, "supabase", "workers", "ghost"));
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push({ names: [] });

      expect(http.routeKeys).toContain(`POST ${workersRoute("/api/deploy")}`);
      expect(http.routeKeys.some((key) => key.includes("/ghost"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A bare `push` promises to deploy every worker in the project, and a worker
  // with no config entry is known only by its directory. Reading an unlistable
  // workers root as "no workers here" therefore answers a real filesystem
  // problem with "nothing to deploy" — the same absence-versus-unreadable
  // confusion as the source-directory guards, one level up.
  it.live("fails rather than reporting an unlistable workers root as empty", () => {
    const repo = project({ "supabase/config.toml": 'project_id = "demo"\n' });
    const workersRoot = join(repo.dir, "supabase", "workers");
    chmodSync(workersRoot, 0o000);
    const listable = listableAsCurrentUser(workersRoot);
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push({ names: [] }).pipe(Effect.flip);

      if (listable) {
        // Root ignores the permission bits, so the root lists and `api` is found.
        expect(error).not.toBeInstanceOf(NoWorkersToDeployError);
      } else {
        expect(error).not.toBeInstanceOf(NoWorkersToDeployError);
        expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
        expect(http.requests).toHaveLength(0);
      }
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          chmodSync(workersRoot, 0o700);
          repo.cleanup();
        }),
      ),
    );
  });

  it.live("names the workers a failed run never got to", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\n\n[workers.web]\nruntime = "node"\n`,
      "supabase/workers/web/index.js": "export default {};\n",
    });
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes({
        // `api` sorts first, so the run stops before `web` is ever touched.
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: {
            data: workerResource({
              name: "api",
              runtime: "node",
              buildState: "failed",
              stateReason: "error building image: exit status 1",
            }),
          },
        },
      }),
    });

    return Effect.gen(function* () {
      const error = yield* push({ names: [] }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerBuildFailedError);
      expect(out.stderrText).toContain("Not attempted: web");
      // Named rather than deployed: the run really did stop.
      expect(http.routeKeys).not.toContain(`POST ${workersRoute("/web/deploy")}`);
      // No summary either — nothing finished.
      expect(out.stdoutText).not.toContain("Deployed 2 Workers");
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

      expect(out.stdoutText).toContain("Deployed Worker api");
      expect(out.stdoutText).toContain("Runtime");
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

  // `--output-format json` asked for a stream of events, so progress does not
  // belong in it — unlike the "not attempted" report, which every format gets.
  it.live("keeps per-worker progress out of json mode", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\n\n[workers.web]\nruntime = "node"\n`,
      "supabase/workers/web/index.js": "export default {};\n",
    });
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
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

      expect(out.stderrText).not.toContain("Deploying Worker");
      expect(out.stdoutText).not.toContain("Deployed 2 Workers");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `-o env` cannot express the `workers` array. Discovering that at emit time
  // meant failing with the project already changed, inviting a retry that
  // deployed all over again.
  it.live("refuses -o env before making any request at all", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: routes(),
      goOutput: "env",
    });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The "nothing to deploy" guard counts directory entries, so without this a tree
  // of empty subdirectories packages to zero files and deploys an image with no
  // handler in it.
  it.live("refuses a source holding only empty directories, before minting a slot", () => {
    const repo = project({ "supabase/workers/api/nested/.keep": "" });
    rmSync(join(repo.dir, "supabase", "workers", "api", "index.js"));
    rmSync(join(repo.dir, "supabase", "workers", "api", "nested", ".keep"));
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect((error as WorkerSourceMissingError).suggestion).not.toContain("--force");
      expect((error as WorkerSourceMissingError).suggestion).not.toContain("workers new");
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The runtime guess is an inference about the contents of a directory, so it
  // has no business being reported for a directory that is not there.
  it.live("does not report a guessed runtime when the source is missing", () => {
    const repo = project({ "supabase/config.toml": 'project_id = "demo"\n' });
    rmSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true, force: true });
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      const error = yield* push().pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerSourceMissingError);
      expect(out.stderrText).not.toContain("guessed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `image_version` is optional in the response. Present-but-undefined made the
  // TOML encoder throw, after the upload and deploy had already completed.
  it.live("encodes -o toml when the deployed worker has no image version", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "toml",
      routes: routes({
        [`GET ${workersRoute("/api")}`]: {
          status: 200,
          body: { data: workerResource({ name: "api", runtime: "node", buildState: "active" }) },
        },
      }),
    });

    return Effect.gen(function* () {
      yield* push();

      expect(out.stdoutText).toContain("worker_name");
      expect(out.stdoutText).not.toContain("image_version");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A malformed config.toml must fail inside the finalizers, or the run skips the
  // telemetry flush every invocation is supposed to perform.
  it.live("flushes telemetry when the project config cannot be loaded", () => {
    const repo = project({ "supabase/config.toml": "project_id = [unclosed\n" });
    const { layer, telemetry } = setupLegacyWorkers({ workdir: repo.dir, routes: routes() });

    return Effect.gen(function* () {
      yield* push().pipe(Effect.flip);

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
