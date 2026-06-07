import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1GetSslEnforcementConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
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
import { legacySslEnforcementUpdate } from "./update.handler.ts";

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
}

const tempRoot = useLegacyTempWorkdir("supabase-ssl-enforcement-update-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SSL_ENFORCED },
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
    response: { status: opts.status ?? 200, body: opts.response ?? SSL_ENFORCED },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy ssl-enforcement update integration", () => {
  // -------------------------------------------------------------------------
  // Flag validation
  // -------------------------------------------------------------------------

  it.live(
    "fails with LegacySslEnforcementNoEnableDisableFlagError when neither flag is set",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySslEnforcementUpdate({
            projectRef: Option.none(),
            enableDbSslEnforcement: false,
            disableDbSslEnforcement: false,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("LegacySslEnforcementNoEnableDisableFlagError");
          expect(errorJson).toContain("enable/disable not specified");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fails with LegacySslEnforcementMutuallyExclusiveFlagsError when both flags are set",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySslEnforcementUpdate({
            projectRef: Option.none(),
            enableDbSslEnforcement: true,
            disableDbSslEnforcement: true,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("LegacySslEnforcementMutuallyExclusiveFlagsError");
          expect(errorJson).toContain(
            "if any flags in the group [enable-db-ssl-enforcement disable-db-ssl-enforcement] are set",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not call the API when flag validation fails", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes telemetry but NOT linked-project cache when validation fails", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Request body
  // -------------------------------------------------------------------------

  it.live("sends requestedConfig.database = true when --enable-db-ssl-enforcement is set", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toMatchObject({
        requestedConfig: { database: true },
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends requestedConfig.database = false when --disable-db-ssl-enforcement is set", () => {
    const { layer, api } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: false,
        disableDbSslEnforcement: true,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toMatchObject({
        requestedConfig: { database: false },
      });
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Text output modes (mirroring get scenarios with enable flag)
  // -------------------------------------------------------------------------

  it.live('prints "SSL is being enforced." when database=true and appliedSuccessfully=true', () => {
    const { layer, out } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live('prints "SSL is *NOT* being enforced." when database=false', () => {
    const { layer, out } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: false,
        disableDbSslEnforcement: true,
      });
      expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    'prints "SSL is *NOT* being enforced." when database=true but appliedSuccessfully=false',
    () => {
      const { layer, out } = setup({ response: SSL_DESIRED_BUT_NOT_APPLIED });
      return Effect.gen(function* () {
        yield* legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        });
        expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  // -------------------------------------------------------------------------
  // Go output encoders
  // -------------------------------------------------------------------------

  it.live("emits Go-compatible env output for --output env (exact bytes)", () => {
    const { layer, out } = setup({ goOutput: "env", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe('APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible indented JSON for --output json (exact bytes)", () => {
    const { layer, out } = setup({ goOutput: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("appliedSuccessfully: true");
      expect(out.stdoutText).toContain("database: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("appliedSuccessfully = true");
      expect(out.stdoutText).toContain("[currentConfig]");
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // TS output-format modes
  // -------------------------------------------------------------------------

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ currentConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.live("--output (Go) wins over --output-format (TS) when both provided", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("appliedSuccessfully: true");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Project ref resolution
  // -------------------------------------------------------------------------

  it.live("passes the resolved project ref into the updateSslEnforcementConfig URL", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/ssl-enforcement`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.some(flagRef),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-update-int-fileref-"));
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
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-ssl-update-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }).pipe(Effect.provide(layer)),
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
        legacySslEnforcementUpdate({
          projectRef: Option.some("BADREF"),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it.live("fails with LegacySslEnforcementUpdateUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementUpdateUnexpectedStatusError");
        expect(errorJson).toContain("unexpected update SSL status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySslEnforcementUpdateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySslEnforcementUpdate({
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacySslEnforcementUpdateNetworkError");
        expect(errorJson).toContain("failed to update ssl enforcement");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* legacySslEnforcementUpdate({
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
