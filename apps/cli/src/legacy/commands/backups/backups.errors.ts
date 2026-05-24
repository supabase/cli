import { Data } from "effect";

export class LegacyBackupListNetworkError extends Data.TaggedError("LegacyBackupListNetworkError")<{
  readonly message: string;
}> {}

export class LegacyBackupListUnexpectedStatusError extends Data.TaggedError(
  "LegacyBackupListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBackupRestoreNetworkError extends Data.TaggedError(
  "LegacyBackupRestoreNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBackupRestoreUnexpectedStatusError extends Data.TaggedError(
  "LegacyBackupRestoreUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
