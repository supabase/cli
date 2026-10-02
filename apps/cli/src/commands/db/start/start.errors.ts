import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** `--from-backup` restore is Compose-only; stack `db start` has no restore path. */
export class DbStartFromBackupUnsupportedError extends Data.TaggedError(
  "DbStartFromBackupUnsupportedError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
