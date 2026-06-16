import { greet } from "@shared/greet.ts";

Deno.serve(() =>
  Response.json({ case: "deploy-e2e-deno-jsonc", ok: true, message: greet() })
);
