import {
  compose,
  withCondition,
  withDbTarget,
} from "../../command-internal/command-permissions/model.ts";
import { storageCredentials } from "../../command-internal/storage-credentials.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../command-internal/target/target-flags.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";

export const storageTargetFlags = targetFlags({ subject: "Storage API", dbUrl: false });

/** The Management API calls every `storage` subcommand makes on the linked project. */
export const STORAGE_PERMISSIONS = withDbTarget(
  compose(
    { operations: [], noApiEffectFlags: ["recursive"] },
    withCondition(compose(storageCredentials, linkedProjectCache), { dbTarget: ["linked"] }),
    branchResolution,
  ),
  { default: "local" },
);
