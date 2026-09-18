import { Option } from "effect";
import { Param } from "effect/unstable/cli";

/**
 * Reimplements `effect/unstable/cli`'s internal `Param.extractSingleParams`/
 * `getParamMetadata` unwrap using only public fields, since the originals are `@internal` and
 * would need a forbidden `as` cast. Fails closed (`undefined`) on an unrecognized variant.
 */
interface WrappedParam {
  readonly param: Param.Any;
}

function isWrappedParam(param: Param.Any): param is Param.Any & WrappedParam {
  return "param" in param;
}

interface VariadicParam {
  readonly min: Option.Option<number>;
}

function isVariadicParam(
  param: Param.Any & WrappedParam,
): param is Param.Any & WrappedParam & VariadicParam {
  return "min" in param;
}

export interface UnwrappedParam {
  readonly single: Param.Single<Param.ParamKind, unknown>;
  readonly isOptional: boolean;
  readonly isVariadic: boolean;
  /**
   * The variadic minimum occurrence count (`0` when not variadic, or when variadic with no
   * minimum, e.g. `Flag.atLeast(0)`). A variadic param isn't necessarily optional — check
   * this instead of `isVariadic` when determining whether a flag is required.
   */
  readonly variadicMin: number;
}

/**
 * Unwraps a possibly-wrapped `Param` down to its underlying `Single` leaf, tracking whether it
 * passed through `Param.optional`/`Flag.optional`/`Flag.withDefault` and/or a variadic wrapper.
 * Returns `undefined` for an unrecognized param variant.
 */
export function unwrapParam(param: Param.Any): UnwrappedParam | undefined {
  let current: Param.Any = param;
  let isOptional = false;
  let isVariadic = false;
  let variadicMin = 0;

  while (!Param.isSingle(current)) {
    if (!isWrappedParam(current)) return undefined;
    if (current._tag === "Optional") isOptional = true;
    if (current._tag === "Variadic") {
      isVariadic = true;
      if (isVariadicParam(current)) {
        variadicMin = Option.getOrElse(current.min, () => 0);
      }
    }
    current = current.param;
  }

  return { single: current, isOptional, isVariadic, variadicMin };
}

/**
 * Unwraps down to the underlying `Single` param only, discarding the optional/variadic
 * metadata `unwrapParam` also computes. Shared by telemetry flag redaction and shell
 * completion, which only need the leaf's `name`/`aliases`/`primitiveType` fields.
 */
export function unwrapToSingleParam(
  param: Param.Any,
): Param.Single<Param.ParamKind, unknown> | undefined {
  return unwrapParam(param)?.single;
}
