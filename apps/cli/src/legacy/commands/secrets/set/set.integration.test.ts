import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import {
  mockOutput,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacySecretsSet } from "./set.handler.ts";

function mockLegacyDebugLoggerTracked() {
  const messages: Array<string> = [];
  return {
    messages,
    layer: Layer.succeed(LegacyDebugLogger, {
      debug: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }),
      http: () => Effect.void,
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "pretty" | "json" | "yaml" | "toml" | "env";
  status?: number;
  network?: "fail";
  env?: Record<string, string | undefined>;
}

const tempRoot = useLegacyTempWorkdir("supabase-secrets-set-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    // POST `/v1/projects/{ref}/secrets` returns 201 with no body on success.
    response: { status: opts.status ?? 201, body: null },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const debugLogger = mockLegacyDebugLoggerTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    mockRuntimeInfo({ cwd: tempRoot.current }),
    processEnvLayer(opts.env ?? {}),
    debugLogger.layer,
  );
  return { layer, out, api, debugLogger };
}

function writeConfig(content: string) {
  mkdirSync(join(tempRoot.current, "supabase"), { recursive: true });
  writeFileSync(join(tempRoot.current, "supabase", "config.toml"), content);
}

function parsePostBody(body: unknown): Array<{ name: string; value: string }> {
  // `mockLegacyPlatformApi` JSON-decodes the request body when it parses; this
  // helper just narrows the type for the test assertions.
  return body as Array<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets set integration", () => {
  it.live("sets a single secret via CLI arg FOO=bar", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar"],
      });
      expect(api.requests).toHaveLength(1);
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "FOO", value: "bar" }]);
      expect(out.stdoutText).toBe("Finished supabase secrets set.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("sets multiple secrets via CLI args", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "BAZ=qux"],
      });
      const body = parsePostBody(api.requests[0]!.body);
      expect(body).toEqual(
        expect.arrayContaining([
          { name: "FOO", value: "bar" },
          { name: "BAZ", value: "qux" },
        ]),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("sets secrets from --env-file with a relative path (joined to CWD)", () => {
    writeFileSync(join(tempRoot.current, "myfile.env"), "FROM_FILE=fromvalue\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some("myfile.env"),
        secrets: [],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([
        { name: "FROM_FILE", value: "fromvalue" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("sets secrets from --env-file with an absolute path", () => {
    const abs = join(tempRoot.current, "absolute.env");
    writeFileSync(abs, "ABS=value\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some(abs),
        secrets: [],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "ABS", value: "value" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("CLI args override --env-file entries for the same key", () => {
    writeFileSync(join(tempRoot.current, "override.env"), "FOO=from-file\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some("override.env"),
        secrets: ["FOO=from-arg"],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "FOO", value: "from-arg" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "merges entries from supabase/config.toml [edge_runtime.secrets] ahead of env-file and CLI args",
    () => {
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"
SHARED = "config-shared"
`,
      );
      writeFileSync(join(tempRoot.current, ".env-file"), "SHARED=envfile-shared\n");
      const { layer, api } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.some(".env-file"),
          secrets: ["SHARED=cli-shared"],
        });
        const body = parsePostBody(api.requests[0]!.body);
        expect(body).toEqual(
          expect.arrayContaining([
            { name: "FROM_CONFIG", value: "config-value" },
            { name: "SHARED", value: "cli-shared" },
          ]),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("interpolates env(VAR) in config.toml secrets when the env var is defined", () => {
    writeConfig(
      `[edge_runtime.secrets]
DB_URL = "env(MY_DB_URL)"
`,
    );
    const { layer, api } = setup({ env: { MY_DB_URL: "postgres://x" } });
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: [],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([
        { name: "DB_URL", value: "postgres://x" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("skips secrets whose env() reference cannot be resolved (Go set.go:48-52 parity)", () => {
    writeConfig(
      `[edge_runtime.secrets]
RESOLVED = "env(MY_DB_URL)"
UNRESOLVED = "env(NOT_SET_ANYWHERE)"
LITERAL = "plain-value"
`,
    );
    const { layer, api } = setup({ env: { MY_DB_URL: "postgres://x" } });
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: [],
      });
      const body = parsePostBody(api.requests[0]!.body);
      expect(body).toEqual(
        expect.arrayContaining([
          { name: "RESOLVED", value: "postgres://x" },
          { name: "LITERAL", value: "plain-value" },
        ]),
      );
      expect(body.find((entry) => entry.name === "UNRESOLVED")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not crash when config.toml has env(NUMERIC_PORT) on an unrelated numeric field (CLI-1489 regression guard)",
    () => {
      writeConfig(
        `[analytics]
port = "env(SUPABASE_ANALYTICS_PORT)"

[edge_runtime.secrets]
FOO = "literal-foo"
`,
      );
      const { layer, api } = setup({ env: { SUPABASE_ANALYTICS_PORT: "54327" } });
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]!.body)).toEqual([
          { name: "FOO", value: "literal-foo" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("skips SUPABASE_-prefixed entries with a stderr warning", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "SUPABASE_BAD=x"],
      });
      const body = parsePostBody(api.requests[0]!.body);
      expect(body).toEqual([{ name: "FOO", value: "bar" }]);
      expect(out.stderrText).toContain(
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_BAD",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails with LegacySecretsNoArgumentsError when args and env-file produce zero non-SUPABASE_ entries",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: ["SUPABASE_ONLY=x"],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with LegacyInvalidSecretPairError when an arg has no `=`", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["NOTAPAIR"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyInvalidSecretPairError");
        expect(errJson).toContain("Invalid secret pair: NOTAPAIR");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsEnvFileOpenError when env-file does not exist", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.some("does-not-exist.env"),
          secrets: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsEnvFileOpenError");
        expect(errJson).toContain("failed to open env file");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "tolerates a malformed config.toml, logs it to the debug logger, and still sets CLI-arg secrets",
    () => {
      writeConfig("this is not valid = = toml [[[\n");
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(api.requests).toHaveLength(1);
        expect(parsePostBody(api.requests[0]?.body)).toEqual([{ name: "FOO", value: "bar" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse supabase/config.toml");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "recovers [edge_runtime.secrets] when an unrelated field fails schema decode (CLI-1867 Go parity)",
    () => {
      // Valid TOML syntax throughout, but `analytics.port` has the wrong type
      // for its schema field. Go's viper+mapstructure decode
      // (`pkg/config/config.go:749`) mutates the target struct field-by-field,
      // so an unrelated type error doesn't stop `EdgeRuntime.Secrets` from
      // landing on `utils.Config` — `secrets set` still reads it. Effect
      // Schema's `decodeUnknownSync` is atomic and would otherwise discard the
      // whole document, silently dropping `FROM_CONFIG` too.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"

[analytics]
port = "not-a-number"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "FROM_CONFIG", value: "config-value" },
        ]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse supabase/config.toml");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "does not echo a literal secret value from config.toml into the debug log on a syntax error",
    () => {
      // `smol-toml`'s `TomlError` embeds a source codeblock (the offending line ±1)
      // in its message; the planted secret sits directly above the syntax error so
      // it would land inside that codeblock if the handler logged the raw message.
      writeConfig(
        [
          "[edge_runtime.secrets]",
          'PLANTED_SECRET = "sk_live_TOTALLY_REAL_SECRET_VALUE"',
          "BROKEN = = invalid[[[",
        ].join("\n"),
      );
      const { layer, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).not.toContain("PLANTED_SECRET");
        expect(debugLogger.messages[0]).not.toContain("sk_live_TOTALLY_REAL_SECRET_VALUE");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "still fails with LegacySecretsNoArgumentsError when a malformed config leaves zero secret sources",
    () => {
      writeConfig("this is not valid = = toml [[[\n");
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: [],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with LegacySecretsSetNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsSetNetworkError");
        expect(errJson).toContain("failed to set secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsSetUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsSetUnexpectedStatusError");
        expect(errJson).toContain("Unexpected error setting project secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { project_ref, count } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "BAZ=qux"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({ project_ref: LEGACY_VALID_REF, count: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "text mode prints `Finished supabase secrets set.\\n` regardless of --output value",
    () => {
      const { layer, out } = setup({ goOutput: "json" });
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        // Go ignores `--output` for `set` (set.go:42) — text-mode message lands regardless.
        expect(out.stdoutText).toBe("Finished supabase secrets set.\n");
      }).pipe(Effect.provide(layer));
    },
  );
});
