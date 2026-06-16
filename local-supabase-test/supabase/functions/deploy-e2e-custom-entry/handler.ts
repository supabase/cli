Deno.serve(() =>
  Response.json({ case: "deploy-e2e-custom-entry", ok: true, entry: "handler.ts" })
);
