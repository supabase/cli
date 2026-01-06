import { createPlan } from "npm:@supabase/pg-delta@1.0.0-alpha.1";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.1/integrations/supabase";

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

try {
  const result = await createPlan(source, target, supabase);
  const statements = result?.plan.statements ?? [];
  for (const sql of statements) {
    console.log(`${sql};`);
  }
} catch (e) {
  console.error(e);
}
