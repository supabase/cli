import {
  createPlan,
  deserializeCatalog,
  formatSqlStatements,
} from "npm:@supabase/pg-delta@1.0.0-alpha.8";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.8/integrations/supabase";

async function resolveInput(ref: string | undefined) {
  if (!ref) {
    return null;
  }
  if (ref.startsWith("postgres://") || ref.startsWith("postgresql://")) {
    return ref;
  }
  const json = await Deno.readTextFile(ref);
  return deserializeCatalog(JSON.parse(json));
}

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");
if (includedSchemas) {
  supabase.filter = { schema: includedSchemas.split(",") };
}

const formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");
let formatOptions = undefined;
if (formatOptionsRaw) {
  formatOptions = JSON.parse(formatOptionsRaw);
}

try {
  const result = await createPlan(
    await resolveInput(source),
    await resolveInput(target),
    supabase,
  );
  let statements = result?.plan.statements ?? [];
  if (formatOptions != null) {
    statements = formatSqlStatements(statements, formatOptions);
  }
  for (const sql of statements) {
    console.log(`${sql};\n`);
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
