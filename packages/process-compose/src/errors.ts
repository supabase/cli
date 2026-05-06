import { Data } from "effect";

export class CyclicDependencyError extends Data.TaggedError("CyclicDependencyError")<{
  readonly cycle: string;
}> {}

export class MissingDependencyError extends Data.TaggedError("MissingDependencyError")<{
  readonly service: string;
  readonly dependency: string;
}> {}

export class ServiceNotFoundError extends Data.TaggedError("ServiceNotFoundError")<{
  readonly name: string;
}> {}

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly service: string;
  readonly cause: unknown;
}> {}

export class ShutdownTimeoutError extends Data.TaggedError("ShutdownTimeoutError")<{
  readonly service: string;
}> {}

export class ServiceReadyError extends Data.TaggedError("ServiceReadyError")<{
  readonly name: string;
  readonly reason: string;
  readonly exitCode?: number;
}> {}
