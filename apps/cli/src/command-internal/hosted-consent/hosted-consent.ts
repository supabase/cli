import { Effect, Option } from "effect";

import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { isMachineResourceFormat } from "../../shared/output/resource-format.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import type { ResolvedDbConfig } from "../db-config.types.ts";
import { OutputFlag, resolveYes } from "../global-flags.ts";
import type { ResolvedTarget } from "../target/resolve-target.ts";
import { TargetPolicy } from "../target/target-policy.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "./hosted-consent.errors.ts";
import type { HostedMutationConsent } from "./hosted-consent.token.ts";

export interface HostedMutationRequest {
  /** What is about to change, phrased to follow "Confirmed by --yes:". */
  readonly action: string;
  /** Plan lines printed before the question. */
  readonly details?: ReadonlyArray<string>;
  /** Asks for `expected` to be typed instead of a yes/no answer. */
  readonly confirm?: { readonly kind: "typed"; readonly expected: string };
}

// The brand is type-only, so minting a token needs this one assertion.
const grant = (action: string, via: HostedMutationConsent["via"]): HostedMutationConsent =>
  ({ action, via }) as HostedMutationConsent;

const announcedTargetSuffix = Effect.serviceOption(CommandTarget).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(""),
      onSome: (cell) =>
        Effect.map(cell.text, Option.match({ onNone: () => "", onSome: (text) => ` on ${text}` })),
    }),
  ),
);

const consentRequired = (request: HostedMutationRequest, onTarget: string) =>
  new HostedMutationConsentRequiredError({
    message: `${request.action}${onTarget} needs confirmation, and this run can't prompt. Nothing was changed.`,
    suggestion: `Re-run with --yes to confirm ${request.action}, or run it in an interactive terminal.`,
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
 * Grants consent for a hosted mutation or fails. `--yes` or a shell `SUPABASE_YES` (never the
 * project `.env`) grants it; otherwise only an interactive text-mode terminal is asked. Stdin is
 * never read, so a piped answer does not count.
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
  const tty = yield* Tty;
  const outputFlag = yield* OutputFlag;
  const onTarget = yield* announcedTargetSuffix;

  if (yield* resolveYes) {
    yield* output.raw(`Confirmed by --yes: ${request.action}${onTarget}\n`, "stderr");
    yield* Effect.annotateCurrentSpan("consent.via", "yes");
    return grant(request.action, "yes");
  }

  const canPrompt =
    output.format === "text" &&
    output.interactive &&
    tty.stdinIsTty &&
    !isMachineResourceFormat(outputFlag);
  if (!canPrompt) return yield* consentRequired(request, onTarget);

  const confirmed = yield* ask(request, policy.consent === "yes", onTarget).pipe(
    Effect.catchTag("NonInteractiveError", () => consentRequired(request, onTarget)),
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
export const hostedMutationPreapproval = Effect.map(resolveYes, (yes) =>
  yes ? Option.some(grant("remove network bans", "yes")) : Option.none<HostedMutationConsent>(),
);
