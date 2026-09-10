import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Schedule, FileSystem, Path, Schema } from "effect";
import {
  makeComputeProject,
  setupCompute,
  computeResource,
  computeRoute,
  COMPUTE_PROJECT_REF,
  type ComputeHttpRoutes,
} from "../../../../../tests/helpers/compute.ts";
import { ProjectRefNotLinkedError } from "../../../../config/project-ref.errors.ts";
import { ComputeEnvNotSupportedError } from "../compute.errors.ts";
import {
  NoComputeToDeployError,
  UnknownComputeExposureError,
  UnknownComputeRuntimeError,
  UnknownComputeSizeError,
  ComputeBuildFailedError,
  ComputeBuildTimeoutError,
  ComputeProjectNotFoundError,
  ComputeUnavailableError,
  ComputeSourceEscapingLinkError,
  ComputeSourceMissingError,
  ComputeUploadFailedError,
} from "../../../../shared/compute/compute.errors.ts";
import { computePush } from "./push.handler.ts";
import type { ComputePushFlags } from "./push.command.ts";

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

const deployRequest = Schema.Struct({
  data: Schema.Struct({
    type: Schema.String,
    attributes: Schema.Struct({
      spec: Schema.Struct({
        runtime: Schema.optionalKey(Schema.String),
        size: Schema.String,
        exposure: Schema.String,
        instances: Schema.Finite,
      }),
      context_upload_id: Schema.String,
    }),
  }),
});
const decodeDeploy = (body: string) =>
  Schema.decodeEffect(Schema.fromJsonString(deployRequest))(body, { onExcessProperty: "preserve" });

function flags(overrides: Partial<ComputePushFlags> = {}): ComputePushFlags {
  return {
    names: ["api"],
    instances: Option.none(),
    exposure: Option.none(),
    // Mirrors the command default: a push waits for the build, and only the
    // scenarios that are about the early return opt out of it.
    noWait: false,
    projectRef: Option.none(),
    ...overrides,
  };
}

function project(files: Readonly<Record<string, string>> = {}) {
  return makeComputeProject({
    "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\n`,
    "supabase/compute/api/index.js": "export default { fetch: () => new Response('ok') };\n",
    ...files,
  });
}

function routes(overrides: ComputeHttpRoutes = {}): ComputeHttpRoutes {
  return {
    [`POST ${computeRoute("/api/uploads")}`]: { status: 201, body: uploadSlot },
    "PUT /deploy-context/api.tar.gz": { status: 200 },
    [`POST ${computeRoute("/api/deploy")}`]: {
      status: 202,
      body: { data: computeResource({ name: "api", runtime: "node", buildState: "building" }) },
    },
    [`GET ${computeRoute("/api")}`]: {
      status: 200,
      body: {
        data: computeResource({
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
function push(flagOverrides: Partial<ComputePushFlags> = {}) {
  // Both schedules are injected: the outer poll and the per-read retry. The
  // production retry is spaced in seconds, so leaving it in place made the
  // transient-failure test wait on a real clock.
  return computePush(flags(flagOverrides), {
    pollSchedule: IMMEDIATE,
    pollRetrySchedule: IMMEDIATE,
  });
}

describe("compute push", () => {
  it.live("packages, uploads, deploys and waits for the build to settle", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        expect(http.routeKeys).toEqual([
          `POST ${computeRoute("/api/uploads")}`,
          "PUT /deploy-context/api.tar.gz",
          `POST ${computeRoute("/api/deploy")}`,
          `GET ${computeRoute("/api")}`,
        ]);

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect(yield* decodeDeploy(deploy?.body ?? "{}")).toEqual({
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

        expect(out.stdoutText).toContain("Deployed Compute api");
        expect(out.stdoutText).toContain("Runtime");
        expect(out.stdoutText).toContain(
          `https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`,
        );
        expect(out.stdoutText).toContain("v1");
        // The build settled, so there is nothing left to follow up on.
        expect(out.stderrText).not.toContain("supabase compute status api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("returns once the deploy is accepted when --no-wait is passed", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ noWait: true });

        expect(http.routeKeys).toEqual([
          `POST ${computeRoute("/api/uploads")}`,
          "PUT /deploy-context/api.tar.gz",
          `POST ${computeRoute("/api/deploy")}`,
        ]);

        expect(out.stdoutText).toContain("Deployed Compute api");
        // No image exists yet, so the row is dropped rather than rendered empty.
        expect(out.stdoutText).not.toContain("Image");
        expect(out.stderrText).toContain("supabase compute status api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `V2DeployAWorkerOutput` permits a terminal state on the deploy response
  // itself, and that verdict is this deploy's. A poll on top of it can only
  // contradict it — `awaitComputeBuild` reads a post-deploy 404 as "still
  // building", so an already-settled deploy would burn the poll budget and
  // surface as a timeout instead of the answer the platform already gave.
  describe("honours a terminal deploy response instead of polling", () => {
    const settledOnDeploy = (repoDir: string, state: "active" | "failed") =>
      setupCompute({
        workdir: repoDir,
        routes: routes({
          [`POST ${computeRoute("/api/deploy")}`]: {
            status: 202,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: state,
                ...(state === "active" ? { imageVersion: "v1" } : {}),
              }),
            },
          },
        }),
      });

    it.live("reports a deploy that came back already active", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out, http } = settledOnDeploy(repo.dir, "active");

        return yield* Effect.gen(function* () {
          yield* push();

          expect(http.routeKeys).not.toContain(`GET ${computeRoute("/api")}`);
          expect(out.stdoutText).toContain("Deployed Compute api");
          expect(out.stdoutText).toContain("v1");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("fails on a deploy that came back already failed", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, http } = settledOnDeploy(repo.dir, "failed");

        return yield* Effect.gen(function* () {
          const error = yield* push().pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeBuildFailedError);
          expect(http.routeKeys).not.toContain(`GET ${computeRoute("/api")}`);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  it.live("omits the runtime for a Dockerfile compute and builds from the uploaded context", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "dockerfile"\n`,
        "supabase/compute/api/Dockerfile": "FROM node:24-alpine\nEXPOSE 8080\n",
      });
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", buildState: "active" }) },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        const attributes = yield* decodeDeploy(deploy?.body ?? "{}").pipe(
          Effect.map((request) => request.data.attributes),
        );
        expect(attributes.spec).toEqual({
          size: "2gb-1vcpu",
          exposure: "public",
          instances: 1,
        });
        expect(attributes.context_upload_id).toBe(UPLOAD_ID);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("guesses the runtime for a directory with no config entry and says so", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n`,
        "supabase/compute/api/package.json": "{}\n",
      });
      const { layer, out, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        expect(out.stderrText).toContain("guessed node");
        expect(out.stderrText).toContain("found package.json");

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.runtime).toBe(
          "node",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `[compute.*] runtime` and `size` are plain strings in the config schema, so
  // an unrecognized value reaches the handler rather than failing the parse.
  // Naming the accepted values beats echoing a schema error, and the refusal
  // has to land before anything is packaged or uploaded.
  it.live("names the runtimes on offer when config records one it does not know", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "cobol"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(UnknownComputeRuntimeError);
        expect((error as UnknownComputeRuntimeError).detail).toContain("cobol");
        expect((error as UnknownComputeRuntimeError).suggestion).toContain(
          "dockerfile, node, deno",
        );
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("names the sizes on offer when config records one it does not know", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "huge"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(UnknownComputeSizeError);
        expect((error as UnknownComputeSizeError).detail).toContain("huge");
        expect((error as UnknownComputeSizeError).suggestion).toContain("2gb, 4gb");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("sends the recorded size and the requested instance count", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "4gb"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ instances: Option.some(3) });

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec).toEqual({
          runtime: "node",
          size: "4gb-2vcpu",
          exposure: "public",
          instances: 3,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("keeps a compute scaled at the count recorded in config", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\ninstances = 4\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.instances).toBe(4);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("lets --instances override the recorded count for one deploy", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\ninstances = 4\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ instances: Option.some(1) });

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.instances).toBe(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The whole point of recording it: every deploy sends a complete spec, so a
  // compute deliberately made private has to stay private across pushes rather
  // than being re-exposed by the next one.
  it.live("keeps a compute private when config records it that way", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "private"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.exposure).toBe(
          "private",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Hand-written config, so the casing is the user's own — `PRIVATE` plainly
  // means `private`, and the canonical form is what gets sent.
  it.live("reads a recorded exposure case-insensitively", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "PRIVATE"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.exposure).toBe(
          "private",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("lets --exposure override the recorded exposure for one deploy", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "private"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ exposure: Option.some("public") });

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.exposure).toBe(
          "public",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `[compute.*] exposure` is a plain string in the config schema, so a typo
  // reaches the handler. Coercing it to the default would deploy a `privat`
  // compute to the whole internet — refused before anything is packaged instead.
  it.live("names the exposures on offer when config records one it does not know", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "privat"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(UnknownComputeExposureError);
        expect((error as UnknownComputeExposureError).detail).toContain("privat");
        expect((error as UnknownComputeExposureError).suggestion).toContain("public, private");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The blank case, which reads as "not recorded" if the config reader collapses
  // it: absent means the `public` default, so a compute whose config plainly
  // tried to say something would go to the whole internet. Refused like any
  // other value the CLI does not recognize.
  it.live("refuses a blank recorded exposure instead of defaulting it to public", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = ""\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(UnknownComputeExposureError);
        // Named as blank rather than as an unknown `""`, which reads like a
        // parser quirk instead of an empty key.
        expect((error as UnknownComputeExposureError).detail).toContain("blank exposure");
        expect((error as UnknownComputeExposureError).suggestion).toContain("public, private");
        // Nothing was packaged, uploaded or deployed — least of all publicly.
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `--exposure` decides one deploy and nothing writes it down. Every deploy
  // sends a complete spec, so a compute taken off the internet by the flag goes
  // back on it at the next bare push — quietly, unless the run says so.
  describe("says when --exposure will not outlive the deploy", () => {
    const pushWith = (config: string, exposure: "public" | "private") => {
      return Effect.gen(function* () {
        const repo = yield* project({ "supabase/config.toml": config });
        const { layer, out } = setupCompute({ workdir: repo.dir, routes: routes() });
        return { layer, out, run: () => push({ exposure: Option.some(exposure) }) };
      });
    };

    it.live("nudges when the config records nothing", () =>
      Effect.gen(function* () {
        const { layer, out, run } = yield* pushWith(
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n`,
          "private",
        );

        return yield* Effect.gen(function* () {
          yield* run();

          expect(out.stderrText).toContain("records no exposure for api");
          // The exact line to set, the way the runtime guess names its own.
          expect(out.stderrText).toContain('[compute.api] exposure = "private"');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("nudges when the config records the opposite", () =>
      Effect.gen(function* () {
        const { layer, out, run } = yield* pushWith(
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "public"\n`,
          "private",
        );

        return yield* Effect.gen(function* () {
          yield* run();

          expect(out.stderrText).toContain('records exposure = "public"');
          expect(out.stderrText).toContain('exposure = "private"');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    // A recorded value the CLI cannot read is not `chosen` either: the next bare
    // push refuses rather than deploying, which is still not what this run did.
    it.live("nudges when the config records something it cannot read", () =>
      Effect.gen(function* () {
        const { layer, out, run } = yield* pushWith(
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "privat"\n`,
          "private",
        );

        return yield* Effect.gen(function* () {
          yield* run();

          expect(out.stderrText).toContain('records exposure = "privat"');
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    // Nothing drifts, so nothing to say — the flag restated what the config
    // already holds, case-insensitively.
    it.live("stays quiet when the config already agrees", () =>
      Effect.gen(function* () {
        const { layer, out, run } = yield* pushWith(
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "PRIVATE"\n`,
          "private",
        );

        return yield* Effect.gen(function* () {
          yield* run();

          expect(out.stderrText).not.toContain("applies to this deploy only");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    // The same non-drift, reached the other way: no recorded exposure and a flag
    // naming the default a bare push would have picked anyway.
    it.live("stays quiet when the flag restates the default", () =>
      Effect.gen(function* () {
        const { layer, out, run } = yield* pushWith(
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n`,
          "public",
        );

        return yield* Effect.gen(function* () {
          yield* run();

          expect(out.stderrText).not.toContain("applies to this deploy only");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  // The flag is the authority for the deploy it runs, so an unrecognized
  // recorded value it replaces is moot rather than fatal.
  it.live("lets --exposure stand in for an exposure config records badly", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nexposure = "privat"\n`,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ exposure: Option.some("private") });

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec.exposure).toBe(
          "private",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("polls until the build leaves `building`", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: [
            {
              status: 200,
              body: { data: computeResource({ name: "api", buildState: "building" }) },
            },
            {
              status: 200,
              body: { data: computeResource({ name: "api", buildState: "building" }) },
            },
            {
              status: 200,
              body: {
                data: computeResource({ name: "api", buildState: "active", imageVersion: "v2" }),
              },
            },
          ],
        }),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        const polls = http.routeKeys.filter((key) => key === `GET ${computeRoute("/api")}`);
        expect(polls).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails with the build's own reason when the build fails", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                buildState: "failed",
                stateReason: "error building image: exit status 1",
              }),
            },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeBuildFailedError);
        expect((error as ComputeBuildFailedError).detail).toContain("error building image");
        expect((error as ComputeBuildFailedError).suggestion).toContain(
          "supabase compute push api",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The reason is optional in the API contract, so the detail has to read as a
  // sentence without one rather than trailing a bare colon.
  it.live("reports a failed build that came with no reason", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", buildState: "failed" }) },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeBuildFailedError);
        expect((error as ComputeBuildFailedError).detail).toBe(`The build for "api" failed.`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The accepted spec is the platform's answer, not the request echoed back — so
  // a compute the platform did not expose has no URL to print even when the deploy
  // asked for `public`, and inventing one from the ref would name an address
  // that does not resolve.
  it.live("omits the URL for a compute the platform did not expose publicly", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: "active",
                exposure: "private",
              }),
            },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        expect(out.stdoutText).toContain("Deployed Compute api");
        expect(out.stdoutText).toContain("private");
        expect(out.stdoutText).not.toContain("https://");
        expect(out.stdoutText).not.toContain("URL");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The schedules every other test injects are a seam: the command itself calls
  // the handler with no options at all. The stubbed compute settles on the first
  // poll, so the production schedules never get to space anything out.
  it.live("deploys when called the way the command wires it, with no test seams", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* computePush(flags());

        expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
        expect(out.stdoutText).toContain("Deployed Compute api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("stops waiting on a build that never settles, and says where to look", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", buildState: "building" }) },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* computePush(flags(), {
          pollSchedule: Schedule.recurs(2),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeBuildTimeoutError);
        expect((error as { suggestion: string }).suggestion).toContain(
          "supabase compute status api",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Every "run this next" string here is copy-pasted verbatim. From an unlinked
  // checkout — or one linked elsewhere — dropping the `--project-ref` the user
  // typed either fails to resolve or silently addresses a same-named compute in
  // whatever project this checkout points at.
  describe("carries an explicit --project-ref into its hints", () => {
    const unlinked = (repoDir: string, routeOverrides = {}) =>
      setupCompute({
        workdir: repoDir,
        linked: false,
        routes: routes(routeOverrides),
      });
    const withRef = { projectRef: Option.some(COMPUTE_PROJECT_REF) };

    it.live("in the still-building trailer under --no-wait", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out } = unlinked(repo.dir);

        return yield* Effect.gen(function* () {
          yield* push({ ...withRef, noWait: true });

          expect(out.stderrText).toContain(
            `supabase compute status api --project-ref ${COMPUTE_PROJECT_REF}`,
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("in the failed-build retry suggestion", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer } = unlinked(repo.dir, {
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", buildState: "failed" }) },
          },
        });

        return yield* Effect.gen(function* () {
          const error = yield* push(withRef).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeBuildFailedError);
          expect((error as ComputeBuildFailedError).suggestion).toContain(
            `supabase compute push api --project-ref ${COMPUTE_PROJECT_REF}`,
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("in the give-up-waiting suggestion", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer } = unlinked(repo.dir, {
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", buildState: "building" }) },
          },
        });

        return yield* Effect.gen(function* () {
          const error = yield* computePush(flags(withRef), {
            pollSchedule: Schedule.recurs(2),
          }).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeBuildTimeoutError);
          expect((error as { suggestion: string }).suggestion).toContain(
            `supabase compute status api --project-ref ${COMPUTE_PROJECT_REF}`,
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    // The mirror image: when the link supplied the ref, repeating it back is
    // noise on a command that already resolves to the right project.
    it.live("but leaves it off when the link supplied the ref", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out } = setupCompute({ workdir: repo.dir, routes: routes() });

        return yield* Effect.gen(function* () {
          yield* push({ noWait: true });

          expect(out.stderrText).toContain("supabase compute status api");
          expect(out.stderrText).not.toContain("--project-ref");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  it.live("fails before deploying when the presigned upload is rejected", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({ "PUT /deploy-context/api.tar.gz": { status: 403, body: "expired" } }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeUploadFailedError);
        expect(http.routeKeys).not.toContain(`POST ${computeRoute("/api/deploy")}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `config.json` is a supported project format. `push` only reads the compute
  // section, so it has to honour one: loading TOML-only left the section empty,
  // which meant a guessed runtime and default size and instance count for a
  // compute that had configured all three.
  // The context is already uploaded by the time the deploy is refused, so the
  // failure has to be reported as the deploy's, not the upload's.
  it.live("reports a rejected deploy after the context has been uploaded", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`POST ${computeRoute("/api/deploy")}`]: { status: 500, body: { message: "boom" } },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(Predicate.isTagged(error, "ComputeApiUnexpectedStatusError")).toBe(true);
        expect(http.routeKeys).toContain("PUT /deploy-context/api.tar.gz");
        expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("deploys a compute configured in config.json, not just config.toml", () =>
    Effect.gen(function* () {
      const created = yield* makeComputeProject({
        "supabase/config.json": yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          project_id: "demo",
          compute: { api: { runtime: "node", size: "2gb", instances: 3 } },
        }),
        "supabase/compute/api/index.js": "export default { fetch: () => new Response('ok') };\n",
      });
      const { layer, http, out } = setupCompute({ workdir: created.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        const deploy = http.requests.find((request) => request.url.endsWith("/deploy"));
        expect((yield* decodeDeploy(deploy?.body ?? "{}")).data.attributes.spec).toEqual({
          runtime: "node",
          size: "2gb-1vcpu",
          exposure: "public",
          instances: 3,
        });
        // Every value came from config, so nothing was inferred from the files.
        expect(out.stderrText).not.toContain("guessed");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The presigned URL's query string is a write-capable credential, so it must
  // not ride along in the error text — which rules out the library's own
  // `HttpClientError.message`, since that appends the method and URL that
  // failed. A transport failure is the case that would carry it.
  it.live("keeps the presigned signature out of an upload transport failure", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          "PUT /deploy-context/api.tar.gz": { transportError: "connection reset by peer" },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeUploadFailedError);
        const failure = error as ComputeUploadFailedError;
        expect(failure.detail).toContain("connection reset by peer");
        expect(failure.detail).not.toContain("signed");
        expect(failure.detail).not.toContain(UPLOAD_URL);
        expect(http.routeKeys).not.toContain(`POST ${computeRoute("/api/deploy")}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Both of the next two arrive as a 404 on the same route; only `error.code`
  // separates them, so they are asserted against the bodies the API really
  // sends rather than a shape of our own invention.
  it.live("reports a project outside the alpha as unavailable", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`POST ${computeRoute("/api/uploads")}`]: {
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

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeUnavailableError);
        expect((error as ComputeUnavailableError).suggestion).toContain("private alpha");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("points at the project ref when no such project exists", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`POST ${computeRoute("/api/uploads")}`]: {
            status: 404,
            body: { error: { code: "not_found", message: "Not Found" } },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeProjectNotFoundError);
        expect((error as ComputeProjectNotFoundError).suggestion).not.toContain("private alpha");
        expect((error as ComputeProjectNotFoundError).suggestion).toContain("supabase link");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("keeps the enrolment answer for a 404 body it does not recognize", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`POST ${computeRoute("/api/uploads")}`]: { status: 404, body: { unexpected: true } },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeUnavailableError);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails when the compute has no source on disk", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({});
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api"), {
        recursive: true,
        force: true,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        // `api` is under `[compute.api]`, and `new` refuses a name the config
        // already carries — so the answer is the absent directory, not a scaffold.
        expect((error as ComputeSourceMissingError).suggestion).not.toContain("compute new");
        expect((error as ComputeSourceMissingError).suggestion).toContain(
          "supabase/compute/api and add your compute's code",
        );
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses an empty source directory instead of deploying nothing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({});
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api", "index.js"), {
        force: true,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        expect((error as ComputeSourceMissingError).detail).toContain("is empty");
        // `compute new` defines no `--force`, and refuses both a name already in
        // `config.toml` and a directory that is not empty — so recovery advice
        // that names it would answer with a second error instead of a fix.
        expect((error as ComputeSourceMissingError).suggestion).not.toContain("--force");
        expect((error as ComputeSourceMissingError).suggestion).not.toContain("compute new");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The one case `compute new` really does answer: a name that reached `push`
  // from argv alone, with no `[compute.<name>]` entry and nothing on disk.
  // Names are only validated as DNS labels before dispatch, so this is
  // reachable — a typo, or a compute nobody has scaffolded yet.
  it.live("offers to scaffold a compute the config has never heard of", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/config.toml": 'project_id = "demo"\n' });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api"), {
        recursive: true,
        force: true,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        expect((error as ComputeSourceMissingError).suggestion).toContain(
          "supabase compute new api",
        );
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A compute whose `source` points somewhere that is not there: the path in
  // config is as likely to be the mistake as the absent directory, so the
  // suggestion names both.
  it.live("points at the config entry when a configured source is missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsource = "./services/api"\n`,
      });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api"), {
        recursive: true,
        force: true,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        const failure = error as ComputeSourceMissingError;
        expect(failure.suggestion).not.toContain("compute new");
        expect(failure.suggestion).toContain("[compute.api]");
        expect(failure.suggestion).toContain("source");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A file sitting where the source directory should be is not a missing
  // compute: the path is occupied, and `compute new` refuses a destination that
  // exists and is not a directory, so pointing there would answer with a second
  // error.
  it.live("reports a file at the source path as not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({});
      const source = path.join(repo.dir, "supabase", "compute", "api");
      yield* fs.remove(source, { recursive: true, force: true });
      yield* fs.writeFileString(source, "not a directory");
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        const failure = error as ComputeSourceMissingError;
        expect(failure.detail).toContain("is not a directory");
        expect(failure.detail).not.toContain("There is no compute source");
        expect(failure.suggestion).not.toContain("compute new");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // "Cannot read it" and "it is not there" want opposite things from the user,
  // and `Effect.option` on the stat collapsed them into the second — so an
  // unreadable source was reported as an unscaffolded compute, with a suggestion
  // to run `compute new` over a path that is already occupied. A symlink loop
  // is the cheapest stat failure that is not a missing path, and unlike a
  // chmod it behaves the same when the suite runs as root.
  it.live("reports an unstattable source rather than calling it missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({});
      const source = path.join(repo.dir, "supabase", "compute", "api");
      yield* fs.remove(source, { recursive: true, force: true });
      yield* fs.symlink("api", source);
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).not.toBeInstanceOf(ComputeSourceMissingError);
        expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Same rule one line down: `orElseSucceed([])` on the read reported a
  // directory the CLI cannot open as a directory with nothing in it.
  it.live("reports an unreadable source rather than calling it empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({});
      const source = path.join(repo.dir, "supabase", "compute", "api");
      yield* Effect.acquireRelease(fs.chmod(source, 0o000), () =>
        fs.chmod(source, 0o700).pipe(Effect.orDie),
      );
      // Probed before the run, not inside it: root ignores the permission bits, so
      // the deploy would succeed, and `Effect.flip` turns a success into a failure
      // — the branch below would never be reached to handle that case.
      const unreadable = !(yield* fs.readDirectory(source).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        if (!unreadable) {
          yield* push();
          expect(http.requests.length).toBeGreaterThan(0);
          return;
        }

        const error = yield* push().pipe(Effect.flip);

        expect(error).not.toBeInstanceOf(ComputeSourceMissingError);
        expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Packaging stores symlinks rather than following them, so a link out of the
  // tree would package a path the build cannot resolve. It is refused while
  // packaging — before a slot is minted — so nothing is uploaded for a context
  // that could never build.
  it.live("refuses a source that links outside itself, before minting a slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      yield* fs.symlink(
        "../../config.toml",
        path.join(repo.dir, "supabase", "compute", "api", "escape.toml"),
      );
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceEscapingLinkError);
        expect((error as ComputeSourceEscapingLinkError).detail).toContain("escape.toml");
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("rides out a transient failure while polling the build", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          [`GET ${computeRoute("/api")}`]: [
            { status: 500, body: { message: "blip" } },
            {
              status: 200,
              body: { data: computeResource({ name: "api", buildState: "active" }) },
            },
          ],
        }),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        // The blip was retried rather than aborting a deploy already in flight.
        expect(
          http.routeKeys.filter((key) => key === `GET ${computeRoute("/api")}`).length,
        ).toBeGreaterThan(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("acts on the workdir's project, not the process's directory", () =>
    Effect.gen(function* () {
      // `--workdir`/`SUPABASE_WORKDIR` names the project every command acts
      // on, so the compute discovered here comes from that tree even though the
      // process is somewhere else entirely.
      const repo = yield* project();
      const elsewhere = yield* makeComputeProject();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        cwd: elsewhere.dir,
        routes: routes(),
      });

      return yield* Effect.gen(function* () {
        yield* push({ names: [] });

        expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("deploys every compute in the project when none are named", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n\n[compute.web]\nruntime = "node"\n`,
        "supabase/compute/web/index.js": "export default {};\n",
      });
      const { layer, out, http } = setupCompute({
        workdir: repo.dir,
        routes: {
          ...routes(),
          [`POST ${computeRoute("/web/uploads")}`]: { status: 201, body: uploadSlot },
          [`POST ${computeRoute("/web/deploy")}`]: {
            status: 202,
            body: {
              data: computeResource({ name: "web", runtime: "node", buildState: "building" }),
            },
          },
          [`GET ${computeRoute("/web")}`]: {
            status: 200,
            body: { data: computeResource({ name: "web", runtime: "node", buildState: "active" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* push({ names: [] });

        // Both deployed, in a stable (sorted) order.
        expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
        expect(http.routeKeys).toContain(`POST ${computeRoute("/web/deploy")}`);
        expect(http.routeKeys.indexOf(`POST ${computeRoute("/api/deploy")}`)).toBeLessThan(
          http.routeKeys.indexOf(`POST ${computeRoute("/web/deploy")}`),
        );
        expect(out.stdoutText).toContain("web");
        // Each compute is announced with its place in the run, and the run closes
        // by naming everything it deployed.
        expect(out.stderrText).toContain("Deploying Compute 1/2: api");
        expect(out.stderrText).toContain("Deploying Compute 2/2: web");
        expect(out.stdoutText).toContain(
          `Deployed 2 Compute to project ${COMPUTE_PROJECT_REF}: api, web`,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The other half of that stat: an entry that is there but cannot be read is a
  // real filesystem problem, not a name to skip. Dropping it would deploy a
  // subset of the project and report success. Root ignores the permission bits,
  // and CI sometimes runs as root, so this asserts the outcome that actually
  // applies rather than skipping.
  it.live("fails rather than skipping a compute entry it cannot stat", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const computeRoot = path.join(repo.dir, "supabase", "compute");
      // Readable, so the listing still names `api`; not traversable, so stat-ing
      // anything inside it fails with a permission error.
      yield* Effect.acquireRelease(fs.chmod(computeRoot, 0o600), () =>
        fs.chmod(computeRoot, 0o700).pipe(Effect.orDie),
      );
      const stattable = yield* fs.stat(path.join(computeRoot, "api")).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        if (stattable) {
          yield* push({ names: [] });
          expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
          return;
        }
        const error = yield* push({ names: [] }).pipe(Effect.flip);

        expect(error).not.toBeInstanceOf(NoComputeToDeployError);
        expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A dangling link in the compute root is listed by the directory read but has
  // nothing to stat. Discovery skips it rather than failing the whole run over a
  // path that names no compute.
  it.live("skips a dangling link in the compute root while discovering", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      yield* fs.symlink("nowhere", path.join(repo.dir, "supabase", "compute", "ghost"));
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push({ names: [] });

        expect(http.routeKeys).toContain(`POST ${computeRoute("/api/deploy")}`);
        expect(http.routeKeys.some((key) => key.includes("/ghost"))).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A bare `push` promises to deploy every compute in the project, and a compute
  // with no config entry is known only by its directory. Reading an unlistable
  // compute root as "no compute here" therefore answers a real filesystem
  // problem with "nothing to deploy" — the same absence-versus-unreadable
  // confusion as the source-directory guards, one level up.
  it.live("fails rather than reporting an unlistable compute root as empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/config.toml": 'project_id = "demo"\n' });
      const computeRoot = path.join(repo.dir, "supabase", "compute");
      yield* Effect.acquireRelease(fs.chmod(computeRoot, 0o000), () =>
        fs.chmod(computeRoot, 0o700).pipe(Effect.orDie),
      );
      const listable = yield* fs.readDirectory(computeRoot).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push({ names: [] }).pipe(Effect.flip);

        if (listable) {
          // Root ignores the permission bits, so the root lists and `api` is found.
          expect(error).not.toBeInstanceOf(NoComputeToDeployError);
        } else {
          expect(error).not.toBeInstanceOf(NoComputeToDeployError);
          expect(Predicate.isTagged(error, "PlatformError")).toBe(true);
          expect(http.requests).toHaveLength(0);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("names the compute a failed run never got to", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n\n[compute.web]\nruntime = "node"\n`,
        "supabase/compute/web/index.js": "export default {};\n",
      });
      const { layer, out, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          // `api` sorts first, so the run stops before `web` is ever touched.
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: "failed",
                stateReason: "error building image: exit status 1",
              }),
            },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        const error = yield* push({ names: [] }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeBuildFailedError);
        expect(out.stderrText).toContain("Not attempted: web");
        // Named rather than deployed: the run really did stop.
        expect(http.routeKeys).not.toContain(`POST ${computeRoute("/web/deploy")}`);
        // No summary either — nothing finished.
        expect(out.stdoutText).not.toContain("Deployed 2 Compute");
        // Nothing was left running: a waiting run has no build in flight to name.
        expect(out.stderrText).not.toContain("Still building");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `runCli` drains success trailers only on exit code 0, so a later failure
  // discards the follow-up hint for a build that is still running — and the
  // failure does nothing to stop that build. The failure path has to say so.
  it.live("names the builds a failed --no-wait run left running", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml":
          `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n` +
          `\n[compute.web]\nruntime = "node"\n\n[compute.zap]\nruntime = "node"\n`,
        "supabase/compute/web/index.js": "export default {};\n",
        "supabase/compute/zap/index.js": "export default {};\n",
      });
      const { layer, out, http } = setupCompute({
        workdir: repo.dir,
        routes: routes({
          // The upload slot points at one URL for every compute, so `web` reuses
          // the `PUT` the default routes already stub.
          [`POST ${computeRoute("/web/uploads")}`]: { status: 201, body: uploadSlot },
          [`POST ${computeRoute("/web/deploy")}`]: {
            status: 202,
            body: { data: computeResource({ name: "web", runtime: "node", buildState: "failed" }) },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        // Alphabetical: `api` is accepted, `web` fails, `zap` is never reached.
        const error = yield* push({ names: [], noWait: true }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeBuildFailedError);
        expect(out.stderrText).toContain("Still building: api");
        expect(out.stderrText).toContain("Not attempted: zap");
        // In flight before never started: one is a thing to follow, the other a
        // thing to re-run.
        expect(out.stderrText.indexOf("Still building")).toBeLessThan(
          out.stderrText.indexOf("Not attempted"),
        );
        expect(http.routeKeys).not.toContain(`POST ${computeRoute("/zap/deploy")}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails when there are no compute to deploy at all", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/config.toml": `project_id = "demo"\n` });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute"), {
        recursive: true,
        force: true,
      });
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push({ names: [] }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(NoComputeToDeployError);
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("requires a linked project or an explicit --project-ref", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir, linked: false, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("packages a --source compute from where its code actually lives", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsource = "packages/api"\n`,
        "packages/api/index.js": "export default {};\n",
      });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute"), {
        recursive: true,
        force: true,
      });
      const { layer, out } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push();

        expect(out.stdoutText).toContain("Deployed Compute api");
        expect(out.stdoutText).toContain("Runtime");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("emits a structured result in json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        format: "json",
        routes: routes(),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        const success = out.messages.findLast(
          (message) => message.type === "success" && message.data !== undefined,
        );
        // One entry per compute deployed, since a bare push can deploy several.
        expect(success?.data).toMatchObject({ project_ref: COMPUTE_PROJECT_REF });
        expect(success?.data?.["compute"]).toEqual([
          {
            compute_name: "api",
            runtime: "node",
            size: "2gb-1vcpu",
            exposure: "public",
            instances: 1,
            build_state: "active",
            image_version: "v1",
            url: `https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `image_version` is optional-but-permitted on the deploy response, so a
  // re-push of a compute that is already serving can echo the image it is
  // serving now — the previous build's. Reporting that beside `State building`
  // names an image this deploy did not produce.
  describe("does not report the previous image while a re-push is still building", () => {
    const rePush = (repoDir: string, format?: "json") =>
      setupCompute({
        workdir: repoDir,
        ...(format === undefined ? {} : { format }),
        routes: routes({
          [`POST ${computeRoute("/api/deploy")}`]: {
            status: 202,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: "building",
                // The compute was already live, so the platform echoes the image
                // it is still serving.
                imageVersion: "v7",
              }),
            },
          },
        }),
      });

    it.live("leaves the Image row out of the details block", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out } = rePush(repo.dir);

        return yield* Effect.gen(function* () {
          yield* push({ noWait: true });

          expect(out.stdoutText).toContain("Deployed Compute api");
          expect(out.stdoutText).not.toContain("v7");
          expect(out.stdoutText).not.toContain("Image");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("omits image_version from the payload a script reads", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out } = rePush(repo.dir, "json");

        return yield* Effect.gen(function* () {
          yield* push({ noWait: true });

          const success = out.messages.findLast(
            (message) => message.type === "success" && message.data !== undefined,
          );
          // Whole-payload rather than a missing-key assertion: beside
          // `build_state: "building"`, an `image_version` reads as this build's.
          expect(success?.data?.["compute"]).toEqual([
            {
              compute_name: "api",
              runtime: "node",
              size: "2gb-1vcpu",
              exposure: "public",
              instances: 1,
              build_state: "building",
              url: `https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`,
            },
          ]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.live("still reports the image once the build has settled", () =>
      Effect.gen(function* () {
        const repo = yield* project();
        const { layer, out } = setupCompute({ workdir: repo.dir, routes: routes() });

        return yield* Effect.gen(function* () {
          yield* push();

          // The mirror case: blanking is tied to `building`, not to re-pushes.
          expect(out.stdoutText).toContain("v1");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  // Under `--no-wait` the payload reports the accepted deploy rather than a
  // finished one: the build has not produced an image, and saying `active`
  // would tell a script the compute is already serving.
  it.live("reports the build as still running in json mode under --no-wait", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        format: "json",
        routes: routes(),
      });

      return yield* Effect.gen(function* () {
        yield* push({ noWait: true });

        const success = out.messages.findLast(
          (message) => message.type === "success" && message.data !== undefined,
        );
        expect(success?.data?.["compute"]).toEqual([
          {
            compute_name: "api",
            runtime: "node",
            size: "2gb-1vcpu",
            exposure: "public",
            instances: 1,
            build_state: "building",
            url: `https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `--output-format json` asked for a stream of events, so progress does not
  // belong in it — unlike the "not attempted" report, which every format gets.
  it.live("keeps per-compute progress out of json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\n\n[compute.web]\nruntime = "node"\n`,
        "supabase/compute/web/index.js": "export default {};\n",
      });
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        format: "json",
        routes: {
          ...routes(),
          [`POST ${computeRoute("/web/uploads")}`]: { status: 201, body: uploadSlot },
          [`POST ${computeRoute("/web/deploy")}`]: {
            status: 202,
            body: {
              data: computeResource({ name: "web", runtime: "node", buildState: "building" }),
            },
          },
          [`GET ${computeRoute("/web")}`]: {
            status: 200,
            body: { data: computeResource({ name: "web", runtime: "node", buildState: "active" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* push({ names: [] });

        expect(out.stderrText).not.toContain("Deploying Compute");
        expect(out.stdoutText).not.toContain("Deployed 2 Compute");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `-o env` cannot express the `compute` array. Discovering that at emit time
  // meant failing with the project already changed, inviting a retry that
  // deployed all over again.
  it.live("refuses -o env before making any request at all", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        routes: routes(),
        goOutput: "env",
      });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeEnvNotSupportedError);
        expect(http.routeKeys).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The "nothing to deploy" guard counts directory entries, so without this a tree
  // of empty subdirectories packages to zero files and deploys an image with no
  // handler in it.
  it.live("refuses a source holding only empty directories, before minting a slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/compute/api/nested/.keep": "" });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api", "index.js"));
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api", "nested", ".keep"));
      const { layer, http } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        expect((error as ComputeSourceMissingError).suggestion).not.toContain("--force");
        expect((error as ComputeSourceMissingError).suggestion).not.toContain("compute new");
        expect(http.routeKeys).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The runtime guess is an inference about the contents of a directory, so it
  // has no business being reported for a directory that is not there.
  it.live("does not report a guessed runtime when the source is missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/config.toml": 'project_id = "demo"\n' });
      yield* fs.remove(path.join(repo.dir, "supabase", "compute", "api"), {
        recursive: true,
        force: true,
      });
      const { layer, out } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        const error = yield* push().pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeSourceMissingError);
        expect(out.stderrText).not.toContain("guessed");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `image_version` is optional in the response. Present-but-undefined made the
  // TOML encoder throw, after the upload and deploy had already completed.
  it.live("encodes -o toml when the deployed compute has no image version", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        goOutput: "toml",
        routes: routes({
          [`GET ${computeRoute("/api")}`]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", buildState: "active" }) },
          },
        }),
      });

      return yield* Effect.gen(function* () {
        yield* push();

        expect(out.stdoutText).toContain("compute_name");
        expect(out.stdoutText).not.toContain("image_version");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A malformed config.toml must fail inside the finalizers, or the run skips the
  // telemetry flush every invocation is supposed to perform.
  it.live("flushes telemetry when the project config cannot be loaded", () =>
    Effect.gen(function* () {
      const repo = yield* project({ "supabase/config.toml": "project_id = [unclosed\n" });
      const { layer, telemetry } = setupCompute({ workdir: repo.dir, routes: routes() });

      return yield* Effect.gen(function* () {
        yield* push().pipe(Effect.flip);

        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
