import { storagePermissions } from "../../command-internal/storage-permissions.ts";
import { targetFlags } from "../../command-internal/target/target-flags.ts";

export const storageTargetFlags = targetFlags({ subject: "Storage API", dbUrl: false });

export const STORAGE_PERMISSIONS = storagePermissions(["recursive"]);
