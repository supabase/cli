import { Option } from "effect";
import { Param } from "effect/unstable/cli";

/**
 * `effect/unstable/cli`'s own `Param.extractSingleParams`/`Param.getParamMetadata`
 * (`.repos/effect/packages/effect/src/unstable/cli/Param.ts`) already implement
 * exactly this unwrap — the same functions `--help` rendering uses internally —
 * but both carry an `@internal` JSDoc tag and are confirmed ABSENT from this
 * package's published `.d.ts` (present only in the compiled `.js`; verified
 * against the pinned `effect@4.0.0-beta.97` under `node_modules`), so calling
 * them would only type-check via an `as` cast, which this repo forbids.
 *
 * This module reimplements the same unwrap using only type-visible public
 * fields. A `Map`/`Transform`/`Optional`/`Variadic` param wraps an inner
 * `.param` of the same shape (e.g. `.pipe(Flag.optional)`,
 * `.pipe(Flag.withDefault(...))`, which composes as `Map(Optional(Single))`),
 * and every non-`Single` variant publicly declares `.param` per its own
 * interface. The variant union is closed as of this effect version, so an
 * unrecognized future variant fails *closed* (the walk stops and returns
 * `undefined`) rather than open. Delete this in favor of
 * `Param.extractSingleParams`/`Param.getParamMetadata` if effect ever
 * publishes them.
 */
interface LegacyWrappedParam {
  readonly param: Param.Any;
}

function legacyIsWrappedParam(param: Param.Any): param is Param.Any & LegacyWrappedParam {
  return "param" in param;
}

interface LegacyVariadicParam {
  readonly min: Option.Option<number>;
}

function legacyIsVariadicParam(
  param: Param.Any & LegacyWrappedParam,
): param is Param.Any & LegacyWrappedParam & LegacyVariadicParam {
  return "min" in param;
}

export interface LegacyUnwrappedParam {
  readonly single: Param.Single<Param.ParamKind, unknown>;
  readonly isOptional: boolean;
  readonly isVariadic: boolean;
  /**
   * The `Param.variadic`/`Flag.atLeast`/`Flag.between` minimum occurrence
   * count, or `0` when the param isn't variadic at all. A variadic param with
   * `min === 0` (e.g. `Flag.atLeast(0)`, what `legacyStringSliceFlag` uses)
   * can legitimately be omitted entirely — `Param.ts`'s `parseOptionVariadic`
   * only fails with `MissingOption` when `count < min` and `min > 0` — so
   * "variadic" alone does NOT imply "optional" the way wrapping in
   * `Param.Optional` does. Callers computing required-ness must check this,
   * not just `isVariadic`.
   */
  readonly variadicMin: number;
}

/**
 * Unwraps a possibly-wrapped `Param` down to its underlying `Single` leaf,
 * alongside whether the param passed through `Param.optional`/`Flag.optional`
 * (or `Flag.withDefault`, which composes as `Map(Optional(Single))`) and/or
 * `Param.variadic`/`Flag.between`/`Flag.atLeast`/`Flag.atMost`. Returns
 * `undefined` only if the variant union gains an unrecognized future case.
 */
export function legacyUnwrapParam(param: Param.Any): LegacyUnwrappedParam | undefined {
  let current: Param.Any = param;
  let isOptional = false;
  let isVariadic = false;
  let variadicMin = 0;

  while (!Param.isSingle(current)) {
    if (!legacyIsWrappedParam(current)) return undefined;
    if (current._tag === "Optional") isOptional = true;
    if (current._tag === "Variadic") {
      isVariadic = true;
      if (legacyIsVariadicParam(current)) {
        variadicMin = Option.getOrElse(current.min, () => 0);
      }
    }
    current = current.param;
  }

  return { single: current, isOptional, isVariadic, variadicMin };
}

/**
 * Unwraps down to the underlying `Single` param only, discarding the
 * optional/variadic metadata `legacyUnwrapParam` also computes. Shared by
 * `legacy/telemetry/legacy-command-instrumentation.ts` (telemetry flag
 * redaction) and `legacy/cli/legacy-complete.ts` (shell completion), both of
 * which only need the leaf `Single`'s `name`/`aliases`/`primitiveType` fields.
 */
export function legacyUnwrapToSingleParam(
  param: Param.Any,
): Param.Single<Param.ParamKind, unknown> | undefined {
  return legacyUnwrapParam(param)?.single;
}
