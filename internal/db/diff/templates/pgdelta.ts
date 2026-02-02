import { createPlan } from "npm:@supabase/pg-delta@1.0.0-alpha.2";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.2/integrations/supabase";

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");
if (includedSchemas) {
  supabase.filter = { schema: includedSchemas.split(",") };
}
supabase.role = "postgres";

try {
  const result = await createPlan(source, target, supabase);
  const statements = result?.plan.statements ?? [];
  for (const sql of statements) {
    console.log(`${sql};`);
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
