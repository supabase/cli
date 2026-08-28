import { Crypto, Effect, Redacted } from "effect";
import { StackMustBeStoppedError, StackSecretMismatchError } from "../public/Errors.ts";
import type { DesiredStackLifecycle } from "../public/Status.ts";
import type { PersistedSecretValues } from "./StackState.ts";

export type SecretPolicy = "managed" | "passthrough";

export interface SecretDeclaration {
  readonly slot: string;
  readonly policy: SecretPolicy;
  readonly value?: Redacted.Redacted<unknown>;
}

export interface SecretCandidate {
  /** Complete pass-through declarations plus any managed slots supplied by the caller. */
  readonly declarations: ReadonlyArray<SecretDeclaration>;
}

export interface ResolvedSecrets {
  readonly persisted: PersistedSecretValues;
}

const secretMismatch = (slot: string, message: string) =>
  new StackSecretMismatchError({ slot, message });

const lifecycleChange = (slot?: string) =>
  new StackMustBeStoppedError({
    ...(slot === undefined ? {} : { slot }),
    message: "Pass-through secrets may only change while the stack is stopped",
  });

const readSecret = (value: Redacted.Redacted<unknown>): string => {
  const unredacted = Redacted.value(value);
  return typeof unredacted === "string" ? unredacted : String(unredacted);
};
const validSlot = (slot: string): boolean => /^[A-Za-z0-9_.:/-]+$/.test(slot);

/** Redacts known exact values without attempting to infer transformed/derived secrets. */
export const redactKnownSecrets = (message: string, known: Iterable<string>): string => {
  let result = message;
  const secrets = [...new Set([...known].filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result;
};

const generatedSecret = (crypto: Crypto.Crypto) =>
  crypto.randomUUIDv4.pipe(
    Effect.mapError((error) =>
      secretMismatch("managed", `Unable to generate managed secret: ${error.message}`),
    ),
  );

/**
 * Resolves managed and pass-through secret declarations against dedicated persisted values.
 * Managed omission reuses/generates exactly once; pass-through declarations are complete and
 * can change only at a stopped lifecycle boundary.
 */
export const resolveSecrets = (
  candidate: SecretCandidate,
  persisted: PersistedSecretValues | undefined,
  lifecycle: DesiredStackLifecycle,
): Effect.Effect<
  ResolvedSecrets,
  StackSecretMismatchError | StackMustBeStoppedError,
  Crypto.Crypto
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const isUnconfigured = persisted === undefined;
    const previous = persisted ?? {};
    const declarations = new Map<string, SecretDeclaration>();
    for (const declaration of candidate.declarations) {
      if (!validSlot(declaration.slot))
        return yield* secretMismatch("unknown", "Secret slot name is invalid");
      if (declarations.has(declaration.slot))
        return yield* secretMismatch(declaration.slot, "Duplicate secret declaration");
      declarations.set(declaration.slot, declaration);
    }

    const resolved: Record<string, { readonly policy: SecretPolicy; readonly value: string }> = {};
    for (const [slot, declaration] of declarations) {
      const old = previous[slot];
      if (old !== undefined && old.policy !== declaration.policy) {
        return yield* secretMismatch(slot, "Secret policy cannot change for an existing slot");
      }
      if (declaration.policy === "managed") {
        const supplied =
          declaration.value === undefined ? undefined : readSecret(declaration.value);
        if (old !== undefined) {
          if (supplied !== undefined && supplied !== old.value)
            return yield* secretMismatch(
              slot,
              "Supplied managed secret differs from persisted value",
            );
          resolved[slot] = old;
        } else {
          const value = supplied ?? (yield* generatedSecret(crypto));
          resolved[slot] = { policy: "managed", value };
        }
      } else {
        if (declaration.value === undefined)
          return yield* secretMismatch(slot, "Pass-through secret declarations require a value");
        const value = readSecret(declaration.value);
        if (
          lifecycle !== "stopped" &&
          ((old === undefined && !isUnconfigured) || (old !== undefined && old.value !== value))
        )
          return yield* lifecycleChange(slot);
        resolved[slot] = { policy: "passthrough", value };
      }
    }

    for (const [slot, old] of Object.entries(previous)) {
      if (old.policy === "managed") {
        resolved[slot] ??= old;
      } else if (!declarations.has(slot)) {
        if (lifecycle !== "stopped") return yield* lifecycleChange(slot);
      }
    }

    return { persisted: resolved };
  });
