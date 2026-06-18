import { greet } from "../_shared/greet.ts";
import { suffix } from "./helpers.ts";

Deno.serve(() =>
  Response.json({ case: "deploy-e2e-local-imports", ok: true, message: greet() + suffix })
);
