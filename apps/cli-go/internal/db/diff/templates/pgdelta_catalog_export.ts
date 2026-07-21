// This script serializes a database catalog for caching/reuse in declarative
// sync workflows, so later diff/export operations can run from file references.
import {
  createManagedPool,
  extractCatalog,
  serializeCatalog,
  stringifyCatalogSnapshot,
} from "npm:@supabase/pg-delta@1.0.0-alpha.20";

const target = Deno.env.get("TARGET");
const role = Deno.env.get("ROLE") ?? undefined;

if (!target) {
  console.error("TARGET is required");
  // Emit a sentinel so the CLI runner treats this as a real script crash rather
  // than a successful empty catalog, even though the forced-exit non-zero code is
  // suppressed by the "main worker has been destroyed" handling.
  console.error("PGDELTA_SCRIPT_ERROR");
  throw new Error("");
}
const { pool, close } = await createManagedPool(target, { role });

try {
  const catalog = await extractCatalog(pool);
  console.log(stringifyCatalogSnapshot(serializeCatalog(catalog)));
} catch (e) {
  console.error(e);
  // Emit a sentinel so the CLI runner can distinguish a real script crash from a
  // successful empty catalog, even though the forced-exit non-zero code below is
  // suppressed by the "main worker has been destroyed" handling.
  console.error("PGDELTA_SCRIPT_ERROR");
  // Force close event loop
  throw new Error("");
} finally {
  await close();
}
// Force close the event loop on the success path too. The connection pool can
// leave keepalive handles registered even after close() resolves, which keeps
// the Edge Runtime worker (and therefore the container) alive after the catalog
// has already been written to stdout. The CLI streams this container's logs with
// Follow:true, so a worker that never exits hangs the parent `__catalog`
// subprocess — and the declarative-sync command that spawned it — indefinitely
// at 0% CPU (supabase/pg-toolbelt#312).
throw new Error("");
