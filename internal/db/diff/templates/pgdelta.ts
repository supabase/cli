import { createPlan } from "npm:@supabase/pg-delta@1.0.0-alpha.3";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.3/integrations/supabase";

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const opts = { ...supabase, role: "postgres" };
const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");
if (includedSchemas) {
  opts.filter = { schema: includedSchemas.split(",") };
}

const result = await createPlan(source, target, opts);
const statements = result?.plan.statements ?? [];
for (const sql of statements) {
  console.log(`${sql};`);
}
