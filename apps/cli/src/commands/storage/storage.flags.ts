import { targetFlags } from "../../command-internal/target/target-flags.ts";

export const storageTargetFlags = targetFlags({
  group: "selectable",
  subject: "Storage API",
  dbUrl: false,
});
