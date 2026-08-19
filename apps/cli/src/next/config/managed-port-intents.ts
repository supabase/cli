import type { LoadedProjectConfig } from "@supabase/config";
import { PORT_CATALOG, PORT_FIELDS, portFieldsForConfigInput } from "@supabase/stack/effect";

/**
 * Preserve the raw project document alongside the resolved stack config so
 * explicit sticky ports remain distinct from omitted automatic ports.
 */
export const managedPortIntents = (
  stackConfig: Parameters<typeof portFieldsForConfigInput>[0],
  loadedProjectConfig: Pick<LoadedProjectConfig, "document"> | undefined,
) => {
  const activeFields = portFieldsForConfigInput(stackConfig);
  const disabledFields = PORT_FIELDS.filter(
    (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFields.includes(field),
  );
  return {
    activeFields,
    disabledFields,
    document: loadedProjectConfig?.document ?? {},
  };
};
