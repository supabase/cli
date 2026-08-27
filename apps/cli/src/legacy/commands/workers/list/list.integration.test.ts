import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { LegacyWorkersEnvNotSupportedError } from "../workers.errors.ts";
import {
  WorkersApiUnexpectedStatusError,
  WorkersUnavailableError,
} from "../../../../shared/workers/workers.errors.ts";
import { legacyWorkersList } from "./list.handler.ts";

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

describe("legacy workers list", () => {
  it.live("shows configured and deployed workers as one inventory", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
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
      yield* legacyWorkersList({ projectRef: Option.none() });

      const stdout = out.stdoutText;
      expect(stdout).toContain("NAME");

      const rows = stdout.split("\n").filter((line) => /\|/.test(line) && /api|box|old/.test(line));
      expect(rows).toHaveLength(3);
      // Sorted by name, so `api`, `box`, then the scaffolded-but-undeployed `old`.
      expect(rows[0]).toContain("2gb (1 vCPU)");
      expect(rows[0]).toContain(`https://${WORKERS_PROJECT_REF}.supabase.co/workers/v1/api`);
      expect(rows[1]).toContain("sandbox");
      expect(rows[2]).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not assert a runtime for a worker that has never been deployed", () => {
    const repo = project(`project_id = "demo"\n\n[workers.ghost]\n`);
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      const row = out.stdoutText.split("\n").find((line) => line.includes("ghost"));
      expect(row).toBeDefined();
      expect(row).not.toContain("dockerfile");
      expect(row).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A local directory with no `[workers.<name>]` entry: pushable, and the
  // runtime is the only thing a push would have to work out for itself.
  it.live("calls out a deployed worker that config.toml does not know about", () => {
    const created = makeWorkersProject({
      "supabase/config.toml": `project_id = "demo"\n`,
      "supabase/workers/stray/index.js": "export default {};\n",
    });
    const repo = {
      dir: created.dir,
      cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
    };
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "stray", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      expect(out.stderrText).toContain("stray");
      expect(out.stderrText).toContain("guess the runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Nothing local at all: `deployOneWorker` checks the source directory before
  // it ever infers a runtime, so "would have to guess the runtime" named the
  // wrong prerequisite for this one.
  it.live("tells a worker with no local source to restore it, not to expect a guess", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "stray", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      expect(out.stderrText).toContain("no source in this project");
      expect(out.stderrText).not.toContain("guess the runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so when the project has no workers at all", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain(
        "No workers found. Scaffold one with supabase workers new <name>.",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the inventory as structured data in json mode", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toMatchObject({ project_ref: WORKERS_PROJECT_REF });
      expect(success?.data?.["workers"]).toEqual([
        {
          name: "api",
          configured: true,
          local: true,
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
          local: true,
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

  it.live("serialises the inventory for the Go -o flag", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [workerResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      // `-o` payloads own stdout outright: no clack success line may share it.
      const parsed = JSON.parse(out.stdoutText);
      expect(parsed.project_ref).toBe(WORKERS_PROJECT_REF);
      expect(parsed.workers).toHaveLength(2);
      expect(out.messages.filter((m) => m.type === "success")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before making any request at all", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "env",
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha as unavailable", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 404,
          body: {
            error: {
              code: "generic_not_found",
              message: "Workers are not available for this project",
            },
          },
        },
      },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected status rather than showing an empty list", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 500, body: { message: "boom" } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("uses an explicit --project-ref without a linked project", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      linked: false,
      routes: {
        "GET /v2/projects/qrstuvwxyzabcdefghij/workers": { status: 200, body: { data: [] } },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.some("qrstuvwxyzabcdefghij") });

      expect(http.routeKeys).toEqual(["GET /v2/projects/qrstuvwxyzabcdefghij/workers"]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("requires a linked project when no ref is given", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({ workdir: repo.dir, linked: false });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyProjectNotLinkedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A directory under the workers root with no `[workers.<name>]` entry is what
  // a bare `push` discovers and deploys, so an inventory that leaves it out can
  // say "No workers found" about a worker `push` would happily deploy.
  it.live("includes a local worker directory that has no config entry", () => {
    const repo = project('project_id = "demo"\n');
    mkdirSync(join(repo.dir, "supabase", "workers", "scaffolded"), { recursive: true });
    writeFileSync(join(repo.dir, "supabase", "workers", "scaffolded", "index.js"), "export {};\n");
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("scaffolded");
      expect(out.stdoutText).not.toContain("No workers found");
      // Never deployed, so it is not announced as a deployed-but-unconfigured
      // orphan either.
      expect(out.stderrText).not.toContain("scaffolded");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The API omits `spec.runtime` only for a context-only build, so for a
  // deployed worker its absence *is* dockerfile. Falling back to the local
  // config there made `-o json` report a runtime the text table contradicted.
  it.live("reports a deployed dockerfile worker as dockerfile in both renderings", () => {
    const repo = project('project_id = "demo"\n\n[workers.api]\nruntime = "node"\n');
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: {
        [listRoute]: { status: 200, body: { data: [workerResource({ name: "api" })] } },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data?.["workers"]).toMatchObject([{ name: "api", runtime: "dockerfile" }]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // An undeployed worker has no `size`/`instances` and a private one no `url`,
  // so a realistic inventory hands the encoder a payload full of holes. Pins
  // that they are omitted rather than rendered or thrown on.
  it.live("encodes TOML for an inventory holding undeployed and private workers", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "toml",
      routes: {
        [listRoute]: {
          status: 200,
          body: {
            data: [workerResource({ name: "api", runtime: "node", exposure: "private" })],
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("project_ref = ");
      expect(out.stdoutText).not.toContain("undefined");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `pretty` is the human default; `table` and `csv` are accepted by the global
  // flag for `db query`'s benefit, and every resource command is meant to ignore
  // them and render text. All three used to fall through to the TOML encoder,
  // which is the trap the payload allowlist closes.
  it.live.each(["pretty", "table", "csv"] as const)(
    "renders text rather than TOML for -o %s",
    (goOutput) => {
      const repo = project();
      const { layer, out } = setupLegacyWorkers({
        workdir: repo.dir,
        goOutput,
        routes: {
          [listRoute]: {
            status: 200,
            body: { data: [workerResource({ name: "api", runtime: "node" })] },
          },
        },
      });

      return Effect.gen(function* () {
        yield* legacyWorkersList({ projectRef: Option.none() });

        expect(out.stdoutText).toContain("NAME");
        expect(out.stdoutText).not.toContain("project_ref = ");
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    },
  );

  it.live("flushes telemetry when the project config cannot be loaded", () => {
    const repo = project("project_id = [unclosed\n");
    const { layer, telemetry } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
