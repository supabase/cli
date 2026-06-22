import type { V1ListAllFunctionsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyFunctionsList } from "./list.handler.ts";

type Functions = typeof V1ListAllFunctionsOutput.Type;

const SAMPLE_FUNCTION: Functions[number] = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "hello-world",
  name: "Hello World",
  status: "ACTIVE",
  version: 2,
  created_at: 1_687_423_025_152,
  updated_at: 1_687_423_025_152,
  verify_jwt: true,
  import_map: false,
  entrypoint_path: "functions/hello-world/index.ts",
  import_map_path: null,
};

const PIPE_FUNCTION: Functions[number] = {
  ...SAMPLE_FUNCTION,
  name: "Hello|World",
  slug: "hello|world",
};

const NIL_OPTIONALS_FUNCTION: Functions[number] = {
  ...SAMPLE_FUNCTION,
  entrypoint_path: undefined,
  ezbr_sha256: undefined,
  import_map: undefined,
  import_map_path: null,
  verify_jwt: undefined,
};

const tempRoot = useLegacyTempWorkdir("supabase-functions-list-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: Functions;
  readonly status?: number;
  readonly network?: "fail";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_FUNCTION] },
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
    response: { status: opts.status ?? 200, body: opts.response ?? [SAMPLE_FUNCTION] },
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

describe("legacy functions list integration", () => {
  it.live("renders a Glamour table with all 6 columns in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("ID");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("SLUG");
      expect(out.stdoutText).toContain("STATUS");
      expect(out.stdoutText).toContain("VERSION");
      expect(out.stdoutText).toContain("UPDATED_AT (UTC)");
      expect(out.stdoutText).toContain("Hello World");
      expect(out.stdoutText).toContain("2023-06-22 08:37:05");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders literal `|` characters in table cells (Go parity)", () => {
    const { layer, out } = setup({ response: [PIPE_FUNCTION] });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Hello|World");
      expect(out.stdoutText).toContain("hello|world");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders an empty table when the API returns []", () => {
    const { layer, out } = setup({ response: [] });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("UPDATED_AT (UTC)");
      expect(out.stdoutText).not.toContain("Hello World");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { functions } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      const success = out.messages.find((message) => message.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ functions: [SAMPLE_FUNCTION] });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.messages.find((message) => message.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText.startsWith("[\n  {\n")).toBe(true);
      expect(out.stdoutText.endsWith("]\n")).toBe(true);
      expect(out.stdoutText).toContain('"created_at": 1687423025152');
      expect(out.stdoutText).not.toContain('"import_map_path": null');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("createdat: 1687423025152");
      expect(out.stdoutText).toContain("entrypointpath: functions/hello-world/index.ts");
      expect(out.stdoutText).toContain("verifyjwt: true");
      expect(out.stdoutText).not.toContain("created_at:");
      expect(out.stdoutText).not.toContain("entrypoint_path:");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves nil optional fields as null in YAML output", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: [NIL_OPTIONALS_FUNCTION] });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("entrypointpath: null");
      expect(out.stdoutText).toContain("ezbrsha256: null");
      expect(out.stdoutText).toContain("importmap: null");
      expect(out.stdoutText).toContain("importmappath: null");
      expect(out.stdoutText).toContain("verifyjwt: null");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps the result as { functions = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("[[functions]]");
      expect(out.stdoutText).toContain("CreatedAt = 1687423025152");
      expect(out.stdoutText).toContain('EntrypointPath = "functions/hello-world/index.ts"');
      expect(out.stdoutText).toContain('Name = "Hello World"');
      expect(out.stdoutText).not.toContain("created_at");
      expect(out.stdoutText).not.toContain("entrypoint_path");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyFunctionsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyFunctionsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyFunctionsEnvNotSupportedError");
        expect(json).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (table render)", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Hello World");
      expect(out.stdoutText).toContain("UPDATED_AT (UTC)");
    }).pipe(Effect.provide(layer));
  });

  it.live("lets --output pretty win over --output-format json", () => {
    const { layer, out } = setup({ format: "json", goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Hello World");
      expect(out.stdoutText).toContain("UPDATED_AT (UTC)");
      expect(out.messages.find((message) => message.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag wins over --output-format", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("name: Hello World");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref to listAllFunctions", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/functions`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref over the linked project default", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.some("qrstuvwxyzabcdefghij") });
      expect(api.requests[0]?.url).toContain("/v1/projects/qrstuvwxyzabcdefghij/functions");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyFunctionsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyFunctionsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyFunctionsListUnexpectedStatusError");
        expect(json).toContain("unexpected list functions status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyFunctionsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyFunctionsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyFunctionsListNetworkError");
        expect(json).toContain("failed to list functions");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on failure", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 503, response: [] });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyFunctionsList({ projectRef: Option.none() }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: [] });
    return Effect.gen(function* () {
      yield* legacyFunctionsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((message) => message.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
