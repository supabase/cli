import { Effect } from "effect";
import {
  SchemaAllowRemoteRequiredError,
  SchemaCancelledError,
  SchemaDestructiveAuthError,
  SchemaProjectRefMismatchError,
} from "../schema/schema-errors.ts";
import { envDatabaseUrlVarName, type DatabaseTarget } from "./database-target.ts";
import { Output } from "../output/output.service.ts";

export type MutationAuthFlags = {
  readonly yes: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
};

export const authorizeMutation = Effect.fnUntraced(function* (input: {
  readonly target: DatabaseTarget;
  readonly flags: MutationAuthFlags;
  readonly command: string;
}) {
  const { target, flags, command } = input;

  if (target.disposable) {
    return;
  }

  if (target.kind === "url") {
    if (!flags.allowRemote) {
      const envVar = target.connectionSource === "env" ? envDatabaseUrlVarName() : undefined;
      return yield* new SchemaAllowRemoteRequiredError({
        detail:
          envVar !== undefined
            ? `This connection string cannot be identity-verified because ${envVar} is set.`
            : "This connection string cannot be identity-verified.",
        suggestion:
          envVar !== undefined
            ? `Unset ${envVar} to use the linked project connection, or re-run ${command} with --allow-remote if this URL is the intended durable target.`
            : `Re-run ${command} with --allow-remote to acknowledge the unverifiable target.`,
      });
    }
    return;
  }

  const resolvedRef = target.projectRef;
  if (resolvedRef === undefined) {
    return yield* new SchemaProjectRefMismatchError({
      detail: "Durable target is missing a project ref.",
      suggestion: "Link the project or pass --project-ref <ref>.",
    });
  }

  if (flags.projectRef !== undefined) {
    if (flags.projectRef !== resolvedRef) {
      return yield* new SchemaProjectRefMismatchError({
        detail: `--project-ref ${flags.projectRef} does not match resolved target ${resolvedRef}.`,
        suggestion: `Pass --project-ref ${resolvedRef}.`,
      });
    }
    return;
  }

  const output = yield* Output;
  if (output.interactive) {
    const typed = yield* output.promptText(`Type the project ref (${resolvedRef}) to continue`);
    if (typed.trim() !== resolvedRef) {
      return yield* new SchemaCancelledError({
        detail: "Project ref confirmation did not match.",
        suggestion: `Type ${resolvedRef} exactly, or pass --project-ref ${resolvedRef}.`,
      });
    }
    return;
  }

  if (!flags.yes) {
    return yield* new SchemaDestructiveAuthError({
      detail: "Non-interactive mutation of a durable target requires confirmation.",
      suggestion: "Pass --yes, or pass --project-ref to assert the target identity.",
    });
  }
});
