import {
  type Catalog,
  createManagedPool,
  createPlan,
  extractCatalog,
  renderPlanFiles,
  type RenderedPlanFile,
} from "@supabase/pg-delta";

/** Extract a full catalog snapshot over TCP (pg-delta runs on the host). */
export const snapshotCatalog = async (url: string): Promise<Catalog> => {
  const { pool, close } = await createManagedPool(url);
  try {
    return await extractCatalog(pool);
  } finally {
    await close();
  }
};

/**
 * Diff two snapshots into ordered, execution-aware SQL files. No integration
 * filter: unlike user-schema diffing, the whole point here is to capture the
 * platform schemas the service's migrations produce. Grants stay explicit
 * (`skipDefaultPrivilegeSubtraction`) so replay order doesn't matter.
 */
export const planBundleFiles = async (
  source: Catalog,
  target: Catalog,
): Promise<ReadonlyArray<RenderedPlanFile>> => {
  const result = await createPlan(source, target, { skipDefaultPrivilegeSubtraction: true });
  if (result === null) {
    return [];
  }
  return renderPlanFiles(result.plan, {
    includeTransactions: false,
    sqlFormatOptions: { maxWidth: 180, keywordCase: "upper" },
  });
};

/** True when two snapshots are identical (used by the zero-diff verification). */
export const isZeroDiff = async (source: Catalog, target: Catalog): Promise<boolean> => {
  const result = await createPlan(source, target, { skipDefaultPrivilegeSubtraction: true });
  return result === null || result.plan.units.length === 0;
};
