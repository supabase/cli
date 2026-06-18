import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve((req) =>
  Response.json({ case: "deploy-e2e-jsr", ok: true, method: req.method })
);
