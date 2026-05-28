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
  id: "11111111-2222-3333-4444-555555555555",
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

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: Branches;
  readonly status?: number;
  readonly network?: "fail";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_BRANCH] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
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

  it.live("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("name: feat-1");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps result as { branches = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: [SAMPLE_BRANCH] });
    return Effect.gen(function* () {
      yield* legacyBranchesList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("[[branches]]");
      expect(out.stdoutText).toContain('name = "feat-1"');
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
