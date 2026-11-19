import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import openApiSpec from "@supabase/api/openapi.json";
import { Effect, Layer, Predicate, Schema, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { commandSurface } from "../../cli/command-surface/command-surface.ts";
import { ExperimentalFlag, GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import type { ApiCommandEntry } from "./api-command.model.ts";
import { apiCommands } from "./generated.ts";
import { apiCommandSchemas } from "./generated.schemas.ts";
import { withApiCommands } from "./runtime.ts";

type Json = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Json => (Predicate.isObject(value) ? value : {});
const asList = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const spec = asRecord(openApiSpec);
const componentSchemas = asRecord(asRecord(spec["components"])["schemas"]);

/** Follows `$ref`s to the component schema they name. */
const resolveRef = (schema: unknown): Json => {
  const node = asRecord(schema);
  const ref = node["$ref"];
  return typeof ref === "string"
    ? resolveRef(componentSchemas[ref.replace("#/components/schemas/", "")])
    : node;
};

const at = (schema: unknown, path: readonly string[]): Json =>
  path.reduce<Json>((node, key) => resolveRef(node[key]), resolveRef(schema));

interface SpecOperation {
  readonly method: string;
  readonly template: string;
  readonly parameters: ReadonlyArray<Json>;
  readonly requestSchema: Json | undefined;
  readonly responseStatus: number;
  readonly responseSchema: Json;
}

const operationOf = (operationId: string): SpecOperation => {
  for (const [template, item] of Object.entries(asRecord(spec["paths"]))) {
    for (const [method, raw] of Object.entries(asRecord(item))) {
      const operation = asRecord(raw);
      if (operation["operationId"] !== operationId) continue;
      const success = Object.entries(asRecord(operation["responses"])).find(([status]) =>
        status.startsWith("2"),
      );
      if (success === undefined) throw new Error(`${operationId} has no 2xx response`);
      const json = (content: unknown) => asRecord(asRecord(content)["application/json"])["schema"];
      const request = json(asRecord(operation["requestBody"])["content"]);
      return {
        method: method.toUpperCase(),
        template,
        parameters: asList(operation["parameters"]).map(asRecord),
        requestSchema: request === undefined ? undefined : resolveRef(request),
        responseStatus: Number(success[0]),
        responseSchema: resolveRef(json(asRecord(success[1])["content"])),
      };
    }
  }
  throw new Error(`${operationId} is not in openapi.json`);
};

/**
 * The JSON Schema types of a node, with OpenAPI 3.0 `nullable` and a `null` union branch folded in
 * as a `null` type.
 */
const typesOf = (node: Json): ReadonlyArray<string> => {
  const declared = node["type"];
  const types = (Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]).map(
    String,
  );
  const nullable =
    node["nullable"] === true ||
    asList(node["anyOf"]).some((branch) => asRecord(branch)["type"] === "null");
  return (nullable ? [...types, "null"] : types)
    .filter((type, index, all) => all.indexOf(type) === index)
    .toSorted((a, b) => a.localeCompare(b));
};

/** A structural fingerprint of a schema that ignores descriptions, examples and titles. */
const shapeOf = (schema: unknown): unknown => {
  const node = resolveRef(schema);
  return {
    types: typesOf(node),
    enum: node["enum"] ?? null,
    properties: Object.fromEntries(
      Object.entries(asRecord(node["properties"])).map(([key, value]) => [key, shapeOf(value)]),
    ),
    required: asList(node["required"])
      .map(String)
      .toSorted((a, b) => a.localeCompare(b)),
    items: node["items"] === undefined ? null : shapeOf(node["items"]),
  };
};

const PATTERN_SAMPLES: Readonly<Record<string, string>> = {
  "^[1-9]\\d*(s|m|h|d)$": "30m",
  "^[a-f0-9]{64}$": "ab".repeat(32),
  "^[a-z]+$": "zyxwvutsrqponmlkjihg",
  "^[1-9]\\d*$": "16385",
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$":
    "7579647f-2cdc-466c-982e-425958a2f985",
};

/** A value the field's schema accepts; an unknown string pattern fails loudly instead of guessing. */
const sampleOf = (schema: unknown): unknown => {
  const node = resolveRef(schema);
  const choices = asList(node["enum"]);
  if (choices.length > 0) return choices[0];
  switch (node["type"]) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return 1;
    case "array":
      return [sampleOf(node["items"]), `${String(sampleOf(node["items"]))}-2`];
    case "string": {
      if (node["format"] === "date-time") return "2026-11-18T10:00:00Z";
      const pattern = node["pattern"];
      if (pattern === undefined) return "sample";
      const sample = typeof pattern === "string" ? PATTERN_SAMPLES[pattern] : undefined;
      if (sample === undefined) throw new Error(`no sample for string pattern ${String(pattern)}`);
      return sample;
    }
    default:
      throw new Error(`no sample for schema type ${String(node["type"])}`);
  }
};

/** Samples for the body fields that take a JSON value; a field without one fails loudly. */
const JSON_SAMPLES: Readonly<Record<string, unknown>> = {
  "v2-update-warehouse-table-layout.sort_by": { kind: "primary_key" },
  "v2-update-warehouse-table-layout.partition_by": [
    { column: "id", transform: { kind: "identity" } },
  ],
};

interface Input {
  readonly json: boolean;
  readonly location: "query" | "body";
  readonly field: string;
  readonly flag: string;
  readonly pointer: string | undefined;
  readonly required: boolean;
  readonly sample: unknown;
}

/**
 * Every non-path input, read from openapi.json; the flag spelling comes from the command's declared
 * binding, since naming is the derivation's contract.
 */
const inputsOf = (
  operationId: string,
  operation: SpecOperation,
  bindings: ApiCommandEntry["bindings"],
): ReadonlyArray<Input> => {
  const flagFor = (location: Input["location"], field: string) => {
    const binding = bindings.find((item) => item.location === location && item.name === field);
    return binding?.source === "flag" ? binding.flag : `<unbound ${field}>`;
  };
  const queries = operation.parameters
    .filter((parameter) => parameter["in"] === "query")
    .map((parameter): Input => {
      const field = String(parameter["name"]);
      return {
        json: false,
        location: "query",
        field,
        flag: flagFor("query", field),
        pointer: undefined,
        required: parameter["required"] === true,
        sample: sampleOf(parameter["schema"]),
      };
    });
  if (operation.requestSchema === undefined) return queries;
  const attributes = at(operation.requestSchema, [
    "properties",
    "data",
    "properties",
    "attributes",
  ]);
  const envelope = Object.keys(attributes).length > 0;
  const container = envelope ? attributes : operation.requestSchema;
  const required = asList(container["required"]);
  const scalarTypes = ["boolean", "integer", "number", "string"];
  const fields = Object.entries(asRecord(container["properties"])).map(([field, schema]): Input => {
    const node = resolveRef(schema);
    const scalar =
      scalarTypes.includes(String(node["type"])) ||
      (node["type"] === "array" && scalarTypes.includes(String(resolveRef(node["items"])["type"])));
    const key = `${operationId}.${field}`;
    if (!scalar && !Object.hasOwn(JSON_SAMPLES, key)) {
      throw new Error(`no JSON sample for body field ${key}`);
    }
    return {
      json: !scalar,
      location: "body",
      field,
      flag: flagFor("body", field),
      pointer: `${envelope ? "/data/attributes" : ""}/${field}`,
      required: required.includes(field),
      sample: scalar ? sampleOf(schema) : JSON_SAMPLES[key],
    };
  });
  return [...queries, ...fields];
};

/** The path parameters besides `ref`, each supplied as a positional argument. */
const positionalsOf = (operation: SpecOperation) =>
  operation.parameters
    .filter((parameter) => parameter["in"] === "path" && parameter["name"] !== "ref")
    .map((parameter) => ({
      name: String(parameter["name"]),
      sample: String(sampleOf(parameter["schema"])),
    }));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const argvOf = (inputs: ReadonlyArray<Input>): ReadonlyArray<string> =>
  inputs.flatMap((input) =>
    input.json
      ? [`--${input.flag}`, encodeJson(input.sample)]
      : Array.isArray(input.sample)
        ? input.sample.flatMap((item) => [`--${input.flag}`, String(item)])
        : [`--${input.flag}`, String(input.sample)],
  );

const expectedQuery = (inputs: ReadonlyArray<Input>): Readonly<Record<string, string>> =>
  Object.fromEntries(
    inputs
      .filter((input) => input.location === "query")
      .map((input) => [input.field, String(input.sample)]),
  );

const expectedBody = (operation: SpecOperation, inputs: ReadonlyArray<Input>): unknown => {
  if (operation.requestSchema === undefined) return undefined;
  const attributes = Object.fromEntries(
    inputs.filter((input) => input.location === "body").map((input) => [input.field, input.sample]),
  );
  const type = asList(
    at(operation.requestSchema, ["properties", "data", "properties", "type"])["enum"],
  )[0];
  return { data: { type, attributes } };
};

const tempRoot = useTempWorkdir("supabase-api-bindings-int-");

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

const TARGET_LOOKUP_PATH = `/v1/projects/${VALID_REF}`;

/** Replaces `globalThis.fetch` while `body` runs and answers every call with `status` and `{}`. */
const withApi = (status: number, sent: Array<Sent>) => {
  const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === TARGET_LOOKUP_PATH) {
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    return request.text().then((text) => {
      sent.push({
        method: request.method,
        path: url.pathname,
        search: url.search.replace(/^\?/, ""),
        body: text === "" ? undefined : decodeJson(text),
      });
      return new Response("{}", { status, headers: { "content-type": "application/json" } });
    });
  };
  return <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = globalThis.fetch;
        globalThis.fetch = Object.assign(stub, { preconnect: previous.preconnect });
        return previous;
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          globalThis.fetch = previous;
        }),
    );
};

const warehouseRoot = Command.make("supabase").pipe(
  Command.withSubcommands(withApiCommands([], ["warehouse"])),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

/** Runs the real parser and generated leaf for `path` and `argv`; only `fetch` is stubbed. */
const send = (path: ReadonlyArray<string>, argv: ReadonlyArray<string>, status: number) => {
  const args = [...path, ...argv, `--remote=${VALID_REF}`, "--yes"];
  const sent: Array<Sent> = [];
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out: mockOutput({ format: "text" }),
      api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      stdin: mockStdin(false),
      cliArgs: args,
    }),
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(ExperimentalFlag, false),
    mockTelemetryRuntime({ configDir: tempRoot.current }),
    mockRuntimeInfo({ cwd: tempRoot.current, homeDir: tempRoot.current }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
  );
  return withConfigEnv(
    { SUPABASE_ACCESS_TOKEN: VALID_TOKEN, SUPABASE_NO_KEYRING: "1" },
    Command.runWith(warehouseRoot, { version: "0.0.0-test" })(args),
  ).pipe(
    withApi(status, sent),
    Effect.provide(layer),
    Effect.map(() => sent),
  );
};

const generated: readonly ApiCommandEntry[] = apiCommands;

const surface = await Effect.runPromise(commandSurface());
const rows = [
  ...Object.values(surface.commands),
  ...Object.values(surface.variants["warehouse"] ?? {}),
]
  .flatMap((entry) => (entry.api === undefined ? [] : [{ ...entry, api: entry.api }]))
  .toSorted((a, b) => a.api.operationId.localeCompare(b.api.operationId));

const bindingKey = (binding: { readonly location: string; readonly name: string }): string =>
  JSON.stringify(binding);

describe("generated command bindings", () => {
  it("covers every generated command", () => {
    expect(rows.map((row) => row.api.operationId)).toEqual(
      apiCommands.map((entry) => entry.operationId).toSorted(),
    );
  });

  for (const row of rows) {
    const { operationId } = row.api;
    const operation = operationOf(operationId);
    const inputs = inputsOf(operationId, operation, row.api.bindings);
    const positionals = positionalsOf(operation);
    const expectedPath = positionals.reduce(
      (path, { name, sample }) => path.replace(`{${name}}`, sample),
      operation.template.replace("{ref}", VALID_REF),
    );

    describe(row.path.join(" "), () => {
      it("binds the path reference and every other input to the spec's location", () => {
        expect(operation.template.match(/\{[^}]+\}/g)).toEqual([
          "{ref}",
          ...positionals.map(({ name }) => `{${name}}`),
        ]);
        const expected = [
          { location: "path", name: "ref", source: "target" },
          ...positionals.map(({ name }) => ({
            location: "path",
            name,
            source: "argument",
            argument: generated.find((entry) => entry.operationId === operationId)?.argument?.name,
          })),
          ...inputs.map((input) =>
            input.location === "query"
              ? { location: "query", name: input.field, source: "flag", flag: input.flag }
              : {
                  location: "body",
                  name: input.field,
                  pointer: input.pointer,
                  source: "flag",
                  flag: input.flag,
                },
          ),
        ];
        expect(row.api.bindings.map(bindingKey).toSorted()).toEqual(
          expected.map(bindingKey).toSorted(),
        );
      });

      it.effect("sends every input at its binding", () =>
        Effect.gen(function* () {
          const requests = yield* send(
            row.path,
            [...positionals.map(({ sample }) => sample), ...argvOf(inputs)],
            operation.responseStatus,
          );
          expect(requests).toHaveLength(1);
          const [request] = requests;
          expect(request?.method).toBe(operation.method);
          expect(request?.path).toBe(expectedPath);
          expect(Object.fromEntries(new URLSearchParams(request?.search))).toEqual(
            expectedQuery(inputs),
          );
          expect(request?.body).toEqual(expectedBody(operation, inputs));
        }),
      );

      it.effect("sends only the inputs the spec requires when no other flag is given", () =>
        Effect.gen(function* () {
          const required = inputs.filter((input) => input.required);
          const requests = yield* send(
            row.path,
            [...positionals.map(({ sample }) => sample), ...argvOf(required)],
            operation.responseStatus,
          );
          expect(requests).toHaveLength(1);
          const [request] = requests;
          expect(Object.fromEntries(new URLSearchParams(request?.search))).toEqual(
            expectedQuery(required),
          );
          expect(request?.body).toEqual(expectedBody(operation, required));
        }),
      );

      it("declares the operation's success response as the response result", () => {
        expect(Object.keys(apiCommandSchemas)).toContain(operationId);
        const branches = asList(asRecord(row.result)["anyOf"]).map(asRecord);
        expect(shapeOf(branches.find((branch) => branch["title"] === "response"))).toEqual(
          shapeOf(operation.responseSchema),
        );
        const waitRead = generated.find((entry) => entry.operationId === operationId)?.wait?.read;
        const waited = branches.find((branch) => branch["title"] === "waited");
        if (waitRead === undefined || waitRead === operationId) {
          expect(waited).toBeUndefined();
          return;
        }
        expect(Object.keys(apiCommandSchemas)).toContain(waitRead);
        expect(shapeOf(waited)).toEqual(shapeOf(operationOf(waitRead).responseSchema));
      });
    });
  }
});
