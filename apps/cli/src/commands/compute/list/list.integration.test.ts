import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeComputeProject,
  setupCompute,
  computeResource,
  computeRoute,
  COMPUTE_PROJECT_REF,
} from "../../../../tests/helpers/compute.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ComputeEnvNotSupportedError } from "../compute.errors.ts";
import {
  ComputeApiUnexpectedStatusError,
  ComputeUnavailableError,
} from "../../../shared/compute/compute.errors.ts";
import { computeList } from "./list.handler.ts";

const CONFIG = `project_id = "demo"

[compute.api]
runtime = "node"
size = "2gb"

[compute.old]
runtime = "deno"
`;

function project(config = CONFIG) {
  const created = makeComputeProject({ "supabase/config.toml": config });
  return {
    dir: created.dir,
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

const listRoute = `GET ${computeRoute()}`;

describe("compute list", () => {
  it.live("shows configured and deployed compute as one inventory", () => {
    const repo = project();
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: {
            data: [
              computeResource({ name: "api", runtime: "node", imageVersion: "v3" }),
              computeResource({
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
      yield* computeList({ projectRef: Option.none() });

      const stdout = out.stdoutText;
      expect(stdout).toContain("NAME");

      const rows = stdout.split("\n").filter((line) => /\|/.test(line) && /api|box|old/.test(line));
      expect(rows).toHaveLength(3);
      // Sorted by name, so `api`, `box`, then the scaffolded-but-undeployed `old`.
      expect(rows[0]).toContain("2gb (1 vCPU)");
      // The URL is deliberately not a column: one derivable field pushed the
      // table past 130 columns. The machine payload still carries it.
      expect(stdout).not.toContain("https://");
      expect(rows[1]).toContain("sandbox");
      expect(rows[2]).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not assert a runtime for a compute that has never been deployed", () => {
    const repo = project(`project_id = "demo"\n\n[compute.ghost]\n`);
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      const row = out.stdoutText.split("\n").find((line) => line.includes("ghost"));
      expect(row).toBeDefined();
      expect(row).not.toContain("dockerfile");
      expect(row).toContain("not deployed");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A local directory with no `[compute.<name>]` entry: pushable, and the
  // runtime is the only thing a push would have to work out for itself.
  it.live("calls out a deployed compute that config.toml does not know about", () => {
    const created = makeComputeProject({
      "supabase/config.toml": `project_id = "demo"\n`,
      "supabase/compute/stray/index.js": "export default {};\n",
    });
    const repo = {
      dir: created.dir,
      cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
    };
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "stray", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stderrText).toContain("stray");
      expect(out.stderrText).toContain("guess the runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Two of them, so the advisory has to read as a list rather than as one name
  // with a stray verb.
  it.live("calls out every deployed compute config.toml does not know about", () => {
    const created = makeComputeProject({
      "supabase/config.toml": `project_id = "demo"\n`,
      "supabase/compute/stray/index.js": "export default {};\n",
      "supabase/compute/spare/index.js": "export default {};\n",
    });
    const repo = {
      dir: created.dir,
      cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
    };
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: {
            data: [
              computeResource({ name: "stray", runtime: "node" }),
              computeResource({ name: "spare", runtime: "node" }),
            ],
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stderrText).toContain("spare, stray are deployed but not in");
      expect(out.stderrText).toContain("guess the runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Deletion is asynchronous, so a compute can be listed while it is being torn
  // down. Reporting its build state would show `active` for something on its
  // way out.
  it.live("shows a compute being torn down as deleting", () => {
    const repo = project(`project_id = "demo"\n\n[compute.api]\nruntime = "node"\n`);
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "api", runtime: "node", deleting: true })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("deleting");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Nothing local at all: `deployOneCompute` checks the source directory before
  // it ever infers a runtime, so "would have to guess the runtime" named the
  // wrong prerequisite for this one.
  it.live("tells a compute with no local source to restore it, not to expect a guess", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "stray", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stderrText).toContain("no source in this project");
      expect(out.stderrText).not.toContain("guess the runtime");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so when the project has no compute at all", () => {
    const repo = project(`project_id = "demo"\n`);
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain(
        "No compute found. Scaffold one with supabase compute new <name>.",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the inventory as structured data in json mode", () => {
    const repo = project();
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      format: "json",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data).toMatchObject({ project_ref: COMPUTE_PROJECT_REF });
      expect(success?.data?.["compute"]).toEqual([
        {
          name: "api",
          configured: true,
          local: true,
          deployed: true,
          runtime: "node",
          size: "2gb-1vcpu",
          state: "active",
          instances: 1,
          url: `https://${COMPUTE_PROJECT_REF}.supabase.co/workers/v1/api`,
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
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      // `-o` payloads own stdout outright: no clack success line may share it.
      const parsed = JSON.parse(out.stdoutText);
      expect(parsed.project_ref).toBe(COMPUTE_PROJECT_REF);
      expect(parsed.compute).toHaveLength(2);
      expect(out.messages.filter((m) => m.type === "success")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before making any request at all", () => {
    const repo = project();
    const { layer, http } = setupCompute({
      workdir: repo.dir,
      goOutput: "env",
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      const error = yield* computeList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeEnvNotSupportedError);
      expect(http.routeKeys).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha as unavailable", () => {
    const repo = project();
    const { layer } = setupCompute({
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
      const error = yield* computeList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces an unexpected status rather than showing an empty list", () => {
    const repo = project();
    const { layer } = setupCompute({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 500, body: { message: "boom" } } },
    });

    return Effect.gen(function* () {
      const error = yield* computeList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("uses an explicit --project-ref without a linked project", () => {
    const repo = project();
    const { layer, http } = setupCompute({
      workdir: repo.dir,
      linked: false,
      routes: {
        "GET /v2/projects/qrstuvwxyzabcdefghij/workers": { status: 200, body: { data: [] } },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.some("qrstuvwxyzabcdefghij") });

      expect(http.routeKeys).toEqual(["GET /v2/projects/qrstuvwxyzabcdefghij/workers"]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("requires a linked project when no ref is given", () => {
    const repo = project();
    const { layer } = setupCompute({ workdir: repo.dir, linked: false });

    return Effect.gen(function* () {
      const error = yield* computeList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A directory under the compute root with no `[compute.<name>]` entry is what
  // a bare `push` discovers and deploys, so an inventory that leaves it out can
  // say "No compute found" about a compute `push` would happily deploy.
  it.live("includes a local compute directory that has no config entry", () => {
    const repo = project('project_id = "demo"\n');
    mkdirSync(join(repo.dir, "supabase", "compute", "scaffolded"), { recursive: true });
    writeFileSync(join(repo.dir, "supabase", "compute", "scaffolded", "index.js"), "export {};\n");
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      routes: { [listRoute]: { status: 200, body: { data: [] } } },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("scaffolded");
      expect(out.stdoutText).not.toContain("No compute found");
      // Never deployed, so it is not announced as a deployed-but-unconfigured
      // orphan either.
      expect(out.stderrText).not.toContain("scaffolded");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The API omits `spec.runtime` only for a context-only build, so for a
  // deployed compute its absence *is* dockerfile. Falling back to the local
  // config there made `-o json` report a runtime the text table contradicted.
  it.live("reports a deployed dockerfile compute as dockerfile in both renderings", () => {
    const repo = project('project_id = "demo"\n\n[compute.api]\nruntime = "node"\n');
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      format: "json",
      routes: {
        [listRoute]: { status: 200, body: { data: [computeResource({ name: "api" })] } },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      const success = out.messages.findLast(
        (message) => message.type === "success" && message.data !== undefined,
      );
      expect(success?.data?.["compute"]).toMatchObject([{ name: "api", runtime: "dockerfile" }]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // An undeployed compute has no `size`/`instances` and a private one no `url`,
  // so a realistic inventory hands the encoder a payload full of holes. Pins
  // that they are omitted rather than rendered or thrown on.
  it.live("encodes TOML for an inventory holding undeployed and private compute", () => {
    const repo = project();
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      goOutput: "toml",
      routes: {
        [listRoute]: {
          status: 200,
          body: {
            data: [computeResource({ name: "api", runtime: "node", exposure: "private" })],
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("project_ref = ");
      expect(out.stdoutText).not.toContain("undefined");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("encodes YAML when -o yaml asks for it", () => {
    const repo = project();
    const { layer, out } = setupCompute({
      workdir: repo.dir,
      goOutput: "yaml",
      routes: {
        [listRoute]: {
          status: 200,
          body: { data: [computeResource({ name: "api", runtime: "node" })] },
        },
      },
    });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() });

      expect(out.stdoutText).toContain("project_ref:");
      expect(out.stdoutText).toContain("name: api");
      // The table would have gone to stdout too, and broken the document.
      expect(out.stdoutText).not.toContain("NAME");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `pretty` is the human default; `table` and `csv` are accepted by the global
  // flag for `db query`'s benefit, and every resource command is meant to ignore
  // them and render text. Falling through to the TOML encoder is the trap the
  // payload allowlist closes.
  it.live.each(["pretty", "table", "csv"] as const)(
    "renders text rather than TOML for -o %s",
    (goOutput) => {
      const repo = project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        goOutput,
        routes: {
          [listRoute]: {
            status: 200,
            body: { data: [computeResource({ name: "api", runtime: "node" })] },
          },
        },
      });

      return Effect.gen(function* () {
        yield* computeList({ projectRef: Option.none() });

        expect(out.stdoutText).toContain("NAME");
        expect(out.stdoutText).not.toContain("project_ref = ");
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    },
  );

  it.live("flushes telemetry when the project config cannot be loaded", () => {
    const repo = project("project_id = [unclosed\n");
    const { layer, telemetry } = setupCompute({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* computeList({ projectRef: Option.none() }).pipe(Effect.flip);

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // CLI-2285: `loadComputeProject`'s JSON-capable read must thread the
  // ancestor-search predicate — the workdir's own default resolution only
  // probes config.toml, so a config.json-only project invoked from a
  // subdirectory relied on this second climb to be found at all.
  it.live(
    "discovers a config.json-only project's [compute.*] entry from a subdirectory when --workdir is defaulted",
    () => {
      const created = makeComputeProject({
        "supabase/config.json": JSON.stringify({
          project_id: "demo",
          compute: { api: { runtime: "node", size: "2gb" } },
        }),
      });
      const sub = join(created.dir, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const cleanup = () => rmSync(created.dir, { recursive: true, force: true });
      const { layer, out } = setupCompute({
        workdir: sub,
        explicitWorkdir: false,
        routes: { [listRoute]: { status: 200, body: { data: [] } } },
      });

      return Effect.gen(function* () {
        yield* computeList({ projectRef: Option.none() });

        const row = out.stdoutText.split("\n").find((line) => line.includes("api"));
        expect(row).toBeDefined();
        expect(row).toContain("not deployed");
        expect(row).toContain("node");
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
    },
  );

  it.live(
    "does not discover the same config.json-only entry when --workdir is explicit (preserves bare-directory scaffolding semantics)",
    () => {
      const created = makeComputeProject({
        "supabase/config.json": JSON.stringify({
          project_id: "demo",
          compute: { api: { runtime: "node", size: "2gb" } },
        }),
      });
      const sub = join(created.dir, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const cleanup = () => rmSync(created.dir, { recursive: true, force: true });
      const { layer, out } = setupCompute({
        workdir: sub,
        explicitWorkdir: true,
        routes: { [listRoute]: { status: 200, body: { data: [] } } },
      });

      return Effect.gen(function* () {
        yield* computeList({ projectRef: Option.none() });

        expect(out.stdoutText).not.toContain("api");
        expect(out.stdoutText).toContain("No compute found.");
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
    },
  );
});
