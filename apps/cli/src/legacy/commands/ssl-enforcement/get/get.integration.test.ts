import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1GetSslEnforcementConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacySslEnforcementGet } from "./get.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SSL_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: true,
};

const SSL_NOT_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: false },
  appliedSuccessfully: false,
};

const SSL_DESIRED_BUT_NOT_APPLIED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: false,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetSslEnforcementConfigOutput.Type;
  status?: number;
  network?: "fail";
  stdinIsTty?: boolean;
  apiUrl?: string;
  userAgent?: string;
}

const tempRoot = useLegacyTempWorkdir("supabase-ssl-enforcement-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SSL_ENFORCED },
    network: opts.network,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy ssl-enforcement get integration", () => {
  it.live('prints "SSL is being enforced." when database=true and appliedSuccessfully=true', () => {
    const { layer, out } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live('prints "SSL is *NOT* being enforced." when database=false', () => {
    const { layer, out } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    'prints "SSL is *NOT* being enforced." when database=true but appliedSuccessfully=false',
    () => {
      const { layer, out } = setup({ response: SSL_DESIRED_BUT_NOT_APPLIED });
      return Effect.gen(function* () {
        yield* legacySslEnforcementGet({ projectRef: Option.none() });
        expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("emits Go-compatible env output for --output env (exact bytes)", () => {
    const { layer, out } = setup({ goOutput: "env", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe('APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible indented JSON for --output json (exact bytes)", () => {
    const { layer, out } = setup({ goOutput: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        `{
  "appliedSuccessfully": true,
  "currentConfig": {
    "database": true
  }
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("appliedSuccessfully: true");
      expect(out.stdoutText).toContain("database: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("appliedSuccessfully = true");
      expect(out.stdoutText).toContain("[currentConfig]");
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        currentConfig: { database: true },
        appliedSuccessfully: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ currentConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.live("--output (Go) wins over --output-format (TS) when both provided", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("appliedSuccessfully: true");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the getSslEnforcementConfig URL", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/ssl-enforcement`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    // This test owns its own workdir because it writes a project-ref file
    // before the layer is constructed (the resolver reads from
    // <workdir>/supabase/.temp/project-ref on layer-effect resolution).
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-fileref-"));
    const fileRef = "filerefabcdefghijklm";
    mkdirSync(join(localTempRoot, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(localTempRoot, "supabase", ".temp", "project-ref"), fileRef);

    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.some("BADREF") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementGetUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySslEnforcementGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementGetUnexpectedStatusError");
        expect(errorJson).toContain("unexpected SSL enforcement status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementGetNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySslEnforcementGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementGetNetworkError");
        expect(errorJson).toContain("failed to retrieve SSL enforcement config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // PersistentPostRun parity — telemetry + linked-project cache scoping
  // -------------------------------------------------------------------------

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });
    return Effect.gen(function* () {
      yield* legacySslEnforcementGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when ref resolution fails (no cache write)", () => {
    // Pre-PersistentPostRun-fix regression guard: telemetry must flush whether or not the
    // resolver succeeds. The linked-project cache only writes after a ref is resolved.
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-get-int-postrun-"));
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });
});
