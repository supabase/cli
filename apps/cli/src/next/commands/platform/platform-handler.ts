import { Effect, Exit, Option } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import {
  parsePlatformFieldsSelection,
  projectPlatformFields,
  renderPlatformValue,
} from "./platform-fields.ts";
import { writePlatformJsonStdout } from "./platform-output.ts";
import { buildPlatformSchemaPayload, renderPlatformSchemaPayload } from "./platform-schema.ts";
import {
  buildPlatformRequestPreview,
  decodePlatformInput,
  mergePlatformInput,
  parsePlatformBodySource,
  parsePlatformJsonSource,
  parsePlatformUploadSources,
  promptForMissingPlatformFields,
  redactPlatformInputForPreview,
  validatePlatformStdinUsage,
} from "./platform-input.ts";
import { formatPlatformApiCommand } from "./platform-cli.ts";
import type { PlatformOperationDescriptor } from "./platform-types.ts";

type BasePlatformFlags = {
  readonly params: Option.Option<string>;
  readonly json: Option.Option<string>;
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly upload: ReadonlyArray<string>;
  readonly fields: Option.Option<string>;
  readonly schema: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shouldShowTextSuccessMessage = (
  descriptor: PlatformOperationDescriptor,
  value: unknown,
): boolean => {
  if (descriptor.successMessage !== "Request completed.") {
    return true;
  }

  return !Array.isArray(value) && !isRecord(value);
};

export function runPlatformOperation<
  Flags extends BasePlatformFlags,
  ExecuteError = never,
  ExecuteRequirements = never,
>(options: {
  readonly descriptor: PlatformOperationDescriptor;
  readonly execute?: (input: unknown) => Effect.Effect<unknown, ExecuteError, ExecuteRequirements>;
}) {
  return Effect.fnUntraced(function* (flags: Flags) {
    const descriptor = options.descriptor;
    const output = yield* Output;

    if (flags.schema) {
      const payload = buildPlatformSchemaPayload(descriptor);
      if (output.format === "text") {
        yield* output.info(renderPlatformSchemaPayload(payload));
        return;
      }

      if (output.format === "json") {
        yield* writePlatformJsonStdout(payload);
        return;
      }

      yield* output.event({
        type: "result",
        data: payload,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    yield* validatePlatformStdinUsage(flags.json, flags.params, flags.body, flags.upload);

    const jsonValues = yield* parsePlatformJsonSource(flags.json, "json");
    const paramsValues = yield* parsePlatformJsonSource(flags.params, "params");
    const bodyValue = yield* parsePlatformBodySource(
      { body: flags.body, bodyFile: flags.bodyFile },
      descriptor.request.body,
    );
    const uploadValues = yield* parsePlatformUploadSources(flags.upload, descriptor.request.body);

    const merged = yield* mergePlatformInput({
      descriptor,
      jsonValues,
      paramsValues,
      bodyValue,
      uploadValues,
    });
    const prompted = yield* promptForMissingPlatformFields(descriptor, merged);
    const decoded = yield* decodePlatformInput(descriptor, descriptor.inputSchema, prompted);
    const fields = parsePlatformFieldsSelection(flags.fields);

    if (flags.dryRun) {
      const requestPreview = buildPlatformRequestPreview(
        descriptor,
        redactPlatformInputForPreview(descriptor, prompted),
      );
      if (output.format === "text") {
        yield* output.info(renderPlatformValue(requestPreview));
        return;
      }
      const payload = isRecord(requestPreview) ? requestPreview : { result: requestPreview };
      yield* output.success("", { dryRun: true, ...payload });
      return;
    }

    if (descriptor.confirmsMutation && !flags.yes) {
      const confirmed = yield* output.promptConfirm(`Run ${formatPlatformApiCommand(descriptor)}?`);
      if (!confirmed) {
        yield* output.outro("Cancelled.");
        return;
      }
    }

    const task =
      output.format === "text" && output.interactive
        ? yield* output.task("Running request...")
        : undefined;
    let response: unknown;
    if (options.execute) {
      const responseExit = yield* options.execute(decoded).pipe(Effect.exit);
      if (Exit.isFailure(responseExit)) {
        if (task !== undefined) {
          yield* task.clear();
        }
        return yield* Effect.failCause(responseExit.cause);
      }
      response = responseExit.value;
    } else {
      const responseExit = yield* descriptor.execute(decoded).pipe(Effect.exit);
      if (Exit.isFailure(responseExit)) {
        if (task !== undefined) {
          yield* task.clear();
        }
        return yield* Effect.failCause(responseExit.cause);
      }
      response = responseExit.value;
    }
    const projected = projectPlatformFields(response, fields);

    if (output.format === "text") {
      const rendered = renderPlatformValue(projected);

      if (task !== undefined) {
        if (shouldShowTextSuccessMessage(descriptor, projected)) {
          yield* task.succeed(descriptor.successMessage);
          yield* output.info(rendered);
        } else {
          yield* task.succeed(rendered);
        }
        return;
      }

      if (shouldShowTextSuccessMessage(descriptor, projected)) {
        yield* output.success(descriptor.successMessage);
      }
      yield* output.info(rendered);
      return;
    }

    if (isRecord(projected)) {
      yield* output.success("", projected);
      return;
    }

    yield* output.success("", { result: projected });
  });
}
