import { Effect, Option } from "effect";

import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import type { ResolvedDbConfig } from "../db-config.types.ts";
import type { ResolvedTarget } from "../target/resolve-target.ts";
import { TargetPolicy } from "../target/target-policy.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "./hosted-consent.errors.ts";
import { promptBlocker } from "./hosted-consent.prompt.ts";
import type { PromptBlocker } from "./hosted-consent.prompt.ts";
import type { HostedMutationConsent } from "./hosted-consent.token.ts";
import { ignoredYesFiles, resolveHostedYes } from "./hosted-consent.yes.ts";

export interface HostedMutationRequest {
  /** An imperative, sentence-case phrase with no trailing period, such as "Apply 3 migrations". */
  readonly action: string;
  /** Plan lines printed before the question. */
  readonly details?: ReadonlyArray<string>;
  /** Asks for `expected` to be typed instead of a yes/no answer. */
  readonly confirm?: { readonly kind: "typed"; readonly expected: string };
  /** The command has a `--read-only` mode that needs no confirmation. */
  readonly readOnlyAlternative?: boolean;
}

// The brand is type-only, so minting a token needs this one assertion.
const grant = (action: string, via: HostedMutationConsent["via"]): HostedMutationConsent =>
  ({ action, via }) as HostedMutationConsent;

/** The first announced target's banner text, or `None` before any announcement. */
export const announcedTarget = Effect.serviceOption(CommandTarget).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (cell) => cell.text,
    }),
  ),
);

const consentRequired = Effect.fnUntraced(function* (
  request: HostedMutationRequest,
  target: Option.Option<string>,
  blocker: PromptBlocker,
) {
  const ignored = yield* ignoredYesFiles;
  const suggestions = [
    blocker.agent
      ? "This is an agent run: ask the user before re-running with --yes."
      : "Re-run with --yes to confirm.",
    ...(request.readOnlyAlternative === true
      ? ["For a read-only statement, pass --read-only instead."]
      : []),
    ...(ignored.length > 0
      ? [`SUPABASE_YES in ${ignored.join(", ")} does not confirm hosted changes; pass --yes.`]
      : []),
  ];
  const where = Option.match(target, { onNone: () => "", onSome: (text) => ` (target: ${text})` });
  return yield* new HostedMutationConsentRequiredError({
    message: `Confirmation required: ${request.action}${where}. This run can't ask because ${blocker.reason}. Nothing was changed.`,
    suggestion: suggestions.join(" "),
  });
});

const ask = Effect.fnUntraced(function* (
  request: HostedMutationRequest,
  defaultValue: boolean,
  onTarget: string,
) {
  const output = yield* Output;
  if (request.details !== undefined && request.details.length > 0) {
    yield* output.raw(`${request.details.join("\n")}\n`, "stderr");
  }
  if (request.confirm === undefined) {
    return yield* output.promptConfirm(`${request.action}${onTarget}?`, { defaultValue });
  }
  yield* output.raw(`${request.action}${onTarget}\n`, "stderr");
  const typed = yield* output.promptText(`Type ${request.confirm.expected} to confirm`);
  return typed.trim() === request.confirm.expected;
});

/**
 * Grants consent for a hosted mutation or fails. `--yes` or a shell `SUPABASE_YES` (never a dotenv
 * file) grants it; otherwise only an interactive text-mode terminal with no agent driving it is
 * asked. Stdin is never read, so a piped answer does not count.
 */
export const requireHostedMutationConsent = Effect.fn("HostedConsent.require")(function* (
  request: HostedMutationRequest,
) {
  const policy = yield* TargetPolicy;
  if (policy.consent === "none") {
    return yield* Effect.die(
      new Error(
        `requireHostedMutationConsent needs a target policy with consent "yes" or "no"; "${policy.group}" declares "none"`,
      ),
    );
  }
  const output = yield* Output;
  const target = yield* announcedTarget;
  const onTarget = Option.match(target, { onNone: () => "", onSome: (text) => ` on ${text}` });

  const approvedBy = yield* resolveHostedYes;
  if (Option.isSome(approvedBy)) {
    yield* output.raw(`Confirmed by ${approvedBy.value}: ${request.action}${onTarget}\n`, "stderr");
    yield* Effect.annotateCurrentSpan("consent.via", "yes");
    return grant(request.action, "yes");
  }

  const blocker = yield* promptBlocker;
  if (Option.isSome(blocker)) return yield* consentRequired(request, target, blocker.value);

  const confirmed = yield* ask(request, policy.consent === "yes", onTarget).pipe(
    Effect.catchTag("NonInteractiveError", () =>
      consentRequired(request, target, { reason: "no prompt is available", agent: false }),
    ),
  );
  if (!confirmed) {
    return yield* new HostedMutationDeclinedError({ message: CONTEXT_CANCELED_MESSAGE });
  }
  yield* Effect.annotateCurrentSpan("consent.via", "prompt");
  return grant(request.action, "prompt");
});

/** `None` for a local target (a local `ResolvedTarget` or a connection with `isLocal`); otherwise {@link requireHostedMutationConsent}. */
export const requireTargetMutationConsent = Effect.fn("HostedConsent.requireForTarget")(function* (
  target: ResolvedTarget | ResolvedDbConfig,
  request: HostedMutationRequest,
) {
  const isLocal = "isLocal" in target ? target.isLocal : target.kind === "local";
  if (isLocal) return Option.none<HostedMutationConsent>();
  return Option.some(yield* requireHostedMutationConsent(request));
});

/** `Some` only under `--yes` or a shell `SUPABASE_YES`; never prompts, so a read can hand it to a connection that may clear a network ban. */
export const hostedMutationPreapproval = Effect.map(resolveHostedYes, (approvedBy) =>
  Option.isSome(approvedBy)
    ? Option.some(grant("Remove network bans", "yes"))
    : Option.none<HostedMutationConsent>(),
);
