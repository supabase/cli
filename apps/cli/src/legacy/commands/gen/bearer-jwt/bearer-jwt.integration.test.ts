import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Option, Path, Schema } from "effect";
import * as Formatter from "effect/Formatter";
import { CliOutput, Command } from "effect/unstable/cli";
import { importJWK, jwtVerify } from "jose";

import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../../../shared/telemetry/identity.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../../shared/legacy/global-flags.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyGenBearerJwtCommand } from "./bearer-jwt.command.ts";
import type { LegacyGenBearerJwtFlags } from "./bearer-jwt.command.ts";
import { legacyGenBearerJwt } from "./bearer-jwt.handler.ts";
import { makeLegacyViperEnvLayer } from "../../../../shared/legacy/legacy-viper-env.ts";

const tempRoot = useLegacyTempWorkdir("supabase-gen-bearer-jwt-int-");

const LEGACY_DEFAULT_SIGNING_KEY_PUBLIC = {
  kty: "EC",
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
};

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const testPath = ManagedRuntime.make(BunServices.layer).runSync(Path.Path);

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyGenBearerJwtCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

function generateEcJwk(kid: string): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kty: "EC", alg: "ES256", kid };
}

function generateRsaJwk(kid: string) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kty: "RSA", alg: "RS256", kid };
}

function publicJwkOf(jwk: Record<string, unknown>): Record<string, unknown> {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = jwk;
  return publicJwk;
}

interface SetupOptions {
  readonly stdinIsTty?: boolean;
  readonly pipedAnswer?: string;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly trackTelemetry?: boolean;
  /** Overrides `cliConfig.workdir` — defaults to `tempRoot.current`. */
  readonly workdir?: string;
}

function setup(options: SetupOptions = {}) {
  const out = mockOutput({
    format: "text",
    interactive: options.stdinIsTty ?? false,
    promptSelectResponses: options.promptSelectResponses,
  });
  const api = mockLegacyPlatformApi();
  const cliConfig = mockLegacyCliConfig({
    workdir: options.workdir ?? tempRoot.current,
    projectId: Option.none(),
  });
  const tty = mockTty({
    stdinIsTty: options.stdinIsTty ?? false,
    stdoutIsTty: options.stdinIsTty ?? false,
  });
  const telemetry = options.trackTelemetry ? mockLegacyTelemetryStateTracked() : undefined;
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({ out, api, cliConfig, tty, telemetry: telemetry?.layer }),
    Layer.succeed(CliArgs, { args: [] }),
    mockStdin(options.stdinIsTty ?? false, options.pipedAnswer),
    Layer.succeed(LegacyDebugLogger, { debug: () => Effect.void, http: () => Effect.void }),
  );
  return { layer, out, telemetry };
}

function writeFixture(relativePath: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = testPath.join(tempRoot.current, "supabase");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(testPath.join(directory, relativePath), contents);
  });
}

function writeConfig(contents: string) {
  return writeFixture("config.toml", contents);
}

function writeSigningKeys(contents: string) {
  return writeFixture("signing_keys.json", contents);
}

/**
 * Writes `supabase/.env.development` — a file the dotenv cascade reads
 * (selected by `SUPABASE_ENV`, defaulting to `"development"`) but
 * `@supabase/config`'s OWN default env resolution does NOT
 * (`legacyResolveSigningKeysConfigPaths` must resolve an accurate
 * `ProjectEnvironment` and thread it through explicitly).
 */
function writeSupabaseEnvDevelopment(contents: string) {
  return writeFixture(".env.development", contents);
}

const baseFlags: LegacyGenBearerJwtFlags = {
  role: Option.some("anon"),
  sub: Option.none(),
  exp: Option.none(),
  validFor: 1800,
  payload: "{}",
};

function decodeSegment(segment: string): unknown {
  return decodeJson(Buffer.from(segment, "base64url").toString("utf8"));
}

function tokenFrom(out: { stdoutText: string }): string {
  return out.stdoutText.trimEnd();
}

describe("legacy gen bearer-jwt integration", () => {
  it.live("mints a token with the built-in default ES256 key when no config exists", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt(baseFlags);

      // Go: `fmt.Fprintln(w, token)` — the token, then exactly one trailing newline,
      // nothing else on stdout.
      expect(out.stdoutText.endsWith("\n")).toBe(true);
      expect(out.stdoutText.indexOf("\n")).toBe(out.stdoutText.length - 1);

      const token = tokenFrom(out);
      const [header, payload] = token.split(".");
      expect(decodeSegment(header ?? "")).toEqual({
        alg: "ES256",
        kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
        typ: "JWT",
      });
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["role"]).toBe("anon");
      expect(typeof claims["exp"]).toBe("number");
      expect(typeof claims["iat"]).toBe("number");
      expect((claims["exp"] as number) - (claims["iat"] as number)).toBe(1800);

      const publicKey = yield* Effect.promise(() =>
        importJWK(LEGACY_DEFAULT_SIGNING_KEY_PUBLIC, "ES256"),
      );
      const verified = yield* Effect.promise(() => jwtVerify(token, publicKey));
      expect(verified.payload).toMatchObject({ role: "anon" });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "mints a token with the default key when config.toml exists but signing_keys_path is not set",
    () => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig("[auth]\nenabled = true\n");

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("sets is_anonymous when role is authenticated and --sub is not given", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({ ...baseFlags, role: Option.some("authenticated") });
      const [, payload] = tokenFrom(out).split(".");
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["is_anonymous"]).toBe(true);
      expect("sub" in claims).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not set is_anonymous when role is authenticated and --sub is given", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({
        ...baseFlags,
        role: Option.some("authenticated"),
        sub: Option.some("user-1"),
      });
      const [, payload] = tokenFrom(out).split(".");
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["is_anonymous"]).toBeUndefined();
      expect(claims["sub"]).toBe("user-1");
    }).pipe(Effect.provide(layer));
  });

  it.live("computes exp from an explicit --exp, with iat = exp - validFor", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({
        ...baseFlags,
        exp: Option.some({ wholeSeconds: 2_000_000_000, nanos: 0 }),
      });
      const [, payload] = tokenFrom(out).split(".");
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["exp"]).toBe(2_000_000_000);
      expect(claims["iat"]).toBe(2_000_000_000 - 1800);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "computes iat with a sub-second --valid-for, truncating only the final timestamp (CLI-1961)",
    () => {
      // Verified against the real binary: `--exp 2030-01-01T00:00:00Z --valid-for 1.5s`
      // (unix 1893456000) yields Go `iat=1893455998` — flooring the 1.5s duration to 1s
      // BEFORE subtracting (this port's previous behavior) would wrongly yield
      // 1893455999.
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* legacyGenBearerJwt({
          ...baseFlags,
          exp: Option.some({ wholeSeconds: 1_893_456_000, nanos: 0 }),
          validFor: 1.5,
        });
        const [, payload] = tokenFrom(out).split(".");
        const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
        expect(claims["exp"]).toBe(1_893_456_000);
        expect(claims["iat"]).toBe(1_893_455_998);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("merges --payload on top of the computed claims", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({
        ...baseFlags,
        role: Option.some("postgres"),
        payload: '{"role":"override","sb-role":"mgmt-api"}',
      });
      const [, payload] = tokenFrom(out).split(".");
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["role"]).toBe("override");
      expect(claims["sb-role"]).toBe("mgmt-api");
    }).pipe(Effect.provide(layer));
  });

  // `--role` is required, but required-flag validation runs only AFTER the
  // telemetry context is installed. A missing `--role` still writes
  // `telemetry.json`, so the handler enforces the flag itself (after the telemetry-flushing
  // wrapper is already active) instead of relying on the framework's parse-time rejection.
  it.live(
    "fails with cobra's required-flag error, and still flushes telemetry, when --role is omitted",
    () => {
      const { layer, out, telemetry } = setup({ trackTelemetry: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt({ ...baseFlags, role: Option.none() }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtRoleRequiredError");
          expect(json).toContain('required flag(s) \\"role\\" not set');
        }
        expect(out.stdoutText).toBe("");
        expect(telemetry?.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "ignores an ancestor project's signing_keys_path when the resolved workdir has no config.toml of its own (CLI-1961)",
    () => {
      // Config resolution must resolve ONLY `<workdir>/supabase/config.toml`
      // — no ancestor climb (once `cliConfig.workdir` is already resolved,
      // matching an explicit `--workdir` pointing at a subdirectory below
      // another project's root — the workdir change does not climb when
      // `--workdir`/`SUPABASE_WORKDIR` is explicit either). Without
      // `{ tomlOnly: true, search: false }` in `gen.signing-keys-config.ts`,
      // the TS port picked up the PARENT directory's `signing_keys_path`
      // and prompted for a kid instead of falling back to the
      // unconfigured-default branch.
      const nestedWorkdir = testPath.join(tempRoot.current, "nested", "deeper");
      const { layer, out } = setup({ workdir: nestedWorkdir, pipedAnswer: "" });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(nestedWorkdir, { recursive: true });
        // `writeConfig`/`writeSigningKeys` target `tempRoot.current` — the ANCESTOR of
        // `nestedWorkdir` — never `nestedWorkdir` itself.
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([generateEcJwk("ec-kid")]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        // The unconfigured-default branch's prompt was answered blank, so this must be
        // the built-in default dev key, NOT the ancestor's `ec-kid`.
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          typ: "JWT",
        });
        expect(out.stderrText).toContain(
          "Enter your signing key in JWK format (or leave blank to use local default): ",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fails with Go's exact wrapping for a malformed --payload, before any signing-key prompt",
    () => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt({ ...baseFlags, payload: "not json" }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtPayloadError");
          expect(json).toContain("failed to parse payload:");
        }
        // No signing-key prompt should have been reached — the payload merge runs first.
        expect(out.stderrText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("Branch A: accepts a pasted RS256 JWK from stdin", () => {
    const jwk = generateRsaJwk("rsa-kid");
    const { layer, out } = setup({ pipedAnswer: encodeJson(jwk) });
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt(baseFlags);
      const token = tokenFrom(out);
      const [header] = token.split(".");
      expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });

      const publicKey = yield* Effect.promise(() => importJWK(publicJwkOf(jwk), "RS256"));
      const verified = yield* Effect.promise(() => jwtVerify(token, publicKey));
      expect(verified.payload).toMatchObject({ role: "anon" });
      expect(out.stderrText).toContain(
        "Enter your signing key in JWK format (or leave blank to use local default): ",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: on a real TTY, still prompts via stdin but does not echo the answer", () => {
    // Branch A ALWAYS uses plain `PromptText` regardless of TTY-ness — only
    // Branches B/C (a configured `signing_keys_path`) fork on interactivity. On a
    // real TTY the terminal's own line-editing already echoes what was typed, so
    // `legacyConsolePromptText` must not double-echo it itself.
    const jwk = generateEcJwk("ec-kid");
    const { layer, out } = setup({ stdinIsTty: true, pipedAnswer: encodeJson(jwk) });
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt(baseFlags);
      const token = tokenFrom(out);
      const [header] = token.split(".");
      expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", kid: "ec-kid", typ: "JWT" });
      expect(out.stderrText).toBe(
        "Enter your signing key in JWK format (or leave blank to use local default): ",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: rejects malformed JSON pasted at the stdin JWK prompt", () => {
    const { layer } = setup({ pipedAnswer: "not-json-at-all" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtKeyParseError");
        expect(json).toContain("failed to parse JWK:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: rejects a JSON array pasted at the stdin JWK prompt", () => {
    const { layer } = setup({ pipedAnswer: "[1,2,3]" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtKeyParseError");
        expect(json).toContain("cannot unmarshal array into Go value of type config.JWK");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: rejects a scalar number pasted at the stdin JWK prompt", () => {
    const { layer } = setup({ pipedAnswer: "123" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain(
          "cannot unmarshal number into Go value of type config.JWK",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: rejects a scalar string pasted at the stdin JWK prompt", () => {
    const { layer } = setup({ pipedAnswer: '"a string"' });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain(
          "cannot unmarshal string into Go value of type config.JWK",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Branch A: rejects a scalar boolean pasted at the stdin JWK prompt", () => {
    const { layer } = setup({ pipedAnswer: "true" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain(
          "cannot unmarshal bool into Go value of type config.JWK",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "Branch A: a literal 'null' pasted at the stdin JWK prompt is rejected, NOT the default key",
    () => {
      // `json.Unmarshal([]byte("null"), &key)` is a documented no-op for a
      // non-pointer struct target — it leaves `key` at its zero value
      // rather than erroring, and rather than falling back to the default
      // key. That zero-value JWK (empty `kty`) then fails downstream at SIGN time.
      const { layer } = setup({ pipedAnswer: "null" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtSignError");
          expect(json).toContain("failed to convert JWK to private key: unsupported key type: ");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: a truly blank answer at the stdin JWK prompt still falls back to the default key",
    () => {
      // Distinct from the literal-'null' case above: an EMPTY answer never reaches
      // `JSON.parse` at all (Go: `len(kid) == 0` gate), so it's the only input that
      // legitimately falls back to the built-in default key.
      const { layer, out } = setup({ pipedAnswer: "" });
      return Effect.gen(function* () {
        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: rejects a pasted JWK with an unsupported alg at decode time, not sign time",
    () => {
      // `config.Algorithm.UnmarshalText` rejects anything other than
      // RS256/ES256 DURING JSON decode, before the JWK ever reaches signing.
      const { layer } = setup({ pipedAnswer: encodeJson({ kty: "oct", alg: "HS256" }) });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtKeyParseError");
          expect(json).toContain("failed to parse JWK: must be one of [RS256 ES256]");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: accepts a pasted JWK missing alg entirely (validated later, at sign time, not decode time)",
    () => {
      const { alg: _alg, ...jwkWithoutAlg } = generateEcJwk("no-alg-kid");
      const { layer } = setup({ pipedAnswer: encodeJson(jwkWithoutAlg) });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtSignError");
          expect(json).toContain("unsupported algorithm: ");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: rejects a pasted JWK with a non-string key_ops element (CLI-1961 Codex review finding)",
    () => {
      // `{"kty":"oct","alg":"ES256","key_ops":["sign",1]}` must exit 1 with
      // this exact message — decoding into `config.JWK`'s `KeyOps []string`
      // field fails outright on a non-string element rather than silently
      // dropping the field the way this normalizer previously did.
      const { layer } = setup({
        pipedAnswer: encodeJson({ kty: "oct", alg: "ES256", key_ops: ["sign", 1] }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtKeyParseError");
          expect(json).toContain(
            "failed to parse JWK: json: cannot unmarshal number into Go struct field JWK.key_ops of type string",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: rejects a pasted JWK with ext given as a string instead of a bool (CLI-1961 Codex review finding)",
    () => {
      // `{"kty":"oct","alg":"ES256","ext":"true"}` must exit 1 with this
      // exact message — decoding into `config.JWK`'s `Extractable *bool`
      // field fails outright rather than silently dropping it.
      const { layer } = setup({
        pipedAnswer: encodeJson({ kty: "oct", alg: "ES256", ext: "true" }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtKeyParseError");
          expect(json).toContain(
            "failed to parse JWK: json: cannot unmarshal string into Go struct field JWK.ext of type bool",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("Branch A: rejects a pasted JWK with a non-string kid", () => {
    const { layer } = setup({
      pipedAnswer: encodeJson({ kty: "oct", alg: "ES256", kid: 123 }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain(
          "failed to parse JWK: json: cannot unmarshal number into Go struct field JWK.kid of type string",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "Branch A: rejects a pasted JWK with a duplicate kid where the earlier occurrence is malformed (CLI-1961 Codex review finding)",
    () => {
      // Verified against the real binary: `json.Unmarshal` into `config.JWK` decodes
      // struct fields in the object's OWN source order and errors on the FIRST
      // type-mismatch it finds — even though `JSON.parse` alone would silently keep
      // only the LAST occurrence (a valid `"k1"`) and never see the earlier `1` at all.
      const { layer } = setup({
        pipedAnswer: '{"kty":"oct","alg":"ES256","kid":1,"kid":"k1"}',
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain(
            "failed to parse JWK: json: cannot unmarshal number into Go struct field JWK.kid of type string",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: rejects a pasted JWK with a duplicate alg where the earlier occurrence fails the allowlist, even though the later one is allowed (CLI-1961 Codex review finding)",
    () => {
      // `config.Algorithm`'s `UnmarshalText` (the RS256/ES256 allowlist)
      // returning an error for the FIRST `alg` occurrence ("HS256") stops
      // the decoder from ever attempting the second ("ES256") — the
      // overall decode still fails with the allowlist error, even though
      // `JSON.parse` alone would keep only the later, individually-valid "ES256".
      const { layer } = setup({
        pipedAnswer: '{"kty":"oct","alg":"HS256","alg":"ES256"}',
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain(
            "failed to parse JWK: must be one of [RS256 ES256]",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: accepts a pasted JWK with a duplicate alg where EVERY occurrence is individually valid and allowed",
    () => {
      // Contrast with the previous test: the decoder only stops attempting
      // later occurrences once an EARLIER one fails — when every occurrence
      // independently succeeds, the LAST one wins normally, same as any
      // other duplicated field.
      const { layer, out } = setup({
        pipedAnswer: encodeJson({ ...generateEcJwk("dup-alg-kid"), alg: "ES256" }).replace(
          '"alg":"ES256"',
          '"alg":"RS256","alg":"ES256"',
        ),
      });
      return Effect.gen(function* () {
        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "dup-alg-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: accepts a pasted JWK with Go-decodable case-variant field names (CLI-1961 Codex review finding)",
    () => {
      // `encoding/json`-style matching resolves `config.JWK`'s struct fields
      // case-insensitively: `{"KTY":"EC","ALG":"ES256",...}` decodes
      // identically to the all-lowercase spelling, including `alg` despite its extra
      // `encoding.TextUnmarshaler` allowlist hook. A previous version of this
      // normalizer only read exact lowercase property names, silently treating a
      // case-variant field as absent and rejecting a key the established decoder accepts.
      const jwk = generateEcJwk("case-variant-kid");
      const caseVariantJwk = {
        KTY: jwk.kty,
        ALG: jwk.alg,
        KID: jwk.kid,
        CRV: jwk.crv,
        X: jwk.x,
        Y: jwk.y,
        D: jwk.d,
      };
      const { layer, out } = setup({ pipedAnswer: encodeJson(caseVariantJwk) });
      return Effect.gen(function* () {
        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "case-variant-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: rejects a pasted JWK with a case-variant duplicate kid where the earlier occurrence is malformed (CLI-1961 Codex review finding)",
    () => {
      // Same mechanism as the exact-case duplicate-kid test above, but the earlier
      // malformed occurrence spells the field "KID" while the later, valid one spells
      // it "kid" — case-insensitive struct-field matching means both feed the
      // SAME `config.JWK.KeyID` field, so the earlier malformed occurrence still fails
      // the overall decode, exactly like a same-case duplicate does.
      // `{"kty":"oct","alg":"ES256","KID":1,"kid":"k1"}` fails with this
      // exact message even though `kid`'s own later, valid occurrence is "k1".
      const { layer } = setup({
        pipedAnswer: '{"kty":"oct","alg":"ES256","KID":1,"kid":"k1"}',
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain(
            "failed to parse JWK: json: cannot unmarshal number into Go struct field JWK.kid of type string",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch A: a null field value is treated as absent, not a type mismatch (Go's encoding/json no-op)",
    () => {
      const { layer, out } = setup({
        pipedAnswer: encodeJson({ ...generateEcJwk("null-ext-kid"), ext: null }),
      });
      return Effect.gen(function* () {
        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "null-ext-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: rejects a stored signing key with a non-string key_ops element (CLI-1961 Codex review finding)",
    () => {
      // Verified against the real binary: a `signing_keys_path` file entry with a
      // malformed `key_ops` fails during config load with THIS wrap (matching the
      // sibling `alg`-allowlist check's own wrap for the same call site), not
      // silently dropping the field.
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(
          encodeJson([{ kty: "oct", alg: "ES256", kid: "k1", key_ops: ["sign", 1] }]),
        );

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtDecodeError");
          expect(json).toContain(
            "failed to decode signing keys: failed to parse response body: json: cannot unmarshal number into Go struct field JWK.key_ops of type string",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: rejects a stored signing key with a duplicate kid where the earlier occurrence is malformed (CLI-1961 Codex review finding)",
    () => {
      // Same gap as Branch A's pasted-JWK duplicate-kid test, but for a
      // `signing_keys_path` file entry: `legacyReadSigningKeysFile` must check each
      // element's OWN raw source text, not the already-`JSON.parse`d (duplicate-key
      // collapsed) record.
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys('[{"kty":"oct","alg":"ES256","kid":1,"kid":"k1"}]');

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtDecodeError");
          expect(json).toContain(
            "failed to decode signing keys: failed to parse response body: json: cannot unmarshal number into Go struct field JWK.kid of type string",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: rejects a stored signing key with a duplicate alg where the earlier occurrence fails the allowlist (CLI-1961 Codex review finding)",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys('[{"kty":"oct","kid":"k1","alg":"HS256","alg":"ES256"}]');

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtDecodeError");
          expect(json).toContain(
            "failed to decode signing keys: failed to parse response body: must be one of [RS256 ES256]",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: mints a token from the configured signing_keys_path's only key on a blank kid answer",
    () => {
      const jwk = generateEcJwk("ec-kid");
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([jwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", kid: "ec-kid", typ: "JWT" });
        expect(out.stderrText).toContain(
          "Enter the kid of your signing key (or leave blank to use the first one): ",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: accepts a stored signing key with Go-decodable case-variant field names (CLI-1961 Codex review finding)",
    () => {
      // Same fix as Branch A's pasted-JWK case-variant test, but for a
      // `signing_keys_path` file entry — `normalizeStoredJwk`'s field lookups go
      // through the SAME case-insensitive `resolveJwkFieldValue` helper, and the
      // `alg` allowlist pre-check in `legacyReadSigningKeysFile` needs the identical
      // fix.
      const jwk = generateEcJwk("case-variant-stored-kid");
      const caseVariantJwk = {
        KTY: jwk.kty,
        ALG: jwk.alg,
        KID: jwk.kid,
        CRV: jwk.crv,
        X: jwk.x,
        Y: jwk.y,
        D: jwk.d,
      };
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([caseVariantJwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "case-variant-stored-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: resolves signing_keys_path = env(KEYS_PATH) from supabase/.env.development, a file @supabase/config's own default env resolution doesn't read (CLI-1961 Codex review finding)",
    () => {
      // The dotenv cascade (which selects `.env.<SUPABASE_ENV>`, defaulting
      // to "development") runs BEFORE the TOML decoder ever resolves `env(...)`
      // references — so a `KEYS_PATH` set only in `supabase/.env.development` is visible
      // to the `signing_keys_path = "env(KEYS_PATH)"` resolution. `@supabase/config`'s
      // own default env loader (used whenever no `projectEnv` is explicitly threaded
      // through) only reads plain `supabase/.env`/`.env.local` and would otherwise leave
      // the literal string "env(KEYS_PATH)" unexpanded, and this call would fail trying
      // to open a file with THAT literal name.
      const jwk = generateEcJwk("ec-kid");
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "env(KEYS_PATH)"\n');
        yield* writeSupabaseEnvDevelopment("KEYS_PATH=./signing_keys.json\n");
        yield* writeSigningKeys(encodeJson([jwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", kid: "ec-kid", typ: "JWT" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: fails with Go's exact wrapped message for an unsupported key type (bearerjwt_test.go parity)",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([{ kty: "oct" }]));

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtSignError");
          expect(json).toContain("failed to convert JWK to private key: unsupported key type: oct");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("Branch B: fails with an empty key type when the stored key omits kty entirely", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
      yield* writeSigningKeys(encodeJson([{ alg: "ES256" }]));

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain(
          "failed to convert JWK to private key: unsupported key type: ",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "Branch B: rejects a configured signing key with an unsupported alg at decode time, not sign time",
    () => {
      // Decoding straight into `[]config.JWK` runs
      // `config.Algorithm.UnmarshalText`'s RS256/ES256 allowlist DURING that
      // decode.
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([{ kty: "oct", alg: "HS256" }]));

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtDecodeError");
          expect(json).toContain(
            "failed to decode signing keys: failed to parse response body: must be one of [RS256 ES256]",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: rejects a nested array entry in signing_keys_path instead of partially accepting a later valid key (CLI-1961 Codex review finding)",
    () => {
      // Go decodes `signing_keys_path` straight into `[]config.JWK`
      // (`fetcher.ParseJSON[[]JWK]`) — an array-shaped element can never unmarshal into
      // the `config.JWK` struct, so the WHOLE decode fails, verified directly against
      // `encoding/json`: `json.Unmarshal([]byte('[[], {"kty":"EC","kid":"k2"}]'),
      // &[]JWK{})` returns `"json: cannot unmarshal array into Go value of type
      // config.JWK"`. Before this fix, `isRecord`'s `typeof value === "object"` check
      // also matched arrays (arrays are `typeof "object"` in JS), so `[]` passed as a
      // "record" and a later valid key (`k2`) could still be selected and signed.
      const { layer } = setup();
      return Effect.gen(function* () {
        const validKey = generateEcJwk("k2");
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([[], validKey]));

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtDecodeError");
          expect(json).toContain("failed to decode signing keys: expected a JSON array of objects");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: accepts a null entry AFTER a valid key in signing_keys_path, signing with an exact kid match (CLI-1961 Codex review finding)",
    () => {
      // Distinct from the earlier-rejected null-BEFORE-valid-key finding on this PR:
      // there, `SigningKeys[0]` is the null-decoded zero-value JWK, so
      // `generateAPIKeys` fails signing before kid selection is ever reached. Here
      // the valid key is FIRST, so `generateAPIKeys` succeeds — but a BLANK kid
      // answer still fails, because the exact-KeyID-match loop runs BEFORE the
      // blank-input fallback and the null-decoded second entry's OWN kid is `""`,
      // an exact match for a blank answer (same quirk this file's "an exact kid
      // match on a key with an empty kid wins ahead of the blank-input
      // fallback-to-first" test already covers): a blank answer against
      // `[validKey, null]` fails identically to this port with
      // `"failed to convert JWK to private key: unsupported key type: "`. An
      // EXPLICIT exact-kid answer for the valid key still signs successfully in
      // both, which is what the finding's "a non-TTY user can still select
      // validKey" actually depends on. `json.Unmarshal` accepts
      // `[validKey, null]`, decoding the trailing `null` into a zero-value
      // `config.JWK` rather than failing the whole array.
      const validKey = generateEcJwk("valid-kid");
      const { layer, out } = setup({ pipedAnswer: "valid-kid" });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([validKey, null]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "valid-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: ignores trailing bytes after the first JSON value in signing_keys_path, matching Go's single Decode (CLI-1961 Codex review finding)",
    () => {
      // Decoding is a single `json.Decoder.Decode`-style call, which reads
      // exactly one JSON value and never checks for trailing bytes: a
      // `signing_keys_path` file containing a valid array followed by a second,
      // syntactically-valid JSON value still lets signing succeed with the
      // first array's key.
      const validKey = generateEcJwk("valid-kid");
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(`${encodeJson([validKey])} []`);

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "valid-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: accepts a stored signing key with a null key_ops element, matching Go's zero-value decode (CLI-1961 Codex review finding)",
    () => {
      // `key_ops` is never read by signing (it only inspects
      // `kty`/`Algorithm`/the key-material fields), and `json.Unmarshal` decodes a
      // `null` element of a `[]string` as that element's zero value (`""`), not a
      // type mismatch.
      const jwk = { ...generateEcJwk("null-key-ops-kid"), key_ops: ["sign", null] };
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([jwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "null-key-ops-kid",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch C: TTY with zero configured signing keys fails with Go's exact 'user aborted' text",
    () => {
      // A zero-item list quits immediately without ever letting the user
      // select anything. Previously this crashed with an unhandled
      // `TypeError` instead of failing gracefully.
      const { layer } = setup({ stdinIsTty: true });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys("[]");

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtKeyPickerAbortedError");
          expect(json).toContain("user aborted");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: selects a key by exact kid match among several (bearerjwt_test.go parity)",
    () => {
      const ecJwk = generateEcJwk("ec-kid");
      const rsaJwk = generateRsaJwk("rsa-kid");
      const { layer, out } = setup({ pipedAnswer: "rsa-kid" });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([ecJwk, rsaJwk]));

        yield* legacyGenBearerJwt({ ...baseFlags, role: Option.some("postgres") });
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: an unmatched kid, with a blank fallback available, still errors (bearerjwt_test.go parity)",
    () => {
      const { layer } = setup({ pipedAnswer: "test-key" });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys("[]");

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenBearerJwtKeyNotFoundError");
          expect(json).toContain("signing key not found: test-key");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch B: an exact kid match on a key with an empty kid wins ahead of the blank-input fallback-to-first",
    () => {
      const namedKey = generateEcJwk("named-kid");
      const { kid: _kid, ...unnamedKey } = generateEcJwk("unused");
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        // `namedKey` is listed FIRST, but has a non-empty kid; `unnamedKey` (no kid
        // field at all -> "") is listed SECOND. A blank answer must still resolve to
        // `unnamedKey` via the exact-match loop, not to `namedKey` via "return first".
        yield* writeSigningKeys(encodeJson([namedKey, unnamedKey]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", typ: "JWT" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch C: TTY picks a key via the interactive selector and echoes Selected key ID",
    () => {
      const ecJwk = generateEcJwk("ec-kid");
      const rsaJwk = generateRsaJwk("rsa-kid");
      const { layer, out } = setup({ stdinIsTty: true, promptSelectResponses: ["1"] });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([ecJwk, rsaJwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
        // This command's own stdout is the signed-token payload even in text mode, so the
        // line must land on stderr (`output.raw(..., "stderr")`), not via `output.info`
        // (clack's `log.info`, which defaults to stdout).
        expect(out.stderrText).toContain("Selected key ID: rsa-kid");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch C: TTY renders an empty label/kid/hint for a stored key missing kid and alg",
    () => {
      const { kid: _kid, alg: _alg, ...bareKey } = generateEcJwk("unused");
      const { layer, out } = setup({ stdinIsTty: true, promptSelectResponses: ["0"] });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([bareKey]));

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        // No `alg` at all fails downstream in the shared signer ("unsupported
        // algorithm: "), but the picker itself must still render before that.
        expect(Exit.isFailure(exit)).toBe(true);
        expect(out.promptSelectCalls[0]?.options[0]?.label).toBe("");
        expect(out.promptSelectCalls[0]?.options[0]?.hint).toBe(" ()");
        expect(out.stderrText).toContain("Selected key ID: ");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "Branch C: TTY renders the key's use/ext/key_ops fields when a stored key carries them",
    () => {
      const jwk = {
        ...generateEcJwk("full-kid"),
        use: "sig",
        ext: true,
        key_ops: ["sign", "verify"],
      };
      const { layer, out } = setup({ stdinIsTty: true, promptSelectResponses: ["0"] });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([jwk]));

        yield* legacyGenBearerJwt(baseFlags);
        expect(out.promptSelectCalls[0]?.options[0]?.hint).toBe("ES256 (sign,verify)");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "auth.enabled = false with signing_keys_path configured still uses the built-in default key (Go quirk)",
    () => {
      const otherJwk = generateEcJwk("configured-kid");
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([otherJwk]));

        yield* legacyGenBearerJwt(baseFlags);
        const token = tokenFrom(out);
        const [header] = token.split(".");
        // The default key's kid, NOT the file's key — the file is never read
        // when auth.enabled is false.
        expect(decodeSegment(header ?? "")).toEqual({
          alg: "ES256",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          typ: "JWT",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "auth.enabled = false with signing_keys_path configured: a real kid from the file is reported not found",
    () => {
      const otherJwk = generateEcJwk("configured-kid");
      const { layer } = setup({ pipedAnswer: "configured-kid" });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n');
        yield* writeSigningKeys(encodeJson([otherJwk]));

        const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain(
            "signing key not found: configured-kid",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when signing_keys_path is configured but the file is missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtReadError");
        expect(json).toContain("failed to read signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is not valid JSON at all", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
      yield* writeSigningKeys("not valid json {");

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtDecodeError");
        expect(json).toContain("failed to decode signing keys:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is not a JSON array at all", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
      yield* writeSigningKeys("{}");

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtDecodeError");
        expect(json).toContain("expected a JSON array");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is a JSON array of non-objects", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
      yield* writeSigningKeys("[1, 2]");

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenBearerJwtDecodeError");
        expect(json).toContain("expected a JSON array of objects");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a config parse error when config.toml is malformed", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig("not valid toml ][");

      const exit = yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("LegacyGenBearerJwtConfigParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state after a successful run", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt(baseFlags);
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state even when the signing-key resolution fails", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n');
      // No signing_keys.json written -> LegacyGenBearerJwtReadError.
      yield* Effect.exit(legacyGenBearerJwt(baseFlags));
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs through the command wiring without missing runtime services", () => {
    const out = mockOutput({ format: "text", interactive: false });
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      BunServices.layer,
      processControlLayer,
      CliOutput.layer(textCliOutputFormatter()),
      out.layer,
      analytics.layer,
      mockRuntimeInfo({ cwd: tempRoot.current, homeDir: tempRoot.current }),
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      Layer.succeed(CliArgs, { args: [] }),
      mockStdin(false),
      Layer.succeed(
        TelemetryRuntime,
        TelemetryRuntime.of({
          configDir: testPath.join(tempRoot.current, ".supabase"),
          tracesDir: testPath.join(tempRoot.current, ".supabase", "traces"),
          consent: "granted",
          showDebug: false,
          deviceId: "test-device-id",
          sessionId: "test-session-id",
          identity: makeTelemetryIdentity(undefined),
          isFirstRun: false,
          isTty: false,
          isCi: false,
          os: "linux",
          arch: "x64",
          cliVersion: "0.1.0",
        }),
      ),
      makeLegacyViperEnvLayer(),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "bearer-jwt",
        "--role",
        "service_role",
      ]);

      const token = tokenFrom(out);
      const [, payload] = token.split(".");
      const claims = decodeSegment(payload ?? "") as Record<string, unknown>;
      expect(claims["role"]).toBe("service_role");
    }).pipe(Effect.provide(layer));
  });
});
