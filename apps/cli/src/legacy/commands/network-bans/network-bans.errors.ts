import { Data } from "effect";

export class LegacyNetworkBansGetNetworkError extends Data.TaggedError(
  "LegacyNetworkBansGetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyNetworkBansGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkBansGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyNetworkBansRemoveNetworkError extends Data.TaggedError(
  "LegacyNetworkBansRemoveNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyNetworkBansRemoveUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkBansRemoveUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyNetworkBansEnvNotSupportedError extends Data.TaggedError(
  "LegacyNetworkBansEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

export class LegacyNetworkBansInvalidIpError extends Data.TaggedError(
  "LegacyNetworkBansInvalidIpError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({ input: args.input, message: `invalid IP address: ${args.input}` });
  }
}
