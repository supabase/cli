import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeError,
} from "./legacy-pgdelta-ssl-probe.service.ts";
import {
  LEGACY_PG_DELTA_CA_BUNDLE,
  LEGACY_PG_DELTA_TARGET_SSL_ENV,
  legacyEnsurePgDeltaSsl,
  legacyIsSupabaseHostedPostgresUrl,
  legacyPreparePgDeltaRef,
} from "./legacy-pgdelta-ssl.ts";

describe("legacyIsSupabaseHostedPostgresUrl", () => {
  it("recognizes Supabase-hosted hosts", () => {
    expect(
      legacyIsSupabaseHostedPostgresUrl("postgresql://x@db.abc.supabase.co:5432/postgres"),
    ).toBe(true);
    expect(
      legacyIsSupabaseHostedPostgresUrl("postgresql://x@pooler.supabase.com:6543/postgres"),
    ).toBe(true);
    expect(
      legacyIsSupabaseHostedPostgresUrl("postgresql://x@abc.pooler.supabase.com:6543/postgres"),
    ).toBe(true);
  });

  it("rejects local + non-Supabase hosts and unparseable URLs", () => {
    expect(legacyIsSupabaseHostedPostgresUrl("postgresql://x@127.0.0.1:54322/postgres")).toBe(
      false,
    );
    expect(legacyIsSupabaseHostedPostgresUrl("postgresql://x@db.example.com:5432/postgres")).toBe(
      false,
    );
    expect(legacyIsSupabaseHostedPostgresUrl("not a url")).toBe(false);
  });
});

describe("legacyEnsurePgDeltaSsl", () => {
  it("forces sslmode=verify-ca and sets sslrootcert", () => {
    const out = legacyEnsurePgDeltaSsl(
      "postgresql://u:p@db.abc.supabase.co:5432/postgres?connect_timeout=10",
      "/workspace/supabase/.temp/pgdelta/pgdelta-target-ca.crt",
    );
    expect(out).toContain("sslmode=verify-ca");
    expect(out).toContain(
      "sslrootcert=%2Fworkspace%2Fsupabase%2F.temp%2Fpgdelta%2Fpgdelta-target-ca.crt",
    );
    expect(out).toContain("connect_timeout=10");
  });

  it("preserves an existing verify-full sslmode", () => {
    const out = legacyEnsurePgDeltaSsl("postgresql://h/db?sslmode=verify-full", "");
    expect(out).toContain("sslmode=verify-full");
  });
});

// Stub the live TLS probe so `legacyPreparePgDeltaRef` is testable without a server.
// `requireSsl` is what Go's `isRequireSSL` returns: true → server speaks TLS,
// false → server refused TLS, or a probe error (propagated like Go's `return false, err`).
const probeLayer = (requireSsl: boolean | "error") =>
  Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () =>
      requireSsl === "error"
        ? Effect.fail(new LegacyPgDeltaSslProbeError({ message: "connection refused" }))
        : Effect.succeed(requireSsl),
    requireSslForHost: () =>
      requireSsl === "error"
        ? Effect.fail(new LegacyPgDeltaSslProbeError({ message: "connection refused" }))
        : Effect.succeed(requireSsl),
  });

const prepare = (cwd: string, ref: string, requireSsl: boolean | "error" = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyPreparePgDeltaRef(fs, path, cwd, ref, LEGACY_PG_DELTA_TARGET_SSL_ENV);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, probeLayer(requireSsl))));

describe("legacyPreparePgDeltaRef", () => {
  it.effect("passes through catalog-file refs without probing", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ssl-" });
      const file = yield* prepare(dir, "supabase/.temp/pgdelta/catalog.json", "error");
      expect(file).toEqual({ ref: "supabase/.temp/pgdelta/catalog.json", sslEnv: {} });
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("passes through a URL when the server refuses TLS (probe → not required)", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ssl-" });
      const local = yield* prepare(dir, "postgresql://u:p@127.0.0.1:54322/postgres", false);
      expect(local.ref).toBe("postgresql://u:p@127.0.0.1:54322/postgres");
      expect(local.sslEnv).toEqual({});
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "injects the CA bundle for a non-Supabase remote that requires TLS (probe → required)",
    () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ssl-" });
        const prepared = yield* prepare(dir, "postgresql://u:p@db.example.com:5432/postgres", true);
        expect(prepared.ref).toContain("sslmode=verify-ca");
        expect(prepared.ref).toContain("pgdelta-target-ca.crt");
        expect(prepared.sslEnv[LEGACY_PG_DELTA_TARGET_SSL_ENV]).toBe(LEGACY_PG_DELTA_CA_BUNDLE);
        yield* fs.remove(dir, { recursive: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("propagates a probe connection error (Go's `return false, err`)", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ssl-" });
      const exit = yield* prepare(
        dir,
        "postgresql://u:p@db.example.com:5432/postgres",
        "error",
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "writes the CA bundle for a Supabase-hosted remote even when the probe reports no TLS",
    () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ssl-" });
        // probe=false exercises Go's `pgDeltaRootCA` Supabase fallback branch.
        const prepared = yield* prepare(
          dir,
          "postgresql://u:p@db.abc.supabase.co:5432/postgres",
          false,
        );
        expect(prepared.ref).toContain("sslmode=verify-ca");
        // sslrootcert is percent-encoded in the query string (matches Go's url.Values.Encode).
        expect(prepared.ref).toContain("pgdelta-target-ca.crt");
        expect(
          decodeURIComponent(new URL(prepared.ref).searchParams.get("sslrootcert") ?? ""),
        ).toBe("/workspace/supabase/.temp/pgdelta/pgdelta-target-ca.crt");
        expect(prepared.sslEnv[LEGACY_PG_DELTA_TARGET_SSL_ENV]).toBe(LEGACY_PG_DELTA_CA_BUNDLE);
        const written = yield* fs.readFileString(
          path.join(dir, "supabase", ".temp", "pgdelta", "pgdelta-target-ca.crt"),
        );
        expect(written).toBe(LEGACY_PG_DELTA_CA_BUNDLE);
        yield* fs.remove(dir, { recursive: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});

describe("LEGACY_PG_DELTA_CA_BUNDLE", () => {
  it("concatenates the three Supabase CA certificates", () => {
    expect(LEGACY_PG_DELTA_CA_BUNDLE.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
  });
});
