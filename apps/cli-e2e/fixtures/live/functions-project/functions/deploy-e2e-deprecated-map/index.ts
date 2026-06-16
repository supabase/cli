import { greet } from "@shared/greet.ts";

Deno.serve(() =>
  Response.json({ case: "deploy-e2e-deprecated-map", ok: true, message: greet() })
);
