import { Context, Option } from "effect";
import type { Param } from "effect/cli";
import type { UnwrappedParam } from "./param-introspection.ts";

export interface FlagDocumentationShape {
  readonly defaultValue?: string;
  readonly choices?: ReadonlyArray<string>;
  readonly required?: boolean;
  readonly hidden?: boolean;
  /** Website compatibility labels need not describe an actual runtime default. */
  readonly helpDefault?: string | false;
}

export class FlagDocumentation extends Context.Service<FlagDocumentation, FlagDocumentationShape>()(
  "supabase/FlagDocumentation",
) {}

export function flagDocumentation(
  single: Param.Single<Param.ParamKind, unknown>,
): FlagDocumentationShape {
  return Context.getOption(single.annotations, FlagDocumentation).pipe(
    Option.getOrElse(() => ({})),
  );
}

/** Only literal scalar and array defaults can be displayed without evaluating user code. */
export function literalDefault(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values: unknown[] = value;
    if (
      values.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)),
      )
    ) {
      return JSON.stringify(values);
    }
  }
  return undefined;
}

export function flagDefault(unwrapped: UnwrappedParam): string | undefined {
  return (
    flagDocumentation(unwrapped.single).defaultValue ??
    Option.flatMap(unwrapped.defaultValue, (value) =>
      Option.fromUndefinedOr(literalDefault(value)),
    ).pipe(Option.getOrUndefined)
  );
}
