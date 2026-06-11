import { Effect } from "effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { deleteFunction } from "../../../../shared/functions/delete.ts";
import { resolveProjectRef } from "../functions.shared.ts";
import type { FunctionsDeleteFlags } from "./delete.command.ts";

export const functionsDelete = Effect.fn("functions.delete")(function* (
  flags: FunctionsDeleteFlags,
) {
  const api = yield* PlatformApi;
  yield* deleteFunction(flags, { api, resolveProjectRef });
});
