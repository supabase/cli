// This script applies declarative schema files to a target database and emits
// structured JSON so the Go caller can report success/failure deterministically.
import {
  applyDeclarativeSchema,
  loadDeclarativeSchema,
} from "npm:@supabase/pg-delta@1.0.0-alpha.7/declarative";

const schemaPath = Deno.env.get("SCHEMA_PATH");
const target = Deno.env.get("TARGET");

if (!schemaPath) {
  console.error("SCHEMA_PATH is required");
  throw new Error("");
}
if (!target) {
  console.error("TARGET is required");
  throw new Error("");
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
    console.log(
      JSON.stringify(
        {
          status: result.apply.status,
          totalStatements: result.totalStatements,
          totalRounds: result.apply.totalRounds,
          totalApplied: result.apply.totalApplied,
          totalSkipped: result.apply.totalSkipped,
          errors: result.apply.errors ?? [],
          stuckStatements: result.apply.stuckStatements ?? [],
        },
        (_key, value) => (typeof value === "bigint" ? Number(value) : value),
      ),
    );
    if (result.apply.status !== "success") {
      throw new Error("");
    }
  }
} catch (e) {
  if (e instanceof Error && e.message === "") {
    throw e;
  }
  console.error(e);
  throw new Error("");
}
