import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

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
import { legacyBranchesList } from "./list.handler.ts";

type Branches = typeof V1ListAllBranchesOutput.Type;

const SAMPLE_BRANCH: Branches[number] = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "feat-1",
  project_ref: "aaaaaaaaaaaaaaaaaaaa",
  parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  is_default: false,
  git_branch: "feat-1",
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
};

const SAMPLE_BRANCH_PIPE: Branches[number] = {
  ...SAMPLE_BRANCH,
  name: "with|pipe",
  git_branch: "g|pipe",
};

const tempRoot = useLegacyTempWorkdir("supabase-branches-list-int-");

// Distinct 20-lowercase-letter refs used across the parent-scoped resolution
// tests below (CLI-2167 follow-up), so it's unambiguous which candidate a
// given `listAllBranches` call actually used.
const PARENT_REF = "parentprojectrefxxxx";
const BRANCH_OWN_REF = "branchownrefyyyyyyyy";
const EXPLICIT_REF = "explicitprojectrefzz";
const ENV_REF = "envprojectrefaaaaaaa";
const CACHE_REF = "cacheprojectrefbbbbb";
const FILE_ONLY_REF = "fileonlyprojectrefcc";

function tempFile(workdir: string, name: string): string {
  return join(workdir, "supabase", ".temp", name);
}

function writeTempContent(workdir: string, name: string, content: string): void {
  mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(tempFile(workdir, name), content);
}

// Seeds `supabase/.temp/project-ref` — the 3rd-priority parent candidate, and
// (pre-CLI-2167-follow-up) the ONLY thing `branches` subcommands read.
function writeProjectRefFile(workdir: string, ref: string): void {
  writeTempContent(workdir, "project-ref", ref);
}

// Seeds `supabase/.temp/linked-project.json` — the 2nd-priority parent
// candidate, written by `link`'s own success path only for a REAL project.
function writeLinkedProjectCacheFile(workdir: string, ref: string): void {
  writeTempContent(
    workdir,
    "linked-project.json",
    JSON.stringify({
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
  readonly response?: Branches;
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_BRANCH] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: opts.projectId });
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
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_BRANCH] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

describe("legacy branches list integration", () => {
  it.live("renders a Glamour table with all 8 columns in text mode", () => {
    const { layer, out } = setup({ response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("ID");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("DEFAULT");
      expect(out.stdoutText).toContain("GIT BRANCH");
      expect(out.stdoutText).toContain("WITH DATA");
      expect(out.stdoutText).toContain("STATUS");
      expect(out.stdoutText).toContain("CREATED AT (UTC)");
      expect(out.stdoutText).toContain("UPDATED AT (UTC)");
      expect(out.stdoutText).toContain("feat-1");
      expect(out.stdoutText).toContain("2026-05-27 01:02:03");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders literal `|` characters in branch fields (Go parity)", () => {
    const { layer, out } = setup({ response: [SAMPLE_BRANCH_PIPE] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("with|pipe");
      expect(out.stdoutText).toContain("g|pipe");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders an empty table when API returns []", () => {
    const { layer, out } = setup({ response: [] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("STATUS");
      expect(out.stdoutText).not.toContain("feat-1");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { branches } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ branches: [SAMPLE_BRANCH] });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      // Output is indented JSON with sorted keys + trailing newline.
      expect(out.stdoutText.startsWith("[\n  {\n")).toBe(true);
      expect(out.stdoutText.endsWith("]\n")).toBe(true);
      // First key after sorting alphabetically is `created_at`.
      expect(out.stdoutText).toContain('"created_at": "2026-05-27T01:02:03Z"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact YAML for --output yaml", () => {
    // Second branch has every optional (Go pointer) field absent: Go
    // zero-fills the value fields and emits explicit nulls for nil pointers.
    const zeroBranch: Branches[number] = {
      id: "00000000-0000-0000-0000-000000000000",
      name: "Production",
      project_ref: "production-project-ref",
      parent_project_ref: "production-project-ref",
      is_default: true,
      persistent: false,
      status: "FUNCTIONS_DEPLOYED",
      created_at: "0001-01-01T00:00:00Z",
      updated_at: "0001-01-01T00:00:00Z",
      with_data: false,
    };
    const { layer, out } = setup({ goOutput: "yaml", response: [SAMPLE_BRANCH, zeroBranch] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      // Byte-exact Go parity: yaml.v3 lowercases the Go field names, renders
      // nil pointers as null, and leaves time.Time timestamps unquoted
      // (CLI-1975; golden shape verified against apps/cli-go).
      expect(out.stdoutText).toBe(`- createdat: 2026-05-27T01:02:03Z
  deletionscheduledat: null
  gitbranch: feat-1
  id: 11111111-2222-4333-8444-555555555555
  isdefault: false
  latestcheckrunid: null
  name: feat-1
  notifyurl: null
  parentprojectref: bbbbbbbbbbbbbbbbbbbb
  persistent: false
  prnumber: null
  previewprojectstatus: null
  projectref: aaaaaaaaaaaaaaaaaaaa
  reviewrequestedat: null
  status: MIGRATIONS_PASSED
  updatedat: 2026-05-27T01:02:04Z
  withdata: true
- createdat: 0001-01-01T00:00:00Z
  deletionscheduledat: null
  gitbranch: null
  id: 00000000-0000-0000-0000-000000000000
  isdefault: true
  latestcheckrunid: null
  name: Production
  notifyurl: null
  parentprojectref: production-project-ref
  persistent: false
  prnumber: null
  previewprojectstatus: null
  projectref: production-project-ref
  reviewrequestedat: null
  status: FUNCTIONS_DEPLOYED
  updatedat: 0001-01-01T00:00:00Z
  withdata: false
`);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits nothing for --output toml when the branch list is empty (Go nil slice)", () => {
    const { layer, out } = setup({ goOutput: "toml", response: [] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      // Go builds the list with append, so an empty list stays a nil slice
      // and BurntSushi writes no bytes at all.
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps result as { branches = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      // Byte-exact Go parity: BurntSushi emits PascalCase Go field names,
      // 2-space indentation, native TOML datetimes, and omits nil pointers
      // (CLI-1975; golden shape verified against apps/cli-go).
      expect(out.stdoutText).toBe(`[[branches]]
  CreatedAt = 2026-05-27T01:02:03Z
  GitBranch = "feat-1"
  Id = "11111111-2222-4333-8444-555555555555"
  IsDefault = false
  Name = "feat-1"
  ParentProjectRef = "bbbbbbbbbbbbbbbbbbbb"
  Persistent = false
  ProjectRef = "aaaaaaaaaaaaaaaaaaaa"
  Status = "MIGRATIONS_PASSED"
  UpdatedAt = 2026-05-27T01:02:04Z
  WithData = true
`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesEnvNotSupportedError");
        expect(json).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (table render)", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("STATUS");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag wins over --output-format", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: [SAMPLE_BRANCH],
    });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("name: feat-1");
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref to listAllBranches", () => {
    const { layer, api } = setup({ response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/branches`);
    }).pipe(Effect.provide(layer));
  });

  describe("parent-scoped resolution after linking a branch (CLI-2167 follow-up)", () => {
    it.live(
      "resolves the linked PARENT (not the branch's own ref) when linked to a branch, and renders the table",
      () => {
        // Colum's manual repro: `supabase link <branch>` leaves the branch's OWN
        // ref in project-ref, but linked-project.json still holds the real
        // parent. `branches list` must call the endpoint scoped to the parent.
        const { layer, out, api, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, BRANCH_OWN_REF);
        writeLinkedProjectCacheFile(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          expect(api.requests).toHaveLength(1);
          expect(api.requests[0]?.url).toContain(`/v1/projects/${PARENT_REF}/branches`);
          expect(out.stdoutText).toContain("STATUS");
          expect(out.stdoutText).toContain("feat-1");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "an explicit --project-ref still wins over both the cache and the project-ref file",
      () => {
        const { layer, api, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, BRANCH_OWN_REF);
        writeLinkedProjectCacheFile(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.some(EXPLICIT_REF) });
          expect(api.requests[0]?.url).toContain(`/v1/projects/${EXPLICIT_REF}/branches`);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("a valid SUPABASE_PROJECT_ID wins over both the cache and the project-ref file", () => {
      const { layer, api, workdir } = setup({
        projectId: Option.some(ENV_REF),
        response: [SAMPLE_BRANCH],
      });
      writeProjectRefFile(workdir, BRANCH_OWN_REF);
      writeLinkedProjectCacheFile(workdir, CACHE_REF);
      return Effect.gen(function* () {
        yield* legacyBranchesList({ projectRef: Option.none() });
        expect(api.requests[0]?.url).toContain(`/v1/projects/${ENV_REF}/branches`);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "SUPABASE_PROJECT_ID merely restating the linked branch ref is deduped; the cached parent wins (PR #6168 review)",
      () => {
        // CI exports the branch's own ref after `link <branch>`: env === file.
        // The env candidate adds no parent information beyond the file, so it
        // must not shadow the cache (which holds the real parent) — otherwise
        // parent-scoped endpoints 403 again.
        const { layer, api, workdir } = setup({
          projectId: Option.some(BRANCH_OWN_REF),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, BRANCH_OWN_REF);
        writeLinkedProjectCacheFile(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          expect(api.requests[0]?.url).toContain(`/v1/projects/${PARENT_REF}/branches`);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a garbage SUPABASE_PROJECT_ID falls through to the cache file and succeeds (previously failed before any API call)",
      () => {
        const { layer, api, workdir } = setup({
          projectId: Option.some("not-a-valid-ref"),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, FILE_ONLY_REF);
        writeLinkedProjectCacheFile(workdir, CACHE_REF);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          expect(api.requests).toHaveLength(1);
          expect(api.requests[0]?.url).toContain(`/v1/projects/${CACHE_REF}/branches`);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a garbage SUPABASE_PROJECT_ID with no cache and no file falls back to the unchanged LegacyInvalidProjectRefError",
      () => {
        const { layer, api } = setup({ projectId: Option.some("not-a-valid-ref") });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
          }
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("nothing linked anywhere, non-TTY, fails with the unchanged not-linked error", () => {
      const { layer, api } = setup({ projectId: Option.none() });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "the cache alone is never proof of a link: no project-ref file/env means LegacyProjectNotLinkedError, no API call (PR #6168 review)",
      () => {
        // Only linked-project.json exists — no supabase/.temp/project-ref and no
        // SUPABASE_PROJECT_ID. `legacyResolveLinkedParentRef`'s cache candidate
        // only ever participates once a link has actually completed (proven by
        // the project-ref file's presence, the fix this test pins) — a FAILED
        // `link` can leave a stale cache entry behind, so the cache by itself
        // must never be trusted as linked-state evidence.
        const { layer, api, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeLinkedProjectCacheFile(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
          }
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a normal (non-branch) linked state via the project-ref file alone is unaffected",
      () => {
        const { layer, api, workdir } = setup({
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, FILE_ONLY_REF);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          expect(api.requests[0]?.url).toContain(`/v1/projects/${FILE_ONLY_REF}/branches`);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("active-branch marker in the pretty table (CLI-2167 follow-up)", () => {
    const OTHER_BRANCH: Branches[number] = {
      ...SAMPLE_BRANCH,
      id: "66666666-7777-4888-8999-999999999999",
      name: "other",
      project_ref: "zzzzzzzzzzzzzzzzzzzz",
    };

    it.live("marks the linked branch's NAME cell with (active) and no other row", () => {
      const { layer, out, workdir } = setup({
        projectId: Option.none(),
        response: [SAMPLE_BRANCH, OTHER_BRANCH],
      });
      writeProjectRefFile(workdir, SAMPLE_BRANCH.project_ref);
      return Effect.gen(function* () {
        yield* legacyBranchesList({ projectRef: Option.none() });
        expect(out.stdoutText).toContain("feat-1 (active)");
        expect(out.stdoutText).not.toContain("other (active)");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "omits the marker entirely for --output json (Go machine format, byte-identical to before)",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: "json",
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, SAMPLE_BRANCH.project_ref);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          expect(out.stdoutText).not.toContain("active");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "omits the marker/field entirely for --output-format json (structured payload untouched)",
      () => {
        const { layer, out, workdir } = setup({
          format: "json",
          projectId: Option.none(),
          response: [SAMPLE_BRANCH],
        });
        writeProjectRefFile(workdir, SAMPLE_BRANCH.project_ref);
        return Effect.gen(function* () {
          yield* legacyBranchesList({ projectRef: Option.none() });
          const success = out.messages.find((m) => m.type === "success");
          expect(success?.data).toEqual({ branches: [SAMPLE_BRANCH] });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("renders no marker when the linked ref matches no listed branch", () => {
      const { layer, out } = setup({
        projectId: Option.some(EXPLICIT_REF),
        response: [SAMPLE_BRANCH],
      });
      return Effect.gen(function* () {
        yield* legacyBranchesList({ projectRef: Option.none() });
        expect(out.stdoutText).not.toContain("(active)");
      }).pipe(Effect.provide(layer));
    });
  });

  it.live("fails with LegacyBranchesListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesListUnexpectedStatusError");
        expect(json).toContain("unexpected list branch status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesListNetworkError");
        expect(json).toContain("failed to list branch");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 503 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesList({ projectRef: Option.none() }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
