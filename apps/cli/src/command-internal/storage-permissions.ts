import { linkedProjectCache } from "../telemetry/linked-project-cache.layer.ts";
import { compose, withCondition } from "./command-permissions/model.ts";
import { storageCredentials } from "./storage-credentials.ts";
import { branchResolution } from "./target/branch-resolution.ts";

/** The Management API calls a Storage-API command makes on the linked project. */
export const storagePermissions = (noApiEffectFlags: ReadonlyArray<string>) =>
  compose(
    { operations: [], noApiEffectFlags },
    withCondition(compose(storageCredentials, linkedProjectCache), { dbTarget: ["linked"] }),
    branchResolution,
  );
