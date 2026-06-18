import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(() => {
  const client = createClient("https://example.supabase.co", "anon-key");
  return Response.json({
    case: "deploy-e2e-npm",
    ok: true,
    hasClient: typeof client.from === "function",
  });
});
