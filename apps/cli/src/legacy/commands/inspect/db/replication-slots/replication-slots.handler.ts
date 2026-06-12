import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyReplicationSlotsSpec } from "./replication-slots.query.ts";

export const legacyInspectDbReplicationSlots = legacyMakeInspectDbHandler(
  legacyReplicationSlotsSpec,
  "legacy.inspect.db.replication-slots",
);
