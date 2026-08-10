import {
  markSupabaseApiInputErrorAsUserInput,
  operationDefinitions,
  SupabaseApiInputError,
  type ApiClient,
} from "@supabase/api/effect";
import { Effect, type Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Output } from "../output/output.service.ts";
import {
  DeleteFunctionNetworkError,
  DeleteFunctionUnexpectedStatusError,
  FunctionNotFoundError,
  InvalidFunctionSlugError,
} from "./delete.errors.ts";
import { invalidFunctionSlugDetail, validateFunctionSlugMessage } from "./functions.shared.ts";

export interface DeleteFunctionOptions {
  readonly slug: string;
  readonly projectRef: Option.Option<string>;
}

export interface DeleteFunctionDependencies<ResolveError, ResolveRequirements> {
  readonly api: ApiClient;
  readonly resolveProjectRef: (
    projectRef: Option.Option<string>,
  ) => Effect.Effect<string, ResolveError, ResolveRequirements>;
  /**
   * Optional shell-specific styling for the slug/ref in the success line.
   * Defaults to identity (plain text). The legacy shell injects Go's aqua
   * here; keeping the hook injected preserves next-shell isolation from
   * `legacy/`-specific rendering.
   */
  readonly styleIdentifier?: (text: string) => string;
}

function validateSlug(slug: string): Effect.Effect<void, InvalidFunctionSlugError> {
  if (validateFunctionSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(new InvalidFunctionSlugError({ message: invalidFunctionSlugDetail }));
}

export function deleteFunction<ResolveError, ResolveRequirements>(
  flags: DeleteFunctionOptions,
  dependencies: DeleteFunctionDependencies<ResolveError, ResolveRequirements>,
) {
  return Effect.gen(function* () {
    const output = yield* Output;

    yield* validateSlug(flags.slug);
    const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);

    const response = yield* dependencies.api
      .executeRaw(operationDefinitions.v1DeleteAFunction, {
        ref: projectRef,
        function_slug: flags.slug,
      })
      .pipe(
        Effect.mapError((error) => {
          if (error instanceof SupabaseApiInputError) {
            // This operation's complete input is the resolved ref and the
            // prevalidated slug, so a schema rejection is user-derived.
            return markSupabaseApiInputErrorAsUserInput(error);
          }
          if (HttpClientError.isHttpClientError(error)) {
            const description = error.reason.description ?? error.reason._tag;
            return new DeleteFunctionNetworkError({
              message: `failed to delete function: ${description}`,
            });
          }
          return new DeleteFunctionNetworkError({
            message: `failed to delete function: ${String(error)}`,
          });
        }),
      );

    switch (response.status) {
      case 200:
        break;
      case 404:
        return yield* Effect.fail(
          new FunctionNotFoundError({
            message: `Function ${flags.slug} does not exist on the Supabase project: nothing to delete`,
          }),
        );
      default: {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* Effect.fail(
          new DeleteFunctionUnexpectedStatusError({
            status: response.status,
            message: `unexpected delete function status ${response.status}: ${body}`,
          }),
        );
      }
    }

    if (output.format !== "text") {
      yield* output.success("Deleted Edge Function.", {
        function_slug: flags.slug,
        project_ref: projectRef,
      });
      return;
    }

    // Go: `fmt.Printf("Deleted Function %s from project %s.\n", utils.Aqua(slug),
    // utils.Aqua(projectRef))` (`internal/functions/delete/delete.go:20`) — the
    // legacy handler injects the aqua styling via `styleIdentifier`; next stays plain.
    const style = dependencies.styleIdentifier ?? ((text: string) => text);
    yield* output.raw(`Deleted Function ${style(flags.slug)} from project ${style(projectRef)}.\n`);
  }).pipe(Effect.withSpan("functions.delete"));
}
