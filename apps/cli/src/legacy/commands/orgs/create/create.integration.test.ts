import type { V1CreateAnOrganizationOutput } from "@supabase/api/effect";
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
import { legacyOrgsCreate } from "./create.handler.ts";

type CreatedOrganization = typeof V1CreateAnOrganizationOutput.Type;

const CREATED: CreatedOrganization = {
  id: "combined-fuchsia-lion",
  slug: "combined-fuchsia-lion",
  name: "Acme",
};

const tempRoot = useLegacyTempWorkdir("supabase-orgs-create-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: CreatedOrganization;
  readonly status?: number;
  readonly network?: "fail";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? CREATED },
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
    response: { status: opts.status ?? 201, body: opts.response ?? CREATED },
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

describe("legacy orgs create integration", () => {
  it.live('prints "Created organization: <id>" then a Glamour table in text mode', () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("Acme");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends POST /v1/organizations with { name } body", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain("/v1/organizations");
      expect(api.requests[0]?.body).toEqual({ name: "Acme" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact preamble + indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion\n");
      expect(out.stdoutText).toContain('"name": "Acme"');
      expect(out.stdoutText.endsWith("}\n")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits preamble + YAML object for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion\n");
      expect(out.stdoutText).toContain("name: Acme");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits preamble + TOML for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion\n");
      expect(out.stdoutText).toContain('name = "Acme"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits preamble + env vars for --output env (create-only branch)", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion\n");
      expect(out.stdoutText).toContain("NAME=");
      expect(out.stdoutText).toContain("Acme");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with org fields for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ id: "combined-fuchsia-lion", name: "Acme" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (preamble + table)", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("Created organization: combined-fuchsia-lion");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("Acme");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag wins over --output-format", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(out.stdoutText).toContain("name: Acme");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyOrgsCreateUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsCreate({ name: "Acme" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsCreateUnexpectedStatusError");
        expect(json).toContain("unexpected create organization status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyOrgsCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsCreate({ name: "Acme" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsCreateNetworkError");
        expect(json).toContain("failed to create organization");
      }
    }).pipe(Effect.provide(layer));
  });

  // Exercises the `creating?.fail() ?? Effect.void` undefined branch — when
  // --output-format != "text", no spinner exists, so the `??` fallback fires.
  it.live("propagates a transport failure when --output-format=json suppresses the spinner", () => {
    const { layer } = setup({ format: "json", network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyOrgsCreate({ name: "Acme" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyOrgsCreateNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on success", () => {
    const { layer, telemetry } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyOrgsCreate({ name: "Acme" });
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on failure", () => {
    const { layer, telemetry } = setupTracked({ status: 503 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyOrgsCreate({ name: "Acme" }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
