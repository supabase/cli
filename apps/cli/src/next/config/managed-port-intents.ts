import type { LoadedProjectConfig } from "@supabase/config";
import { PORT_CATALOG, PORT_FIELDS, portFieldsForConfigInput } from "@supabase/stack/effect";

/**
 * Preserve the raw project document and value origins alongside the resolved
 * stack config. Managed startup uses these fields to distinguish an explicit
 * sticky port from an omitted (automatic) port across sibling worktrees.
 */
export const managedPortIntents = (
  stackConfig: Parameters<typeof portFieldsForConfigInput>[0],
  loadedProjectConfig: Pick<LoadedProjectConfig, "document" | "valueOrigins"> | undefined,
) => {
  const activeFields = portFieldsForConfigInput(stackConfig);
  const disabledFields = PORT_FIELDS.filter(
    (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFields.includes(field),
  );
  return {
    activeFields,
    disabledFields,
    document: loadedProjectConfig?.document ?? {},
    valueOrigins: loadedProjectConfig?.valueOrigins,
  };
};
