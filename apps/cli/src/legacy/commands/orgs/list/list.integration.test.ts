import type { V1ListAllOrganizationsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyOrgsList } from "./list.handler.ts";

type Organizations = typeof V1ListAllOrganizationsOutput.Type;

const SAMPLE_ORG: Organizations[number] = {
  id: "combined-fuchsia-lion",
  slug: "combined-fuchsia-lion",
  name: "Test Org",
};

const SAMPLE_ORG_PIPE: Organizations[number] = {
  id: "calm-cobalt-emu",
  slug: "calm-cobalt-emu",
  name: "with|pipe",
};

const tempRoot = useLegacyTempWorkdir("supabase-orgs-list-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: Organizations;
  readonly status?: number;
  readonly network?: "fail";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_ORG] },
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
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_ORG] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
  });
  return { layer, out, api, telemetry };
}

describe("legacy orgs list integration", () => {
  it.live("renders a Glamour table with ID and NAME columns in text mode", () => {
    const { layer, out } = setup({ response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("ID");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("combined-fuchsia-lion");
      expect(out.stdoutText).toContain("Test Org");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders an empty table when the API returns []", () => {
    const { layer, out } = setup({ response: [] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).not.toContain("Test Org");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders literal | characters in organization names (Go parity)", () => {
    const { layer, out } = setup({ response: [SAMPLE_ORG_PIPE] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("with|pipe");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { organizations } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ organizations: [SAMPLE_ORG] });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText.startsWith("[\n  {\n")).toBe(true);
      expect(out.stdoutText.endsWith("]\n")).toBe(true);
      expect(out.stdoutText).toContain('"name": "Test Org"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("name: Test Org");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps result as { organizations = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("[[organizations]]");
      expect(out.stdoutText).toContain('name = "Test Org"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyOrgsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsEnvNotSupportedError");
        expect(json).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (table render)", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("Test Org");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag wins over --output-format", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: [SAMPLE_ORG],
    });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(out.stdoutText).toContain("name: Test Org");
    }).pipe(Effect.provide(layer));
  });

  it.live("calls GET /v1/organizations with no path params", () => {
    const { layer, api } = setup({ response: [SAMPLE_ORG] });
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain("/v1/organizations");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyOrgsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsListUnexpectedStatusError");
        expect(json).toContain("unexpected list organizations status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyOrgsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsListNetworkError");
        expect(json).toContain("failed to list organizations");
      }
    }).pipe(Effect.provide(layer));
  });

  // Exercises the `fetching?.fail() ?? Effect.void` undefined branch — when
  // --output-format != "text", no spinner exists, so the `??` fallback fires.
  it.live("propagates a transport failure when --output-format=json suppresses the spinner", () => {
    const { layer } = setup({ format: "json", network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsList({}));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsListNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on success", () => {
    const { layer, telemetry } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyOrgsList({});
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on failure", () => {
    const { layer, telemetry } = setupTracked({ status: 503 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyOrgsList({}));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
