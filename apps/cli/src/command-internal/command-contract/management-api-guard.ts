import { Context, Data, Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Output } from "../../shared/output/output.service.ts";
import type { CommandPermissions } from "../command-permissions/model.ts";
import type { CommandContract, ContractWrite } from "./command-contract.annotation.ts";
import { matchManagementApiOperation } from "./management-api-operation.ts";

/** A Management API request the command's contract or permissions don't allow. */
export class ContractViolation extends Data.TaggedError("ContractViolation")<{
  readonly message: string;
}> {}

/** Checks every Management API request a contracted command sends before it leaves the process. */
export class ManagementApiGuard extends Context.Service<
  ManagementApiGuard,
  {
    readonly guard: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
    /** Records a value the user typed or selected at a prompt as user-supplied input. */
    readonly recordAnswer: (value: string) => Effect.Effect<void>;
  }
>()("supabase/ManagementApiGuard") {}

const lookupKey = (operationId: string, field: string) => `${operationId}#${field}`;

const stringsOf = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Option.isOption(value)) return Option.isSome(value) ? stringsOf(value.value) : [];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  return [];
};

const fieldValues = (json: unknown, field: string): ReadonlyArray<string> => {
  if (Array.isArray(json)) return json.flatMap((item) => fieldValues(item, field));
  if (typeof json !== "object" || json === null) return [];
  return stringsOf(Object.getOwnPropertyDescriptor(json, field)?.value);
};

const violation = (message: string) => Effect.die(new ContractViolation({ message }));

/**
 * Builds the guard for one run. A request must match a Management API operation the command
 * declares; a non-GET request must be a declared write whose target came from the input, a prompt
 * answer, or a declared lookup's response, and may run at most `max` times.
 */
export const makeManagementApiGuard = (
  contract: CommandContract,
  permissions: Option.Option<CommandPermissions>,
  input: unknown,
) =>
  Effect.sync(() => {
    const writes = new Map(contract.writes.map((write) => [write.operationId, write]));
    const declared = new Set([
      ...writes.keys(),
      ...Option.match(permissions, {
        onNone: () => [],
        onSome: (p) => (p.status === "mapped" ? p.operations.map((op) => op.operationId) : []),
      }),
    ]);
    const lookupFields = new Map<string, Array<string>>();
    for (const write of contract.writes) {
      for (const target of write.targets) {
        if (target.from !== "lookup") continue;
        lookupFields.set(target.operationId, [
          ...(lookupFields.get(target.operationId) ?? []),
          target.field,
        ]);
      }
    }
    const answers = new Set<string>();
    const looked = new Map<string, Set<string>>();
    const counts = new Map<string, number>();

    const allowedTarget = (write: ContractWrite, value: string) =>
      write.targets.some((target) => {
        if (target.from === "lookup") {
          return looked.get(lookupKey(target.operationId, target.field))?.has(value) === true;
        }
        const fromInput =
          typeof input === "object" && input !== null
            ? stringsOf(Object.getOwnPropertyDescriptor(input, target.input)?.value)
            : [];
        return fromInput.includes(value) || answers.has(value);
      });

    const storeLookup = (operationId: string, fields: ReadonlyArray<string>, json: unknown) => {
      for (const field of fields) {
        const key = lookupKey(operationId, field);
        const values = looked.get(key) ?? new Set<string>();
        for (const value of fieldValues(json, field)) values.add(value);
        looked.set(key, values);
      }
    };

    const recordLookup = (operationId: string, response: HttpClientResponse.HttpClientResponse) => {
      const fields = lookupFields.get(operationId);
      if (fields === undefined || response.status < 200 || response.status >= 300) {
        return Effect.void;
      }
      return response.json.pipe(
        Effect.map((json) => storeLookup(operationId, fields, json)),
        Effect.ignore,
      );
    };

    const check = Effect.fnUntraced(function* (method: string, url: string) {
      const match = matchManagementApiOperation(method, url);
      if (match === undefined) {
        return yield* violation(`${method} ${url} matches no Management API operation`);
      }
      const { operationId, pathParams } = match;
      if (!declared.has(operationId)) {
        return yield* violation(`${operationId} is not declared by the command`);
      }
      const write = writes.get(operationId);
      if (write === undefined) {
        if (method.toUpperCase() !== "GET") {
          return yield* violation(`${operationId} is not a declared write`);
        }
        return operationId;
      }
      const target = pathParams[write.targetParam];
      if (target === undefined || !allowedTarget(write, target)) {
        return yield* violation(
          `${operationId} targets ${write.targetParam}=${target ?? "<missing>"}, which no declared source supplied`,
        );
      }
      const count = (counts.get(operationId) ?? 0) + 1;
      if (count > write.max) {
        return yield* violation(
          `${operationId} would run ${count} times; the contract allows ${write.max}`,
        );
      }
      counts.set(operationId, count);
      return operationId;
    });

    return ManagementApiGuard.of({
      guard: (client) =>
        HttpClient.transform(client, (response, request) =>
          check(request.method, request.url).pipe(
            Effect.flatMap((operationId) =>
              response.pipe(Effect.tap((res) => recordLookup(operationId, res))),
            ),
          ),
        ),
      recordAnswer: (value) => Effect.sync(() => answers.add(value)),
    });
  });

/**
 * Provides the guard for one run, plus an `Output` whose text and select prompts record their
 * answers, since a typed or selected value is user-supplied input the parsed flags don't hold.
 */
export const managementApiGuardLayer = (
  contract: CommandContract,
  permissions: Option.Option<CommandPermissions>,
  input: unknown,
) => {
  const guard = Layer.effect(
    ManagementApiGuard,
    makeManagementApiGuard(contract, permissions, input),
  );
  const output = Layer.effect(
    Output,
    Effect.gen(function* () {
      const output = yield* Output;
      const { recordAnswer } = yield* ManagementApiGuard;
      return Output.of({
        ...output,
        promptText: (message, opts) =>
          output.promptText(message, opts).pipe(Effect.tap(recordAnswer)),
        promptSelect: (message, options, behavior) =>
          output.promptSelect(message, options, behavior).pipe(Effect.tap(recordAnswer)),
      });
    }),
  );
  return Layer.provideMerge(output, guard);
};
