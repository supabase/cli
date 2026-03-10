import {
  createPlan,
  deserializeCatalog,
} from "npm:@supabase/pg-delta@1.0.0-alpha.7";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.7/integrations/supabase";

async function resolveInput(ref: string | undefined) {
  if (
    !ref ||
    ref.startsWith("postgres://") ||
    ref.startsWith("postgresql://")
  ) {
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

try {
  const result = await createPlan(
    await resolveInput(source),
    await resolveInput(target),
    supabase,
  );
  const statements = result?.plan.statements ?? [];
  for (const sql of statements) {
    console.log(`${sql};`);
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
