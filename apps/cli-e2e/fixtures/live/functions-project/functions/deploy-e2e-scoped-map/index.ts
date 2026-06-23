import { greet } from "@shared/greet.ts";

Deno.serve(() =>
  Response.json({ case: "deploy-e2e-scoped-map", ok: true, message: greet() })
);
