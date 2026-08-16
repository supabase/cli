import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect";

import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { classifyCliCauseActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { legacySecretsSet } from "./set.handler.ts";

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
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    mockRuntimeInfo({ cwd: tempRoot.current }),
  );
  return { layer, out, api };
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

  it.live("batches large secret sets into requests of at most 100", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
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
      yield* legacySecretsSet({
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
      // Index 120 lands in the SECOND batch (batch 0 covers indices 0-99): a
      // value exceeding the 24576-byte cap there must fail up-front validation
      // before batch 0 (which is otherwise entirely valid) is ever sent.
      const secrets = Array.from({ length: 150 }, (_, i) =>
        i === 120 ? `KEY${i}=${"x".repeat(24577)}` : `KEY${i}=value${i}`,
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySecretsSetInputError");
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
    "ignores [edge_runtime.secrets] in config.toml — only explicit args are uploaded (supabase/supabase#45242)",
    () => {
      // The Go CLI seeded every upload with `[edge_runtime.secrets]`, so
      // `secrets set BAR=bar` silently pushed the unrelated `FOO` too. Config
      // secrets are a local-dev input (`functions serve`); remote uploads are
      // explicit-input only.
      writeConfig(
        `[edge_runtime.secrets]
FOO = "foo"
`,
      );
      const { layer, api } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["BAR=bar"],
        });
        expect(api.requests).toHaveLength(1);
        expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "BAR", value: "bar" }]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "ignores config.toml secrets when uploading from --env-file and args together (supabase/supabase#45242)",
    () => {
      writeConfig(
        `[edge_runtime.secrets]
FROM_CONFIG = "config-value"

[remotes.staging]
project_id = "${LEGACY_VALID_REF}"

[remotes.staging.edge_runtime.secrets]
FROM_CONFIG = "remote-value"
`,
      );
      writeFileSync(join(tempRoot.current, ".env-file"), "FROM_FILE=file-value\n");
      const { layer, out, api } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.some(".env-file"),
          secrets: ["FROM_ARG=arg-value"],
        });
        const body = parsePostBody(api.requests[0]!.body);
        expect(body).toEqual(
          expect.arrayContaining([
            { name: "FROM_FILE", value: "file-value" },
            { name: "FROM_ARG", value: "arg-value" },
          ]),
        );
        expect(body.find((entry) => entry.name === "FROM_CONFIG")).toBeUndefined();
        // Config is never loaded, so no `[remotes.*]` override notice either.
        expect(out.stderrText).not.toContain("Loading config override");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fails with LegacySecretsNoArgumentsError on a bare invocation even when config.toml declares [edge_runtime.secrets]",
    () => {
      // Pins the intentional behavior change: a bare `secrets set` no longer
      // implicitly uploads config-declared secrets.
      writeConfig(
        `[edge_runtime.secrets]
FOO = "foo"
`,
      );
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
          const errJson = JSON.stringify(exit.cause);
          expect(errJson).toContain("LegacySecretsNoArgumentsError");
          expect(errJson).toContain("No arguments found. Use --env-file to read from a .env file.");
        }
        expect(api.requests).toHaveLength(0);
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
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_category: "invalid_input",
          suggestion_type: "provide_flags",
          error_fingerprint: "tag:LegacySecretsEnvFileOpenError:not_found",
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
        legacySecretsSet({
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
          error_fingerprint: "tag:LegacySecretsEnvFileOpenError:filesystem",
        });
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

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
