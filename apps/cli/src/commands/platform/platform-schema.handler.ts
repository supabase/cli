import { Effect } from "effect";

import { Output } from "../../output/output.service.ts";
import { renderPlatformValue } from "./platform-fields.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { PlatformMethodNotFoundError } from "./platform.errors.ts";
import { findPlatformSchemaPayload } from "./platform-schema.ts";

export function showPlatformSchema(method: string) {
  return Effect.gen(function* () {
    const payload = findPlatformSchemaPayload(platformOperationDescriptors, method);
    if (payload instanceof PlatformMethodNotFoundError) {
      return yield* Effect.fail(payload);
    }

    const output = yield* Output;
    if (output.format === "text") {
      yield* output.info(renderPlatformValue(payload));
      return;
    }

    yield* output.success("", payload);
  });
}
