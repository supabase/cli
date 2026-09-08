import { makeInspectDbHandler } from "../inspect-query.ts";
import { replicationSlotsSpec } from "./replication-slots.query.ts";

export const inspectDbReplicationSlots = makeInspectDbHandler(
  replicationSlotsSpec,
  "inspect.db.replication-slots",
);
