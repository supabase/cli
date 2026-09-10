import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Path } from "effect";
import {
  makeComputeProject,
  setupCompute,
  computeResource,
  computeRoute,
  COMPUTE_PROJECT_REF,
} from "../../../../../tests/helpers/compute.ts";
import {
  InvalidComputeNameError,
  ComputeNotDeployedError,
} from "../../../../shared/compute/compute.errors.ts";
import { ComputeEnvNotSupportedError } from "../compute.errors.ts";
import { computeStatus } from "./status.handler.ts";

const CONFIG = `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsize = "2gb"\n`;

function project(files: Readonly<Record<string, string>> = {}) {
  return makeComputeProject({
    "supabase/config.toml": CONFIG,
    "supabase/compute/api/index.js": "export default {};\n",
    ...files,
  });
}

const getRoute = `GET ${computeRoute("/api")}`;

describe("compute status", () => {
  it.live("reports the deployment facts and the live instance tally", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
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

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        const stdout = out.stdoutText;
        expect(stdout).toContain("State");
        expect(stdout).toContain("active");
        expect(stdout).toContain("node");
        expect(stdout).toContain("2gb (1 vCPU)");
        expect(stdout).toContain("public");
        expect(stdout).toContain(COMPUTE_PROJECT_REF);
        expect(stdout).toContain("v3");
        expect(stdout).toContain("2/3 ready, 3 live, 1 stale");
        expect(stdout).toContain(`https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`);
        expect(stdout).toContain(path.join("supabase", "compute", "api"));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports the deployed runtime, not a stale config.toml entry", () =>
    Effect.gen(function* () {
      // config.toml says node; the deployment carries no spec.runtime, which the
      // API only omits for a context-only (Dockerfile) build.
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        const runtimeLine = out.stdoutText
          .split("\n")
          .find((line) => line.trim().startsWith("Runtime"));
        expect(runtimeLine).toContain("dockerfile");
        expect(runtimeLine).not.toContain("node");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("falls back to the declared count when no tally came back", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", instances: 2 }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("2 declared");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("warns rather than lying when the instance read-through failed", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                instancesError: "backend unreachable",
              }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stderrText).toContain("backend unreachable");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Mid-scale the snapshot and the desired spec disagree; reading the numerator
  // from one and the denominator from the other rendered fractions like
  // `3/1 ready`.
  it.live("reads the whole tally from one snapshot while scaling", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                instances: 1,
                instanceCounts: { declared: 3, live: 3, ready: 3, stale: 0 },
              }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("3/3 ready");
        expect(out.stdoutText).not.toContain("3/1 ready");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Deletion is asynchronous, so pushing here races the tombstone or resurrects
  // the compute the user is removing.
  it.live("withholds the build retry while the compute is being deleted", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: "failed",
                stateReason: "exit status 1",
                deleting: true,
              }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("deleting");
        expect(out.stdoutText).not.toContain("re-run supabase compute push");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("points a failed build at the retry, with the reason", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                buildState: "failed",
                stateReason: "exit status 1",
              }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("failed");
        expect(out.stdoutText).toContain("exit status 1");
        // The retry hint is a success trailer, which lands on stderr.
        expect(out.stderrText).toContain("supabase compute push api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("shows a compute being torn down as deleting", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", deleting: true }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("deleting");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails with `not deployed` and points at push", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        routes: { [getRoute]: { status: 404, body: { message: "compute not found" } } },
      });

      return yield* Effect.gen(function* () {
        const error = yield* computeStatus({
          name: "api",
          projectRef: Option.none(),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeNotDeployedError);
        const suggestion = error instanceof ComputeNotDeployedError ? error.suggestion : "";
        expect(suggestion).toContain("supabase compute push api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a name that could never have been written", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeStatus({
          name: "My_Compute",
          projectRef: Option.none(),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidComputeNameError);
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports the compute's source directory even when it lives outside supabase/", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsource = "packages/api"\n`,
        "packages/api/index.js": "export default {};\n",
      });
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain(path.join("packages", "api"));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A `source` that escapes the project cannot be resolved, so the describe
  // falls back to the default directory. Printing that named a path the entry
  // does not, presenting a guess as established local state.
  it.live("omits the source when the configured one cannot be resolved", () =>
    Effect.gen(function* () {
      const repo = yield* project({
        "supabase/config.toml": `project_id = "demo"\n\n[compute.api]\nruntime = "node"\nsource = "../../elsewhere"\n`,
      });
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("active");
        expect(out.stdoutText).not.toContain("Source");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("emits the same facts as structured data in json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        format: "json",
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({
                name: "api",
                runtime: "node",
                imageVersion: "v3",
                instanceCounts: { declared: 1, live: 1, ready: 1, stale: 0 },
              }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        const success = out.messages.findLast(
          (message) => message.type === "success" && message.data !== undefined,
        );
        expect(success?.data).toMatchObject({
          compute_name: "api",
          project_ref: COMPUTE_PROJECT_REF,
          runtime: "node",
          size: "2gb-1vcpu",
          exposure: "public",
          build_state: "active",
          image_version: "v3",
          declared_instances: 1,
          instances: { declared: 1, live: 1, ready: 1, stale: 0 },
        });
        // The detail lines are text-mode only.
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The JSON layer appends each success to stdout, so emitting the payload twice
  // made `JSON.parse(stdout)` fail outright and gave `stream-json` two terminal
  // result events.
  it.live("emits exactly one structured result in json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        format: "json",
        routes: {
          [getRoute]: { status: 200, body: { data: computeResource({ name: "api" }) } },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        const results = out.messages.filter(
          (message) => message.type === "success" && message.data !== undefined,
        );
        expect(results).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A compute deployed from another checkout has no entry and no directory here,
  // so `supabase/compute/<name>` is pure inference — reporting it as the
  // compute's source named a path that was not there.
  it.live("omits the source for a compute with nothing local to point at", () =>
    Effect.gen(function* () {
      const repo = yield* project({ "supabase/config.toml": 'project_id = "demo"\n' });
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [`GET ${computeRoute("/stray")}`]: {
            status: 200,
            body: { data: computeResource({ name: "stray" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "stray", projectRef: Option.none() });

        expect(out.stdoutText).not.toContain("compute/stray");
        expect(out.stdoutText).not.toContain("Source");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `root` is an ordinary compute name: a valid DNS label, and `[compute]` has no
  // reserved keys — `readComputeSection` reads every table under it as a compute.
  // Here as a guard against the name picking up a special case it never had.
  it.live("inspects a deployed compute named root", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out, http } = setupCompute({
        workdir: repo.dir,
        routes: {
          [`GET ${computeRoute("/root")}`]: {
            status: 200,
            body: { data: computeResource({ name: "root" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "root", projectRef: Option.none() });

        expect(out.stdoutText).toContain("active");
        expect(http.routeKeys).toEqual([`GET ${computeRoute("/root")}`]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `state_reason`, `image_version`, `deleting` and `instances_error` are all
  // optional, so a healthy compute's payload is mostly holes. Pins that they are
  // omitted rather than rendered.
  it.live("encodes TOML for a compute whose optional fields are absent", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        goOutput: "toml",
        routes: {
          [getRoute]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node", exposure: "private" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("compute_name = ");
        expect(out.stdoutText).not.toContain("undefined");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The project is consulted only for the optional Source row, so an unrelated
  // local parse error should not stand between the user and a remote compute
  // they named explicitly.
  it.live("inspects a remote compute despite an unparseable local config", () =>
    Effect.gen(function* () {
      const repo = yield* project({ "supabase/config.toml": "project_id = [unclosed\n" });
      const otherRef = "qrstuvwxyzabcdefghij";
      const { layer, out, http } = setupCompute({
        workdir: repo.dir,
        routes: {
          [`GET /v2/projects/${otherRef}/workers/api`]: {
            status: 200,
            body: { data: computeResource({ name: "api", runtime: "node" }) },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.some(otherRef) });

        expect(http.routeKeys).toEqual([`GET /v2/projects/${otherRef}/workers/api`]);
        expect(out.stdoutText).toContain("active");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The URL is derived from the exposure the platform reports, not assumed: a
  // compute it did not expose has no address to print, and the row is dropped
  // rather than rendered empty.
  it.live("omits the URL for a compute that is not publicly exposed", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        routes: {
          [getRoute]: {
            status: 200,
            body: {
              data: computeResource({ name: "api", runtime: "node", exposure: "private" }),
            },
          },
        },
      });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "api", projectRef: Option.none() });

        expect(out.stdoutText).toContain("private");
        expect(out.stdoutText).not.toContain("URL");
        expect(out.stdoutText).not.toContain("https://");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses -o env before making any request at all", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, http } = setupCompute({
        workdir: repo.dir,
        goOutput: "env",
        routes: { [getRoute]: { status: 200, body: { data: computeResource({ name: "api" }) } } },
      });

      return yield* Effect.gen(function* () {
        const error = yield* computeStatus({ name: "api", projectRef: Option.none() }).pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(ComputeEnvNotSupportedError);
        expect(http.routeKeys).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("flushes telemetry when the compute name is invalid", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, telemetry } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeStatus({ name: "Not_A_Label", projectRef: Option.none() }).pipe(Effect.flip);

        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
