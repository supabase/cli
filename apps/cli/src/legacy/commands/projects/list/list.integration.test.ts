import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyProjectsList } from "./list.handler.ts";

type Projects = typeof V1ListAllProjectsOutput.Type;

const SAMPLE_PROJECT: Projects[number] = {
  id: LEGACY_VALID_REF,
  ref: LEGACY_VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const OTHER_PROJECT: Projects[number] = {
  ...SAMPLE_PROJECT,
  id: "qrstuvwxyzabcdefghij",
  ref: "qrstuvwxyzabcdefghij",
  name: "beta",
  region: "eu-west-1",
};

// A project whose `id` is the parent-fallback ref used below (CLI-2167
// follow-up) — distinct from `SAMPLE_PROJECT`/`OTHER_PROJECT`.
const PARENT_PROJECT: Projects[number] = {
  ...SAMPLE_PROJECT,
  id: "parentprojectrefxxxx",
  ref: "parentprojectrefxxxx",
  name: "parent",
  region: "us-west-1",
};

const tempRoot = useLegacyTempWorkdir("supabase-projects-list-int-");
const pathService = Effect.runSync(Effect.provide(Path.Path, Path.layer));
const join = pathService.join;
const stringifyJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Distinct 20-lowercase-letter refs for the parent-fallback marker tests
// below (CLI-2167 follow-up).
const BRANCH_OWN_REF = "branchownrefyyyyyyyy";
const OTHER_CACHE_REF = "othercacherefzzzzzzz";

function tempFile(workdir: string, name: string): string {
  return join(workdir, "supabase", ".temp", name);
}

function writeTempContent(workdir: string, name: string, content: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(workdir, "supabase", ".temp"), { recursive: true });
    yield* fs.writeFileString(tempFile(workdir, name), content);
  });
}

function writeProjectRefFile(workdir: string, ref: string) {
  return writeTempContent(workdir, "project-ref", ref);
}

function writeLinkedProjectCacheFile(workdir: string, ref: string) {
  return writeTempContent(
    workdir,
    "linked-project.json",
    stringifyJson({
      ref,
      name: "Parent Project",
      organization_id: "org_1",
      organization_slug: "acme",
    }),
  );
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: Projects;
  readonly status?: number;
  readonly network?: "fail";
  // When `false`, the linked project ref is unset so no bullet renders.
  readonly linked?: boolean;
  // Explicit override — takes precedence over `linked` when provided, for
  // tests that need to seed `SUPABASE_PROJECT_ID` to something other than
  // the `linked: true` default (CLI-2167 follow-up parent-fallback tests).
  readonly projectId?: Option.Option<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_PROJECT] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId:
      opts.projectId ?? (opts.linked === false ? Option.none() : Option.some(LEGACY_VALID_REF)),
  });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, workdir: tempRoot.current };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_PROJECT] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.linked === false ? Option.none() : Option.some(LEGACY_VALID_REF),
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, telemetry, cache };
}

describe("legacy projects list integration", () => {
  it.live("renders a Glamour table with all six columns in text mode", () => {
    const { layer, out } = setup({ response: [SAMPLE_PROJECT, OTHER_PROJECT] });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).toContain("LINKED");
      expect(out.stdoutText).toContain("ORG ID");
      expect(out.stdoutText).toContain("REFERENCE ID");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("REGION");
      expect(out.stdoutText).toContain("CREATED AT (UTC)");
      expect(out.stdoutText).toContain("East US (North Virginia)");
      expect(out.stdoutText).toContain("2026-05-27 01:02:03");
      expect(out.stdoutText).toContain("alpha");
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the linked project with a bullet", () => {
    const { layer, out } = setup({ response: [SAMPLE_PROJECT], linked: true });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).toContain("●");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders no bullet when nothing is linked", () => {
    const { layer, out } = setup({ response: [SAMPLE_PROJECT], linked: false });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).not.toContain("●");
    }).pipe(Effect.provide(layer));
  });

  it.live("warns on stderr when no project is linked (Go parity)", () => {
    const { layer, out } = setup({ response: [SAMPLE_PROJECT], linked: false });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stderrText).toContain("Cannot find project ref. Have you run supabase link?");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not warn on stderr when a project is linked", () => {
    const { layer, out } = setup({ response: [SAMPLE_PROJECT], linked: true });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stderrText).not.toContain("Cannot find project ref");
    }).pipe(Effect.provide(layer));
  });

  describe("parent-fallback marker after linking a branch (CLI-2167 follow-up)", () => {
    it.live(
      "marks the parent's row (via linked-project.json) when the linked ref is a branch not in the list, asserting both the bullet and json linked:true",
      () => {
        const { layer, out, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_PROJECT, PARENT_PROJECT],
        });
        return Effect.gen(function* () {
          yield* writeProjectRefFile(workdir, BRANCH_OWN_REF);
          yield* writeLinkedProjectCacheFile(workdir, PARENT_PROJECT.id);
          yield* legacyProjectsList({});
          expect(out.stdoutText).toContain("●");
          expect(out.stdoutText).toContain("parent");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("marks the parent row with linked:true in the json payload (structured output)", () => {
      const { layer, out, workdir } = setup({
        format: "json",
        projectId: Option.none(),
        response: [SAMPLE_PROJECT, PARENT_PROJECT],
      });
      return Effect.gen(function* () {
        yield* writeProjectRefFile(workdir, BRANCH_OWN_REF);
        yield* writeLinkedProjectCacheFile(workdir, PARENT_PROJECT.id);
        yield* legacyProjectsList({});
        const success = out.messages.find((m) => m.type === "success");
        const projects = success?.data?.projects as ReadonlyArray<{
          id: string;
          linked: boolean;
        }>;
        expect(projects.find((p) => p.id === PARENT_PROJECT.id)?.linked).toBe(true);
        expect(projects.find((p) => p.id === SAMPLE_PROJECT.id)?.linked).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "an exact match wins outright — a cache pointing at a different project must not steal the marker",
      () => {
        const { layer, out, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_PROJECT, PARENT_PROJECT],
        });
        // Directly linked to SAMPLE_PROJECT (a real row) — the cache pointing
        // elsewhere must be irrelevant since the exact match short-circuits.
        return Effect.gen(function* () {
          yield* writeProjectRefFile(workdir, SAMPLE_PROJECT.id);
          yield* writeLinkedProjectCacheFile(workdir, OTHER_CACHE_REF);
          yield* legacyProjectsList({});
          expect(out.stdoutText).toContain("●");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "no marker when the linked ref matches no row and the parent chain yields nothing usable",
      () => {
        const { layer, out } = setup({
          // Present but not ref-shaped: `resolveOptional` returns it unvalidated
          // (so `linkedRef` is Some, matching no row), while the parent chain's
          // only candidate is this same invalid value — kind "invalid", not
          // "resolved" — so the fallback also yields nothing.
          projectId: Option.some("not-a-valid-ref"),
          response: [SAMPLE_PROJECT, PARENT_PROJECT],
        });
        return Effect.gen(function* () {
          yield* legacyProjectsList({});
          expect(out.stdoutText).not.toContain("●");
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.live("emits a success event with { projects } for --output-format json", () => {
    const { layer, out } = setup({ format: "json", response: [SAMPLE_PROJECT], linked: true });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ projects: [{ linked: true }] });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: [SAMPLE_PROJECT] });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON including `linked` for --output json", () => {
    const { layer, out } = setup({ goOutput: "json", response: [SAMPLE_PROJECT], linked: true });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText.startsWith("[\n  {\n")).toBe(true);
      expect(out.stdoutText.endsWith("]\n")).toBe(true);
      expect(out.stdoutText).toContain('"linked": true');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: [SAMPLE_PROJECT] });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).toContain("name: alpha");
      expect(out.stdoutText).toContain("linked:");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps the result as { projects = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: [SAMPLE_PROJECT] });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).toContain("[[projects]]");
      // PascalCase field names, embedded fields first, `Linked` last, and
      // the Database sub-table after the primitives.
      expect(out.stdoutText).toContain('  Name = "alpha"');
      expect(out.stdoutText).toContain("  Linked = true");
      expect(out.stdoutText).toContain("  [projects.Database]");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: [SAMPLE_PROJECT] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = stringifyJson(exit.cause);
        expect(json).toContain("LegacyProjectsEnvNotSupportedError");
        expect(json).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = stringifyJson(exit.cause);
        expect(json).toContain("LegacyProjectsListNetworkError");
        expect(json).toContain("failed to list projects");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsListUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ status: 500, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(stringifyJson(exit.cause)).toContain("LegacyProjectsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with an unexpected-status error when the body is not an array", () => {
    const { layer } = setup({ response: {} as unknown as Projects });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(stringifyJson(exit.cause)).toContain("LegacyProjectsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("tolerates placeholder/short refs in the response (lenient parse)", () => {
    // The typed client rejects refs shorter than 20 chars; the raw-HTTP path
    // must render them verbatim (cli-e2e fixtures embed `__PROJECT_REF__`).
    const placeholder = { ...SAMPLE_PROJECT, id: "__PROJECT_REF__", ref: "__PROJECT_REF__" };
    const { layer, out } = setup({ response: [placeholder as unknown as Projects[number]] });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(out.stdoutText).toContain("__PROJECT_REF__");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked({ linked: true });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry but skips the cache write when nothing is linked", () => {
    const { layer, telemetry, cache } = setupTracked({ linked: false });
    return Effect.gen(function* () {
      yield* legacyProjectsList({});
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
