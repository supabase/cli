import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * `--remote <name>` (or `SUPABASE_REMOTE=<name>`) named an entry absent from
 * the project's `[remotes.*]` registry. `registryPath` names the config file
 * that was searched; `empty` distinguishes "the registry has no entries at
 * all" from "the registry has entries, just not this one".
 */
export class UnknownRemoteError extends Data.TaggedError("UnknownRemoteError")<{
  readonly name: string;
  readonly registryPath: string;
  readonly empty: boolean;
}> {
  override get message(): string {
    return this.empty
      ? `No remotes are configured in ${this.registryPath}. Add one with \`supabase remotes add ${this.name} --project-ref <ref>\`.`
      : `Unknown remote "${this.name}" in ${this.registryPath}. Add it with \`supabase remotes add ${this.name} --project-ref <ref>\`.`;
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--remote`/`SUPABASE_REMOTE` and `--project-ref`were both explicitly given
 * there is no defined precedence between two explicit ref sources,
 * so this is a hard error rather than one silently winning.
 */
export class RemoteFlagConflictError extends Data.TaggedError("RemoteFlagConflictError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `supabase/config.{toml,json}` doesn't exist — `remotes *` never creates one. */
export class NoProjectConfigError extends Data.TaggedError("NoProjectConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
