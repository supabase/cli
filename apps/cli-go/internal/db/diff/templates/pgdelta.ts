import {
  createPlan,
  deserializeCatalog,
  formatSqlStatements,
} from "npm:@supabase/pg-delta@1.0.0-alpha.25";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.25/integrations/supabase";

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
  const schemas = includedSchemas.split(",");
  const schemaFilter = {
    or: [{ "*/schema": schemas }, { "schema/name": schemas }],
  };
  // CompositionPattern `and` is valid FilterDSL; Deno's structural typing is strict on `or` branches.
  supabase.filter = {
    and: [supabase.filter!, schemaFilter],
  } as typeof supabase.filter;
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
    {
      ...supabase,
      skipDefaultPrivilegeSubtraction: true,
    },
  );
  let statements = result?.plan.statements ?? [];
  if (formatOptions != null) {
    statements = formatSqlStatements(statements, formatOptions);
  }
  if (Deno.env.get("PGDELTA_DEBUG")) {
    console.error(
      JSON.stringify({
        statementCount: statements.length,
        source: source ? "connected" : "null",
        target: target ? "connected" : "null",
        includedSchemas: includedSchemas ?? null,
        skipDefaultPrivilegeSubtraction: true,
      }),
    );
  }
  for (const sql of statements) {
    console.log(`${sql};`);
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
