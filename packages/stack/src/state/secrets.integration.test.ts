import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import {
  InvalidJwtSigningMaterialError,
  StackMustBeStoppedError,
  StackSecretMismatchError,
} from "../public/Errors.ts";
import { compileStack } from "../model/Compiler.ts";
import { redactKnownSecrets, resolveSecrets, type SecretCandidate } from "./SecretStore.ts";

const layer = NodeServices.layer;
const managed = (value?: string): SecretCandidate => ({
  declarations: [
    {
      slot: "managed:db",
      policy: "managed",
      value: value === undefined ? undefined : Redacted.make(value),
    },
  ],
});
const passthrough = (slot: string, value: string): SecretCandidate => ({
  declarations: [{ slot, policy: "passthrough", value: Redacted.make(value) }],
});
const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("managed and pass-through secrets", () => {
  it.live("generates managed omissions once and reuses them", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed(), undefined, "stopped");
      const second = yield* resolveSecrets(managed(), first.persisted, "running");
      expect(second.persisted["managed:db"]?.value).toBe(first.persisted["managed:db"]?.value);
      expect(second.persisted["managed:db"]?.value).not.toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates and reuses every compiler-required managed slot", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
      });
      const candidate = { declarations: compiled.secrets };
      const first = yield* resolveSecrets(candidate, undefined, "stopped");
      const second = yield* resolveSecrets(candidate, first.persisted, "running");
      for (const slot of [
        "secret:database.internal.password",
        "secret:auth.settings.publishable_key",
        "secret:auth.settings.secret_key",
        "secret:auth.settings.jwt_secret",
        "secret:auth.settings.anon_key",
        "secret:auth.settings.service_role_key",
      ]) {
        expect(first.persisted[slot]?.policy).toBe("managed");
        expect(first.persisted[slot]?.value).toBe(second.persisted[slot]?.value);
      }
      expect(first.persisted["secret:auth.settings.publishable_key"]?.value).toMatch(
        /^sb_publishable_[A-Za-z0-9_-]{32,}$/,
      );
      expect(first.persisted["secret:auth.settings.secret_key"]?.value).toMatch(
        /^sb_secret_[A-Za-z0-9_-]{32,}$/,
      );
      const jwtSecret = first.persisted["secret:auth.settings.jwt_secret"]?.value;
      expect(jwtSecret).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      for (const slot of [
        "secret:auth.settings.anon_key",
        "secret:auth.settings.service_role_key",
      ]) {
        const token = first.persisted[slot]?.value;
        expect(token?.split(".")).toHaveLength(3);
        const payloadText = Buffer.from(token!.split(".")[1]!, "base64url").toString();
        expect(payloadText).toMatch(
          /^\{"iss":"supabase-demo","role":"(?:anon|service_role)","exp":1983812996\}$/,
        );
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        const payload = JSON.parse(payloadText);
        expect(payload).toMatchObject({ iss: "supabase-demo" });
        expect(["anon", "service_role"]).toContain(payload.role);
        expect(payload.exp).toBeGreaterThan(1_900_000_000);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects a configured JWKS file without a private signing key", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "public.json" } } } },
      });
      const exit = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      ).pipe(Effect.exit);
      expect(errorOf(exit)).toBeInstanceOf(InvalidJwtSigningMaterialError);
    }).pipe(Effect.provide(layer)),
  );

  it.live("signs generated API keys with the first private ES256 JWK", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "test-key" };
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      yield* fs.writeFileString(path.join(root, "keys.json"), JSON.stringify([privateJwk]));
      const compiled = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "keys.json" } } } },
      });
      const resolved = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      );
      const token = resolved.persisted["secret:auth.settings.anon_key"]?.value;
      expect(token).toBeDefined();
      const [header, payload, signature] = token!.split(".");
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
        alg: "ES256",
        kid: "test-key",
      });
      const verifier = createVerify("sha256");
      verifier.update(`${header}.${payload}`);
      verifier.end();
      expect(
        verifier.verify(
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.live("signs generated API keys with a private RS256 JWK", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "rsa-key" };
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      yield* fs.writeFileString(path.join(root, "keys.json"), JSON.stringify([privateJwk]));
      const compiled = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "keys.json" } } } },
      });
      const resolved = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      );
      const token = resolved.persisted["secret:auth.settings.service_role_key"]?.value;
      expect(token).toBeDefined();
      const [header, payload, signature] = token!.split(".");
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
        alg: "RS256",
        kid: "rsa-key",
      });
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      verifier.end();
      expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.live("fails closed for public-only or escaping JWKS material", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
      yield* fs.writeFileString(
        path.join(root, "public.json"),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        JSON.stringify([{ kty: "EC", alg: "ES256", crv: "P-256", x: "x", y: "y" }]),
      );
      const publicOnly = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: {
          security: { jwt: { signing: { kind: "jwks-file", path: "public.json" } } },
        },
      });
      const publicExit = yield* resolveSecrets(
        { declarations: publicOnly.secrets },
        undefined,
        "stopped",
      ).pipe(Effect.exit);
      expect(errorOf(publicExit)).toBeInstanceOf(InvalidJwtSigningMaterialError);

      const escaping = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: {
          security: { jwt: { signing: { kind: "jwks-file", path: "../outside.json" } } },
        },
      });
      const escapingExit = yield* resolveSecrets(
        { declarations: escaping.secrets },
        undefined,
        "stopped",
      ).pipe(Effect.exit);
      expect(errorOf(escapingExit)).toBeInstanceOf(InvalidJwtSigningMaterialError);
    }).pipe(Effect.provide(layer)),
  );

  it.live("keeps explicit managed credentials unchanged", () =>
    Effect.gen(function* () {
      const configured = {
        publishable: "sb_publishable_explicit",
        secret: "sb_secret_explicit",
        jwt: "a-secure-jwt-secret-value-that-is-long-enough",
        anon: "explicit-anon-token",
        service: "explicit-service-token",
      };
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
        config: {
          capabilities: {
            auth: {
              settings: {
                publishable_key: Redacted.make(configured.publishable),
                secret_key: Redacted.make(configured.secret),
                jwt_secret: Redacted.make(configured.jwt),
                anon_key: Redacted.make(configured.anon),
                service_role_key: Redacted.make(configured.service),
              },
            },
          },
        },
      });
      const resolved = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      );
      expect(resolved.persisted["secret:auth.settings.publishable_key"]?.value).toBe(
        configured.publishable,
      );
      expect(resolved.persisted["secret:auth.settings.secret_key"]?.value).toBe(configured.secret);
      expect(resolved.persisted["secret:auth.settings.jwt_secret"]?.value).toBe(configured.jwt);
      expect(resolved.persisted["secret:auth.settings.anon_key"]?.value).toBe(configured.anon);
      expect(resolved.persisted["secret:auth.settings.service_role_key"]?.value).toBe(
        configured.service,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live("signs generated symmetric API keys with the canonical JWT secret", () =>
    Effect.gen(function* () {
      const jwt = "symmetric-jwt-secret-that-is-long-enough";
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
        config: {
          capabilities: { auth: { settings: { jwt_secret: Redacted.make(jwt) } } },
        },
      });
      const resolved = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      );
      const token = resolved.persisted["secret:auth.settings.anon_key"]?.value;
      expect(token).toBeDefined();
      const [header, payload, signature] = token!.split(".");
      const expected = createHmac("sha256", jwt).update(`${header}.${payload}`).digest("base64url");
      expect(signature).toBe(expected);
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects a conflicting managed value in stopped and running states", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed("original"), undefined, "stopped");
      for (const lifecycle of ["stopped", "running"] as const) {
        const exit = yield* resolveSecrets(managed("different"), first.persisted, lifecycle).pipe(
          Effect.exit,
        );
        expect(errorOf(exit)).toBeInstanceOf(StackSecretMismatchError);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("allows complete pass-through add, replacement, and removal only while stopped", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(passthrough("pass:smtp", "old"), undefined, "stopped");
      const replacement = yield* resolveSecrets(
        passthrough("pass:smtp", "new"),
        first.persisted,
        "stopped",
      );
      expect(replacement.persisted["pass:smtp"]?.value).toBe("new");
      const removed = yield* resolveSecrets({ declarations: [] }, replacement.persisted, "stopped");
      expect(removed.persisted["pass:smtp"]).toBeUndefined();
      const running = yield* resolveSecrets(
        { declarations: [] },
        replacement.persisted,
        "running",
      ).pipe(Effect.exit);
      expect(errorOf(running)).toBeInstanceOf(StackMustBeStoppedError);
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    "rejects pass-through additions, replacements, and removals while running or destroying",
    () =>
      Effect.gen(function* () {
        const existing = yield* resolveSecrets(
          passthrough("pass:smtp", "old"),
          undefined,
          "stopped",
        );
        for (const lifecycle of ["running", "destroying"] as const) {
          const added = yield* resolveSecrets(
            passthrough("pass:new", "value"),
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(added)).toBeInstanceOf(StackMustBeStoppedError);
          const replaced = yield* resolveSecrets(
            passthrough("pass:smtp", "new"),
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(replaced)).toBeInstanceOf(StackMustBeStoppedError);
          const removed = yield* resolveSecrets(
            { declarations: [] },
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(removed)).toBeInstanceOf(StackMustBeStoppedError);
          const unchanged = yield* resolveSecrets(
            passthrough("pass:smtp", "old"),
            existing.persisted,
            lifecycle,
          );
          expect(unchanged.persisted["pass:smtp"]?.value).toBe("old");
        }
      }).pipe(Effect.provide(layer)),
  );

  it.live("does not include secret bytes in mismatch errors or redaction output", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed("top-secret"), undefined, "stopped");
      const exit = yield* resolveSecrets(managed("other-secret"), first.persisted, "stopped").pipe(
        Effect.exit,
      );
      const error = errorOf(exit);
      expect(String(error)).not.toContain("top-secret");
      expect(String(error)).not.toContain("other-secret");
    }).pipe(Effect.provide(layer)),
  );

  it("redacts overlapping known values longest-first", () => {
    expect(redactKnownSecrets("token=abc123; short=abc", ["abc", "abc123", "abc", ""])).toBe(
      "token=[REDACTED]; short=[REDACTED]",
    );
  });
});
