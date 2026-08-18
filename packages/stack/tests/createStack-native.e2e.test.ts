import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { setupTestTable } from "./helpers/e2e.ts";

describe("native PostgREST tracer bullet", () => {
  let stack: StackHandle;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-native-postgrest-e2e-"));
    stack = await createStack({
      mode: "native",
      functions: false,
      edgeRuntime: false,
      auth: false,
      postgres: { dataDir },
    });
    await stack.start();
    await setupTestTable(parseInt(new URL(stack.dbUrl).port));
  }, 45_000);

  afterAll(async () => {
    await stack?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  test("serves a CRUD request through the native PostgREST resource", async () => {
    const client = createClient(stack.url, stack.publishableKey);
    const inserted = await client
      .from("todos")
      .insert({ title: "native tracer bullet" })
      .select()
      .single();

    expect(inserted.error).toBeNull();
    expect(inserted.data).toEqual(expect.objectContaining({ title: "native tracer bullet" }));

    const deleted = await client.from("todos").delete().eq("title", "native tracer bullet");
    expect(deleted.error).toBeNull();
  }, 30_000);
});
