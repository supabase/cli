import { Effect } from "effect";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  SecretsListNetworkError,
  SecretsListUnexpectedStatusError,
} from "../commands/secrets/secrets.errors.ts";
import { mapHttpError } from "./http-errors.ts";

const mapListError = mapHttpError({
  networkError: SecretsListNetworkError,
  statusError: SecretsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list secrets: ${cause}`,
  statusMessage: (status, body) => `unexpected list secrets status ${status}: ${body}`,
});

export const listProjectSecrets = Effect.fnUntraced(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const output = yield* Output;
  const fetching = output.format === "text" ? yield* output.task("Fetching secrets...") : undefined;
  const secrets = yield* api.v1.listAllSecrets({ ref }).pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.catch(mapListError),
  );
  yield* fetching?.clear() ?? Effect.void;
  return [...secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
});
