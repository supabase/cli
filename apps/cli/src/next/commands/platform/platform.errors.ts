import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export class PlatformInputError extends Data.TaggedError("PlatformInputError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class PlatformMetadataError extends Data.TaggedError("PlatformMetadataError")<{
  readonly message: string;
  readonly detail?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

export class PlatformRouteNotFoundError extends Data.TaggedError("PlatformRouteNotFoundError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class PlatformMethodSelectionError extends Data.TaggedError("PlatformMethodSelectionError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
