import { describe, expect, it } from "vitest";

import type { PgConnInput } from "./db-connection.service.ts";
import { pinSupabaseTls, rootCaBundle } from "./supabase-tls.ts";

const conn = (host: string, overrides: Partial<PgConnInput> = {}): PgConnInput => ({
  host,
  port: 5432,
  user: "postgres",
  password: "pw",
  database: "postgres",
  ...overrides,
});

describe("pinSupabaseTls host matching", () => {
  it.each([
    "db.ref.supabase.co",
    "DB.REF.SUPABASE.CO",
    "db.ref.supabase.co.",
    "aws-0-us-east-1.pooler.supabase.com",
    "AWS-0-US-EAST-1.POOLER.SUPABASE.COM.",
  ])("pins %s", (host) => {
    expect(pinSupabaseTls(conn(host), "supabase")).toMatchObject({
      sslmode: "require",
      sslrootcertInline: rootCaBundle(),
    });
  });

  it.each([
    "db.x.evilsupabase.co",
    "db.ref.supabase.co.evil.com",
    "supabase.co",
    "localhost",
    "127.0.0.1",
    "::1",
    "2600:1f18::1",
  ])("leaves %s unpinned", (host) => {
    const input = conn(host);
    expect(pinSupabaseTls(input, "supabase")).toBe(input);
  });

  it("leaves a connection that chose its own TLS settings unchanged", () => {
    const input = conn("db.ref.supabase.co", { sslmode: "disable" });
    expect(pinSupabaseTls(input, "supabase")).toBe(input);
  });
});
