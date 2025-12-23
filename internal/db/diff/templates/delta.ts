import { main } from "npm:@supabase/pg-delta@1.0.0-alpha.0";
import { supabase } from "npm:@supabase/integrations";

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const { migrationScript } = await main(source, target, supabase)
console.log(migrationScript)
