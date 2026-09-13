import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect";

import { mockOutput, mockRuntimeInfo, processEnvLayer } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";
import { secretsSet } from "./set.handler.ts";

function mockDebugLoggerTracked() {
  const messages: Array<string> = [];
  return {
    messages,
    layer: Layer.succeed(DebugLogger, {
      debug: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }),
      http: () => Effect.void,
    }),
  };
}

function permissionDeniedReadLayer(target: string) {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) =>
      FileSystem.FileSystem.of({
        ...real,
        readFileString: (path, encoding) =>
          path === target
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : real.readFileString(path, encoding),
      }),
    ),
  ).pipe(Layer.provide(BunServices.layer));
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "pretty" | "json" | "yaml" | "toml" | "env";
  status?: number;
  network?: "fail";
  env?: Record<string, string | undefined>;
}

const tempRoot = useTempWorkdir("supabase-secrets-set-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    // POST `/v1/projects/{ref}/secrets` returns 201 with no body on success.
    response: { status: opts.status ?? 201, body: null },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const debugLogger = mockDebugLoggerTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
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

function writeSupabaseDotEnv(content: string) {
  mkdirSync(join(tempRoot.current, "supabase"), { recursive: true });
  writeFileSync(join(tempRoot.current, "supabase", ".env"), content);
}

function parsePostBody(body: unknown): Array<{ name: string; value: string }> {
  return body as Array<{ name: string; value: string }>;
}

describe("secrets set integration", () => {
  it.live("sets a single secret via CLI arg FOO=bar", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* secretsSet({
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
      yield* secretsSet({
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

  it.live("batches large secret sets into requests of at most 100", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* secretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: Array.from({ length: 150 }, (_, i) => `KEY${i}=value${i}`),
      });
      expect(api.requests).toHaveLength(2);
      const first = parsePostBody(api.requests[0]!.body);
      const second = parsePostBody(api.requests[1]!.body);
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(50);
      const names = new Set([...first, ...second].map((entry) => entry.name));
      for (let i = 0; i < 150; i++) {
        expect(names.has(`KEY${i}`)).toBe(true);
      }
      expect(out.stdoutText).toContain("Finished supabase secrets set.");
    }).pipe(Effect.provide(layer));
  });

  it.live("batches 250 secrets into three requests (100/100/50)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* secretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: Array.from({ length: 250 }, (_, i) => `KEY${i}=value${i}`),
      });
      expect(api.requests).toHaveLength(3);
      expect(parsePostBody(api.requests[0]!.body)).toHaveLength(100);
      expect(parsePostBody(api.requests[1]!.body)).toHaveLength(100);
      expect(parsePostBody(api.requests[2]!.body)).toHaveLength(50);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects the whole upload when a later batch has an invalid entry (no partial update)",
    () => {
      const { layer, api } = setup();
      // Index 120 lands in the second batch (batch 0 covers indices 0-99): a value exceeding
      // the 24576-byte cap there must fail up-front validation before batch 0 (otherwise
      // entirely valid) is ever sent.
      const secrets = Array.from({ length: 150 }, (_, i) =>
        i === 120 ? `KEY${i}=${"x".repeat(24577)}` : `KEY${i}=value${i}`,
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          secretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("SecretsSetInputError");
          const classified = classifyCliCauseActionability(exit.cause);
          expect(classified.error_kind).toBe("user_actionable");
          expect(classified.error_category).toBe("invalid_input");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("sets secrets from --env-file with a relative path (joined to CWD)", () => {
    writeFileSync(join(tempRoot.current, "myfile.env"), "FROM_FILE=fromvalue\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* secretsSet({
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
      yield* secretsSet({
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
      yield* secretsSet({
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
        yield* secretsSet({
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
      yield* secretsSet({
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
      yield* secretsSet({
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
    "skips an empty [edge_runtime.secrets] value instead of overwriting a remote secret (Go set.go:48-52 parity)",
    () => {
      // An empty `EMPTY = ""` value in config.toml is never sent, which prevents it from
      // silently overwriting a same-named remote secret with an empty string.
      writeConfig(
        `[edge_runtime.secrets]
EMPTY = ""
NON_EMPTY = "config-value"
`,
      );
      const { layer, api } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "NON_EMPTY", value: "config-value" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

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
        yield* secretsSet({
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
      yield* secretsSet({
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
    "fails with SecretsNoArgumentsError when args and env-file produce zero non-SUPABASE_ entries",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          secretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: ["SUPABASE_ONLY=x"],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("SecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with InvalidSecretPairError when an arg has no `=`", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["NOTAPAIR"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("InvalidSecretPairError");
        expect(errJson).toContain("Invalid secret pair: NOTAPAIR");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with SecretsEnvFileOpenError when env-file does not exist", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        secretsSet({
          projectRef: Option.none(),
          envFile: Option.some("does-not-exist.env"),
          secrets: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("SecretsEnvFileOpenError");
        expect(errJson).toContain("failed to open env file");
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_category: "invalid_input",
          suggestion_type: "provide_flags",
          error_fingerprint: "tag:SecretsEnvFileOpenError:not_found",
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("classifies an unreadable env file as a permission failure", () => {
    const envPath = join(tempRoot.current, "private.env");
    const { layer: baseLayer, api } = setup();
    const layer = Layer.mergeAll(baseLayer, permissionDeniedReadLayer(envPath));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        secretsSet({
          projectRef: Option.none(),
          envFile: Option.some(envPath),
          secrets: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_kind: "user_actionable",
          error_category: "permission",
          suggestion_type: "none",
          error_fingerprint: "tag:SecretsEnvFileOpenError:filesystem",
        });
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "tolerates a malformed config.toml, logs it to the debug logger, and still sets CLI-arg secrets",
    () => {
      writeConfig("this is not valid = = toml [[[\n");
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
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
      // Valid TOML throughout, but `analytics.port` has the wrong type. The CLI's established
      // per-field decode tolerance means an unrelated type error doesn't stop
      // `edge_runtime.secrets` from being read; Effect Schema's `decodeUnknownSync` is atomic
      // and would otherwise discard the whole document, silently dropping `FROM_CONFIG` too.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"

[analytics]
port = "not-a-number"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
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
    "recovers [edge_runtime.secrets] when a sibling field in the same edge_runtime table fails schema decode (CLI-1867 Go parity)",
    () => {
      // Valid TOML throughout, but `edge_runtime.inspector_port` (a sibling of `secrets` in
      // the same table, not an unrelated top-level table) has the wrong type. The recovery
      // must re-decode `secrets` on its own rather than the whole `edge_runtime` subtree, or
      // the sibling error would take `FROM_CONFIG` down with it.
      writeConfig(
        `[edge_runtime]
inspector_port = "not-a-number"

[edge_runtime.secrets]
FROM_CONFIG = "config-value"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
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
    "tolerates a malformed supabase/.env, logs it to the debug logger, and still sets CLI-arg secrets (CLI-1867 Go parity)",
    () => {
      // `loadCliConfig` resolves `env(VAR)` references against `.env`/`.env.local` before
      // schema decode, so a malformed dotenv line fails with `CliProjectEnvParseError` rather
      // than `CliConfigParseError`, and this must not abort the command either. `.env` is only
      // read once a config.toml/.json is found, so one must exist here too.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"
`,
      );
      writeSupabaseDotEnv("THIS IS NOT A VALID DOTENV LINE\n");
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(api.requests).toHaveLength(1);
        expect(parsePostBody(api.requests[0]?.body)).toEqual([{ name: "FOO", value: "bar" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "recovers valid [edge_runtime.secrets] entries when a sibling entry in the same map fails schema decode (CLI-1867 Go parity)",
    () => {
      // `GOOD` is a valid secret value; `BAD` is a non-string TOML value for a field whose
      // schema expects a string-like secret. The recovery decodes each `edge_runtime.secrets`
      // entry independently, so `GOOD` still lands even with `BAD` present — Effect Schema's
      // `decodeUnknownSync` is atomic per record and would otherwise discard `GOOD` too.
      writeConfig(
        `[edge_runtime.secrets]
GOOD = "config-value"
BAD = 123
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        const body = parsePostBody(api.requests[0]?.body);
        expect(body).toEqual([{ name: "GOOD", value: "config-value" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse supabase/config.toml");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "skips an empty recovered [edge_runtime.secrets] entry alongside an unrelated schema error (Go set.go:48-52 parity)",
    () => {
      // Same empty-value skip as the happy path, exercised through the recovery path instead:
      // `EMPTY` decodes fine on its own, so it must be dropped downstream in the same merge
      // loop the happy path uses, not resurrected as a false "recoverable" entry.
      writeConfig(
        `[edge_runtime.secrets]
EMPTY = ""
GOOD = "config-value"

[analytics]
port = "not-a-number"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "GOOD", value: "config-value" },
        ]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse supabase/config.toml");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "does not fabricate a secret named 0 when [edge_runtime.secrets] is an array (CLI-1867 Go parity)",
    () => {
      // `edge_runtime.secrets` as an array (instead of a table) is not recoverable: the whole
      // field is left empty rather than being misread as `{ "0": "actual-secret" }` via
      // `Object.entries`.
      writeConfig(
        `[analytics]
port = "not-a-number"

[edge_runtime]
secrets = ["actual-secret"]
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        const body = parsePostBody(api.requests[0]?.body);
        expect(body).toEqual([{ name: "FOO", value: "bar" }]);
        expect(body.find((entry) => entry.name === "0")).toBeUndefined();
        expect(debugLogger.messages).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "recovers the selected remote's [edge_runtime.secrets] override, not the base, on schema-decode error (CLI-1867 Go parity)",
    () => {
      // `analytics.port` triggers the recovery path. `remotes.staging.project_id` matches the
      // resolved ref, so the remote override is merged before the tolerant decode — the
      // recovered secret must reflect the remote's override value, not the base document's.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "base-value"

[analytics]
port = "not-a-number"

[remotes.staging]
project_id = "${VALID_REF}"

[remotes.staging.edge_runtime.secrets]
FROM_CONFIG = "remote-value"
`,
      );
      const { layer, out, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "FROM_CONFIG", value: "remote-value" },
        ]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("failed to parse supabase/config.toml");
        // The override notice is owed here too, even though the decode that follows fails
        // and recovers.
        expect(out.stderrText).toContain("Loading config override: [remotes.staging]\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "prints the remote override notice to stderr when [remotes.*] matches the resolved ref (Go parity: pkg/config/config.go:605)",
    () => {
      // No decode error here — the plain success path. The override notice still prints
      // unconditionally whenever a `[remotes.*]` block's `project_id` matches the resolved
      // ref. `mockCommandSettings` defaults that ref to `VALID_REF`.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "base-value"

[remotes.staging]
project_id = "${VALID_REF}"

[remotes.staging.edge_runtime.secrets]
FROM_CONFIG = "remote-value"
`,
      );
      const { layer, out, api } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "FROM_CONFIG", value: "remote-value" },
        ]);
        expect(out.stderrText).toContain("Loading config override: [remotes.staging]\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "does not print a remote override notice when no [remotes.*] block matches the resolved ref",
    () => {
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"
`,
      );
      const { layer, out, api } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([
          { name: "FROM_CONFIG", value: "config-value" },
        ]);
        expect(out.stderrText).not.toContain("Loading config override");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "tolerates two [remotes.*] blocks sharing the target project_id, logs it, and still sets CLI-arg secrets (CLI-1867 Go parity)",
    () => {
      // Swallowed non-fatally like every other load error here. There's no parsed document to
      // recover a subtree from, so config-sourced secrets are dropped entirely — only
      // CLI-arg secrets survive.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"

[remotes.a]
project_id = "dupe-project-id"

[remotes.b]
project_id = "dupe-project-id"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([{ name: "FOO", value: "bar" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("duplicate project_id for [remotes.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "tolerates a [remotes.*] block with a malformed project_id and still sets CLI-arg secrets (Go parity)",
    () => {
      // Swallowed non-fatally like every other load error here. There's no parsed document to
      // recover a subtree from, so config-sourced secrets are dropped entirely — only
      // CLI-arg secrets survive.
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"

[remotes.a]
project_id = "not-a-valid-ref"
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([{ name: "FOO", value: "bar" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).toContain("Invalid config for remotes.a.project_id");
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
        yield* secretsSet({
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
    "does not echo a literal secret value from config.toml into the debug log on a schema-decode error",
    () => {
      // Unlike the syntax-error case above, a schema-decode failure has no separator to
      // truncate: the rejected value appears inline on one line. The bad entry sits inside
      // `[edge_runtime.secrets]` itself, so this also exercises the per-entry recovery path —
      // `PLANTED_SECRET` is dropped, but the CLI-arg secret still goes through.
      writeConfig(
        `[edge_runtime.secrets]
PLANTED_SECRET = ["sk_live_TOTALLY_REAL_SECRET_VALUE"]
`,
      );
      const { layer, api, debugLogger } = setup();
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        expect(parsePostBody(api.requests[0]?.body)).toEqual([{ name: "FOO", value: "bar" }]);
        expect(debugLogger.messages).toHaveLength(1);
        expect(debugLogger.messages[0]).not.toContain("PLANTED_SECRET");
        expect(debugLogger.messages[0]).not.toContain("sk_live_TOTALLY_REAL_SECRET_VALUE");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "still fails with SecretsNoArgumentsError when a malformed config leaves zero secret sources",
    () => {
      writeConfig("this is not valid = = toml [[[\n");
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          secretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: [],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("SecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with SecretsSetNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("SecretsSetNetworkError");
        expect(errJson).toContain("failed to set secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with SecretsSetUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("SecretsSetUnexpectedStatusError");
        expect(errJson).toContain("Unexpected error setting project secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { project_ref, count } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* secretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "BAZ=qux"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({ project_ref: VALID_REF, count: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "text mode prints `Finished supabase secrets set.\\n` regardless of --output value",
    () => {
      const { layer, out } = setup({ goOutput: "json" });
      return Effect.gen(function* () {
        yield* secretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        // `--output` doesn't affect `set`; the text-mode message lands regardless.
        expect(out.stdoutText).toBe("Finished supabase secrets set.\n");
      }).pipe(Effect.provide(layer));
    },
  );
});
