// This script applies declarative schema files to a target database and emits
// structured JSON so the Go caller can report success/failure deterministically.
import {
  applyDeclarativeSchema,
  loadDeclarativeSchema,
} from "npm:@supabase/pg-delta@1.0.0-alpha.8/declarative";

const schemaPath = Deno.env.get("SCHEMA_PATH");
const target = Deno.env.get("TARGET");

if (!schemaPath) {
  throw new Error("SCHEMA_PATH is required");
}
if (!target) {
  throw new Error("TARGET is required");
}

try {
  const content = await loadDeclarativeSchema(schemaPath);
  if (content.length === 0) {
    console.log(JSON.stringify({ status: "success", totalStatements: 0 }));
  } else {
    const result = await applyDeclarativeSchema({
      content,
      targetUrl: target,
    });
    const apply = result?.apply;
    if (!apply) {
      throw new Error("pg-delta apply returned no result");
    }
    const payload = {
      status: apply.status,
      totalStatements: result.totalStatements ?? 0,
      totalRounds: apply.totalRounds ?? 0,
      totalApplied: apply.totalApplied ?? 0,
      totalSkipped: apply.totalSkipped ?? 0,
      errors: apply.errors ?? [],
      stuckStatements: apply.stuckStatements ?? [],
    };
    console.log(JSON.stringify(payload));
    if (apply.status !== "success") {
      throw new Error("pg-delta apply failed with status: " + apply.status);
    }
  }
} catch (e) {
  throw e instanceof Error ? e : new Error(String(e));
}
