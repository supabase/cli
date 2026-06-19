import { greet } from "@root/greet.ts";

Deno.serve(() =>
  Response.json({ case: "deploy-e2e-root-map", ok: true, message: greet() })
);
