import { Data } from "effect";

export class LegacyGenTanstackDbNetworkError extends Data.TaggedError(
  "LegacyGenTanstackDbNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyGenTanstackDbUnexpectedStatusError extends Data.TaggedError(
  "LegacyGenTanstackDbUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyGenTanstackDbDecodeError extends Data.TaggedError(
  "LegacyGenTanstackDbDecodeError",
)<{
  readonly message: string;
}> {}

export class LegacyGenTanstackDbLocalStackNotRunningError extends Data.TaggedError(
  "LegacyGenTanstackDbLocalStackNotRunningError",
)<{
  readonly message: string;
}> {}

export class LegacyGenTanstackDbNoTablesError extends Data.TaggedError(
  "LegacyGenTanstackDbNoTablesError",
)<{
  readonly message: string;
}> {}

export class LegacyGenTanstackDbUnsafeNameError extends Data.TaggedError(
  "LegacyGenTanstackDbUnsafeNameError",
)<{
  readonly message: string;
}> {}

export class LegacyGenTanstackDbNoPrimaryKeyError extends Data.TaggedError(
  "LegacyGenTanstackDbNoPrimaryKeyError",
)<{
  readonly message: string;
}> {}
