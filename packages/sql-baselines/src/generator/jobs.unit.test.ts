import { describe, expect, it } from "vitest";
import { migrateJobs } from "./jobs.ts";

const inputs = {
  dbHost: "supabase_db_x",
  images: {
    realtime: "supabase/realtime:v2.124.2",
    storage: "supabase/storage-api:v1.68.10",
    auth: "supabase/gotrue:v2.195.0",
  },
} as const;

describe("migrateJobs", () => {
  it("runs realtime → storage → auth, matching the CLI's initSchema15 order", () => {
    expect(migrateJobs(inputs).map((job) => job.service)).toEqual(["realtime", "storage", "auth"]);
  });

  it("mirrors the CLI's realtime job: supabase_admin connection and self-host seeding", () => {
    const [realtime] = migrateJobs(inputs);
    expect(realtime?.env).toMatchObject({
      DB_HOST: "supabase_db_x",
      DB_USER: "supabase_admin",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      SEED_SELF_HOST: "true",
    });
    expect(realtime?.cmd[2]).toContain('Realtime.Tenants.health_check("realtime-dev")');
    expect(realtime?.excluded).toEqual([String.raw`^realtime\.messages_\d{4}_\d{2}_\d{2}$`]);
  });

  it("mirrors the CLI's storage job: role skip and single-tenant mode", () => {
    const storage = migrateJobs(inputs)[1];
    expect(storage?.env["DB_INSTALL_ROLES"]).toBe("false");
    expect(storage?.env["DATABASE_URL"]).toBe(
      "postgresql://supabase_storage_admin:postgres@supabase_db_x:5432/postgres",
    );
    // Freeze must stay unset: a bundle is the full state of the pinned release.
    expect(storage?.env).not.toHaveProperty("DB_MIGRATIONS_FREEZE_AT");
    expect(storage?.trackingTables).toEqual(["storage.migrations"]);
  });

  it("mirrors the CLI's auth job: gotrue migrate as supabase_auth_admin", () => {
    const auth = migrateJobs(inputs)[2];
    expect(auth?.cmd).toEqual(["gotrue", "migrate"]);
    expect(auth?.serviceRole).toBe("supabase_auth_admin");
    expect(auth?.env["GOTRUE_DB_DATABASE_URL"]).toBe(
      "postgresql://supabase_auth_admin:postgres@supabase_db_x:5432/postgres",
    );
  });
});
