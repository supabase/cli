import { Effect } from "effect";
import {
  SchemaAllowRemoteRequiredError,
  SchemaCancelledError,
  SchemaDestructiveAuthError,
  SchemaProjectRefMismatchError,
} from "../schema/schema-errors.ts";
import type { DatabaseTarget } from "./database-target.ts";
import { Output } from "../output/output.service.ts";

export type DestructiveAuthFlags = {
  readonly yes: boolean;
  readonly allowDataLoss: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
};

export const authorizeMutation = Effect.fnUntraced(function* (input: {
  readonly target: DatabaseTarget;
  readonly destructive: boolean;
  readonly flags: DestructiveAuthFlags;
  readonly command: string;
}) {
  const { target, destructive, flags, command } = input;

  if (target.disposable) {
    return;
  }

  if (destructive && !flags.allowDataLoss) {
    return yield* new SchemaDestructiveAuthError({
      detail: "This plan contains destructive actions.",
      suggestion: `Re-run with --allow-data-loss. --yes never authorizes data loss.`,
    });
  }

  if (!target.connectionVerified) {
    if (!flags.allowRemote) {
      return yield* new SchemaAllowRemoteRequiredError({
        detail: "This connection string cannot be identity-verified.",
        suggestion: `Re-run ${command} with --allow-remote to acknowledge the unverifiable target.`,
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

  if (destructive) {
    return yield* new SchemaProjectRefMismatchError({
      detail: `Non-interactive destructive mutation of ${resolvedRef} requires an explicit identity assertion.`,
      suggestion: `Pass --project-ref ${resolvedRef}.`,
    });
  }

  if (!flags.yes) {
    return yield* new SchemaDestructiveAuthError({
      detail: "Non-interactive mutation of a durable target requires confirmation.",
      suggestion:
        "Pass --yes for ordinary confirmation. Destructive plans also need --allow-data-loss and --project-ref.",
    });
  }
});
