// Hoisted to `next/config/resolve-project-ref.ts` so `link`'s own ref
// resolution can share the same `--remote` seam — re-exported here so
// existing `functions deploy/delete/download` imports are unaffected.
export { resolveProjectRef } from "../../config/resolve-project-ref.ts";
