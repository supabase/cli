import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

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

const prepare = (cwd: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyPreparePgDeltaRef(fs, path, cwd, ref, LEGACY_PG_DELTA_TARGET_SSL_ENV);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyPreparePgDeltaRef", () => {
  it.effect("passes through catalog-file refs and local/non-Supabase URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-ssl-"));
    return Effect.gen(function* () {
      const file = yield* prepare(dir, "supabase/.temp/pgdelta/catalog.json");
      expect(file).toEqual({ ref: "supabase/.temp/pgdelta/catalog.json", sslEnv: {} });
      const local = yield* prepare(dir, "postgresql://u:p@127.0.0.1:54322/postgres");
      expect(local.ref).toBe("postgresql://u:p@127.0.0.1:54322/postgres");
      expect(local.sslEnv).toEqual({});
    }).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
  });

  it.effect("writes the CA bundle and rewrites the URL for a Supabase-hosted remote", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-ssl-"));
    return Effect.gen(function* () {
      const prepared = yield* prepare(dir, "postgresql://u:p@db.abc.supabase.co:5432/postgres");
      expect(prepared.ref).toContain("sslmode=verify-ca");
      // sslrootcert is percent-encoded in the query string (matches Go's url.Values.Encode).
      expect(prepared.ref).toContain("pgdelta-target-ca.crt");
      expect(decodeURIComponent(new URL(prepared.ref).searchParams.get("sslrootcert") ?? "")).toBe(
        "/workspace/supabase/.temp/pgdelta/pgdelta-target-ca.crt",
      );
      expect(prepared.sslEnv[LEGACY_PG_DELTA_TARGET_SSL_ENV]).toBe(LEGACY_PG_DELTA_CA_BUNDLE);
      const written = readFileSync(
        join(dir, "supabase", ".temp", "pgdelta", "pgdelta-target-ca.crt"),
        "utf8",
      );
      expect(written).toBe(LEGACY_PG_DELTA_CA_BUNDLE);
    }).pipe(Effect.tap(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
  });
});

describe("LEGACY_PG_DELTA_CA_BUNDLE", () => {
  it("concatenates the three Supabase CA certificates", () => {
    expect(LEGACY_PG_DELTA_CA_BUNDLE.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
  });
});
