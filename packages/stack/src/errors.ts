import { Data } from "effect";

export class BinaryNotFoundError extends Data.TaggedError("BinaryNotFoundError")<{
  readonly service: string;
  readonly platform: string;
}> {}

export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

export class ChecksumMismatchError extends Data.TaggedError("ChecksumMismatchError")<{
  readonly url: string;
  readonly expected: string;
  readonly actual: string;
}> {}

export class DockerPullError extends Data.TaggedError("DockerPullError")<{
  readonly image: string;
  readonly cause: unknown;
}> {}

export class StackBuildError extends Data.TaggedError("StackBuildError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class PortConflictError extends Data.TaggedError("PortConflictError")<{
  readonly port: number;
  readonly service: string;
}> {}

export class StackError extends Error {
  readonly code: string;
  constructor(opts: { code: string; message: string; cause?: unknown }) {
    super(opts.message, { cause: opts.cause });
    this.code = opts.code;
    this.name = "StackError";
  }
}

export function toStackError(err: unknown): StackError {
  if (err instanceof StackError) return err;
  if (err != null && typeof err === "object" && "_tag" in err) {
    const tagged = err as { _tag: string; message?: string };
    switch (tagged._tag) {
      case "ServiceNotFoundError":
        return new StackError({
          code: "SERVICE_NOT_FOUND",
          message: String(tagged.message ?? err),
        });
      case "StackBuildError":
        return new StackError({
          code: "BUILD_ERROR",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "BinaryNotFoundError":
        return new StackError({
          code: "BINARY_NOT_FOUND",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "DownloadError":
        return new StackError({
          code: "DOWNLOAD_ERROR",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "DockerPullError":
        return new StackError({
          code: "DOCKER_PULL_ERROR",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "PortConflictError":
        return new StackError({
          code: "PORT_CONFLICT",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "PortAllocationError":
        return new StackError({
          code: "PORT_ALLOCATION",
          message: String(tagged.message ?? err),
          cause: err,
        });
      case "ServiceReadyError":
        return new StackError({
          code: "SERVICE_NOT_READY",
          message: String(tagged.message ?? err),
          cause: err,
        });
      default:
        return new StackError({
          code: tagged._tag,
          message: String(tagged.message ?? err),
          cause: err,
        });
    }
  }
  if (err instanceof Error) {
    return new StackError({ code: "UNKNOWN", message: err.message, cause: err });
  }
  return new StackError({ code: "UNKNOWN", message: String(err) });
}
