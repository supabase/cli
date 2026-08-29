import type { LoadedCliConfig } from "@supabase/config";
import { PORT_CATALOG, PORT_FIELDS, portFieldsForConfigInput } from "@supabase/stack/effect";

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * The CLI's public config still calls the selected pooler listener `port`.
 * The stack catalog splits that listener by pool mode, so project documents
 * need a derived key before the managed port planner resolves its intents.
 */
const withPoolerPortIntent = (document: Readonly<Record<string, unknown>>) => {
  const db = document.db;
  if (!isRecord(db)) return document;
  const pooler = db.pooler;
  if (!isRecord(pooler) || !hasOwn(pooler, "port") || typeof pooler.port !== "number") {
    return document;
  }

  const key = pooler.pool_mode === "session" ? "session_port" : "transaction_port";
  return {
    ...document,
    db: {
      ...db,
      pooler: {
        ...pooler,
        [key]: pooler.port,
      },
    },
  };
};

/**
 * Preserve the raw project document alongside the resolved stack config so
 * explicit sticky ports remain distinct from omitted automatic ports.
 */
export const managedPortIntents = (
  stackConfig: Parameters<typeof portFieldsForConfigInput>[0],
  loadedCliConfig: Pick<LoadedCliConfig, "document"> | undefined,
) => {
  const activeFields = portFieldsForConfigInput(stackConfig);
  const disabledFields = PORT_FIELDS.filter(
    (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFields.includes(field),
  );
  const document = withPoolerPortIntent(loadedCliConfig?.document ?? {});
  return {
    activeFields,
    disabledFields,
    document,
  };
};
