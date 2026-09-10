import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import {
  InvalidJwtSigningMaterialError,
  StackMustBeStoppedError,
  StackSecretMismatchError,
} from "../public/Errors.ts";
import { compileStack } from "../model/Compiler.ts";
import {
  redactKnownSecrets,
  resolveSecrets,
  resolveSigningKeyMaterial,
  type SecretCandidate,
} from "./SecretStore.ts";

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
const compilerManagedSlots = [
  "secret:database.internal.password",
  "secret:auth.settings.publishable_key",
  "secret:auth.settings.secret_key",
  "secret:auth.settings.jwt_secret",
  "secret:auth.settings.anon_key",
  "secret:auth.settings.service_role_key",
  "secret:storage.settings.s3_protocol.secret_access_key",
  "secret:realtime.settings.db_enc_key",
  "secret:realtime.settings.secret_key_base",
] as const;
const compilerCandidate = compileStack({
  projectRoot: "/tmp/project",
  runtime: { kind: "native" },
}).pipe(Effect.map((compiled) => ({ declarations: compiled.secrets })));
const present = <T>(value: T | undefined, description: string): T => {
  expect(value, description).toBeDefined();
  if (value === undefined) throw new Error(`Expected ${description}`);
  return value;
};

describe("managed and pass-through secrets", () => {
  it.live("generates managed omissions once and reuses them", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed(), undefined, "stopped");
      const second = yield* resolveSecrets(managed(), first.persisted, "running");
      expect(second.persisted["managed:db"]?.value).toBe(first.persisted["managed:db"]?.value);
      expect(second.persisted["managed:db"]?.value).not.toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates compiler-required managed slots with artifact-compatible values", () =>
    Effect.gen(function* () {
      const candidate = yield* compilerCandidate;
      const resolved = yield* resolveSecrets(candidate, undefined, "stopped");
      for (const slot of compilerManagedSlots) {
        expect(resolved.persisted[slot]?.policy).toBe("managed");
        expect(resolved.persisted[slot]?.value).toEqual(expect.any(String));
      }
      expect(
        present(
          resolved.persisted["secret:realtime.settings.db_enc_key"]?.value,
          "realtime database encryption key",
        ),
      ).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(
        present(
          resolved.persisted["secret:realtime.settings.secret_key_base"]?.value,
          "realtime secret key base",
        ),
      ).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(
        present(
          resolved.persisted["secret:auth.settings.publishable_key"]?.value,
          "publishable key",
        ),
      ).toMatch(/^sb_publishable_[A-Za-z0-9_-]{32,}$/);
      expect(
        present(resolved.persisted["secret:auth.settings.secret_key"]?.value, "secret key"),
      ).toMatch(/^sb_secret_[A-Za-z0-9_-]{32,}$/);
      expect(
        present(resolved.persisted["secret:auth.settings.jwt_secret"]?.value, "JWT secret"),
      ).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      for (const slot of [
        "secret:auth.settings.anon_key",
        "secret:auth.settings.service_role_key",
      ]) {
        const token = present(resolved.persisted[slot]?.value, slot);
        const tokenParts = token.split(".");
        expect(tokenParts).toHaveLength(3);
        const payloadText = Buffer.from(
          present(tokenParts[1], `${slot} payload`),
          "base64url",
        ).toString();
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        const payload = JSON.parse(payloadText);
        expect(payload).toMatchObject({
          iss: "supabase-demo",
          role: slot.endsWith("anon_key") ? "anon" : "service_role",
          exp: expect.any(Number),
        });
        expect(payload.exp).toBeGreaterThan(1_900_000_000);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("reuses generated values for every compiler-managed slot", () =>
    Effect.gen(function* () {
      const candidate = yield* compilerCandidate;
      const first = yield* resolveSecrets(candidate, undefined, "stopped");
      const second = yield* resolveSecrets(candidate, first.persisted, "running");
      for (const slot of compilerManagedSlots) {
        expect(second.persisted[slot]?.policy).toBe("managed");
        expect(second.persisted[slot]?.value).toBe(first.persisted[slot]?.value);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates a fresh managed secret for a different stack", () =>
    Effect.gen(function* () {
      const candidate = yield* compilerCandidate;
      const first = yield* resolveSecrets(candidate, undefined, "stopped");
      const other = yield* resolveSecrets(candidate, undefined, "stopped");
      const slot = "secret:storage.settings.s3_protocol.secret_access_key";
      expect(other.persisted[slot]?.value).not.toBe(first.persisted[slot]?.value);
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates artifact-compatible pooler managed keys", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
        config: { capabilities: { pooler: { enabled: true } } },
      });
      const candidate = { declarations: compiled.secrets };
      const first = yield* resolveSecrets(candidate, undefined, "stopped");
      const second = yield* resolveSecrets(candidate, first.persisted, "running");
      const encryptionKey = first.persisted["secret:pooler.settings.encryption_key"]?.value;
      const secretKeyBase = first.persisted["secret:pooler.settings.secret_key_base"]?.value;
      expect(encryptionKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(secretKeyBase).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(second.persisted["secret:pooler.settings.encryption_key"]?.value).toBe(encryptionKey);
      expect(second.persisted["secret:pooler.settings.secret_key_base"]?.value).toBe(secretKeyBase);
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects mixed valid and invalid private JWK entries as one file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-jwks-mixed-" });
      const privateJwk = {
        ...generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          format: "jwk",
        }),
        alg: "ES256",
      };
      yield* fs.writeFileString(
        path.join(root, "keys.json"),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- dynamic JWK fixture JSON
        JSON.stringify([privateJwk, { kty: "EC", alg: "ES256", d: "invalid" }]),
      );
      const failed = yield* resolveSigningKeyMaterial({
        kind: "jwks-file",
        projectRoot: root,
        path: "keys.json",
      }).pipe(Effect.exit);
      expect(errorOf(failed)).toBeInstanceOf(InvalidJwtSigningMaterialError);
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
      const token = present(
        resolved.persisted["secret:auth.settings.anon_key"]?.value,
        "anon token",
      );
      const [header, payload, signature] = token.split(".");
      const tokenHeader = present(header, "JWT header");
      const tokenPayload = present(payload, "JWT payload");
      const tokenSignature = present(signature, "JWT signature");
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      expect(JSON.parse(Buffer.from(tokenHeader, "base64url").toString())).toMatchObject({
        alg: "ES256",
        kid: "test-key",
      });
      const verifier = createVerify("sha256");
      verifier.update(`${tokenHeader}.${tokenPayload}`);
      verifier.end();
      expect(
        verifier.verify(
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(tokenSignature, "base64url"),
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
      const token = present(
        resolved.persisted["secret:auth.settings.service_role_key"]?.value,
        "service role token",
      );
      const [header, payload, signature] = token.split(".");
      const tokenHeader = present(header, "JWT header");
      const tokenPayload = present(payload, "JWT payload");
      const tokenSignature = present(signature, "JWT signature");
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      expect(JSON.parse(Buffer.from(tokenHeader, "base64url").toString())).toMatchObject({
        alg: "RS256",
        kid: "rsa-key",
      });
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${tokenHeader}.${tokenPayload}`);
      verifier.end();
      expect(verifier.verify(publicKey, Buffer.from(tokenSignature, "base64url"))).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("derives asymmetric JWT expiry from the Effect Clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_123_456);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "ES256" };
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
      const token = present(
        resolved.persisted["secret:auth.settings.anon_key"]?.value,
        "anon token",
      );
      const payloadPart = present(token.split(".")[1], "JWT payload");
      const payloadText = Buffer.from(payloadPart, "base64url").toString();
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
      const payload = JSON.parse(payloadText);
      expect(payload).toEqual({
        iss: "supabase-demo",
        role: "anon",
        exp: 1_700_000_123 + 60 * 60 * 24 * 365 * 10,
      });
      expect(payload).not.toHaveProperty("iat");
    }).pipe(Effect.provide(layer)),
  );

  it.live("fails closed for public-only JWKS material", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
      const publicJwk = {
        ...generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
          format: "jwk",
        }),
        alg: "ES256",
      };
      yield* fs.writeFileString(
        path.join(root, "public.json"),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        JSON.stringify([publicJwk]),
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
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects a configured JWKS file that does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-missing-jwks-" });
      const compiled = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "missing.json" } } } },
      });

      const failed = yield* resolveSecrets(
        { declarations: compiled.secrets },
        undefined,
        "stopped",
      ).pipe(Effect.exit);

      expect(errorOf(failed)).toBeInstanceOf(InvalidJwtSigningMaterialError);
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects JWKS files outside the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-credentials-" });
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
      expect(errorOf(escapingExit)?.message).toContain(
        "JWT signing key file must be inside project root",
      );

      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-outside-" });
      yield* fs.writeFileString(
        path.join(outside, "private.json"),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        JSON.stringify([{ kty: "EC", alg: "ES256", crv: "P-256", d: "d", x: "x", y: "y" }]),
      );
      yield* fs.symlink(path.join(outside, "private.json"), path.join(root, "linked.json"));
      const symlinkEscape = yield* compileStack({
        projectRoot: root,
        runtime: { kind: "native" },
        config: {
          security: { jwt: { signing: { kind: "jwks-file", path: "linked.json" } } },
        },
      });
      const symlinkExit = yield* resolveSecrets(
        { declarations: symlinkEscape.secrets },
        undefined,
        "stopped",
      ).pipe(Effect.exit);
      expect(errorOf(symlinkExit)).toBeInstanceOf(InvalidJwtSigningMaterialError);
      expect(errorOf(symlinkExit)?.message).toContain(
        "JWT signing key file must be inside project root",
      );
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
      const token = present(
        resolved.persisted["secret:auth.settings.anon_key"]?.value,
        "anon token",
      );
      const [header, payload, signature] = token.split(".");
      const tokenHeader = present(header, "JWT header");
      const tokenPayload = present(payload, "JWT payload");
      const tokenSignature = present(signature, "JWT signature");
      const expected = createHmac("sha256", jwt)
        .update(`${tokenHeader}.${tokenPayload}`)
        .digest("base64url");
      expect(tokenSignature).toBe(expected);
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

  it.live("allows pass-through add, replacement, and removal while stopped", () =>
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
