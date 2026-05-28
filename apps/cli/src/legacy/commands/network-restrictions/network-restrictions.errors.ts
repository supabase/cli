import { Data } from "effect";

export class LegacyNetworkRestrictionsGetNetworkError extends Data.TaggedError(
  "LegacyNetworkRestrictionsGetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyNetworkRestrictionsGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkRestrictionsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyNetworkRestrictionsUpdateNetworkError extends Data.TaggedError(
  "LegacyNetworkRestrictionsUpdateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyNetworkRestrictionsUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkRestrictionsUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyNetworkRestrictionsInvalidCidrError extends Data.TaggedError(
  "LegacyNetworkRestrictionsInvalidCidrError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    // Verbatim Go string from `apps/cli-go/internal/restrictions/update/update.go:23`.
    super({ input: args.input, message: `failed to parse IP: ${args.input}` });
  }
}

export class LegacyNetworkRestrictionsPrivateIpError extends Data.TaggedError(
  "LegacyNetworkRestrictionsPrivateIpError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    // Verbatim Go string from `apps/cli-go/internal/restrictions/update/update.go:26`.
    super({ input: args.input, message: `private IP provided: ${args.input}` });
  }
}
