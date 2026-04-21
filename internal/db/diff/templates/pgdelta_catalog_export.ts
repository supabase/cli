// This script serializes a database catalog for caching/reuse in declarative
// sync workflows, so later diff/export operations can run from file references.
import {
  createManagedPool,
  extractCatalog,
  serializeCatalog,
  stringifyCatalogSnapshot,
} from "npm:@supabase/pg-delta@1.0.0-alpha.17";

const target = Deno.env.get("TARGET");
const role = Deno.env.get("ROLE") ?? undefined;

if (!target) {
  console.error("TARGET is required");
  throw new Error("");
}
const { pool, close } = await createManagedPool(target, { role });

try {
  const catalog = await extractCatalog(pool);
  console.log(stringifyCatalogSnapshot(serializeCatalog(catalog)));
} catch (e) {
  console.error(e);
  throw new Error("");
} finally {
  await close();
}
