import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
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

const tempRoot = useLegacyTempWorkdir("supabase-projects-list-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: Projects;
  readonly status?: number;
  readonly network?: "fail";
  // When `false`, the linked project ref is unset so no bullet renders.
  readonly linked?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_PROJECT] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.linked === false ? Option.none() : Option.some(LEGACY_VALID_REF),
  });
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
      expect(out.stdoutText).toContain('name = "alpha"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: [SAMPLE_PROJECT] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
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
        const json = JSON.stringify(exit.cause);
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
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the API returns a malformed project body (decode failure)", () => {
    const { layer } = setup({ response: [{ id: "x" }] as unknown as Projects });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
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
