import { describe, expect, test } from "vitest";
import { envDatabaseUrl, envDatabaseUrlVarName } from "./database-target.ts";

describe("envDatabaseUrl", () => {
  test("prefers SUPABASE_DB_URL over DATABASE_URL", () => {
    const previousSupa = process.env["SUPABASE_DB_URL"];
    const previousDb = process.env["DATABASE_URL"];
    process.env["SUPABASE_DB_URL"] = "postgresql://supabase";
    process.env["DATABASE_URL"] = "postgresql://database";
    try {
      expect(envDatabaseUrl()).toBe("postgresql://supabase");
      expect(envDatabaseUrlVarName()).toBe("SUPABASE_DB_URL");
    } finally {
      if (previousSupa === undefined) delete process.env["SUPABASE_DB_URL"];
      else process.env["SUPABASE_DB_URL"] = previousSupa;
      if (previousDb === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousDb;
    }
  });
});
