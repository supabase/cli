import { Data } from "effect";

export class LegacyPostgresConfigGetNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigGetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyPostgresConfigGetUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigGetUnmarshalError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigUpdateNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyPostgresConfigUpdateUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateUnmarshalError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigUpdateSerializeError extends Data.TaggedError(
  "LegacyPostgresConfigUpdateSerializeError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigDeleteNetworkError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyPostgresConfigDeleteUnmarshalError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteUnmarshalError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigDeleteSerializeError extends Data.TaggedError(
  "LegacyPostgresConfigDeleteSerializeError",
)<{
  readonly message: string;
}> {}

export class LegacyPostgresConfigInvalidConfigValueError extends Data.TaggedError(
  "LegacyPostgresConfigInvalidConfigValueError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({
      input: args.input,
      message: `expected config value in key:value format, received: '${args.input}'`,
    });
  }
}
