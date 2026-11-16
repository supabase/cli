import { Schema } from "effect";

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const Naming = Schema.Struct({
  group: Schema.String,
  method: Schema.String,
  flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  wait: Schema.optionalKey(
    Schema.Struct({
      read: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      status: Schema.String,
      succeeded: Schema.Array(Schema.String),
      failed: Schema.Array(Schema.String),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
});

const reserved = new Set([
  "remote",
  "project-ref",
  "linked",
  "local",
  "db-url",
  "yes",
  "experimental",
  "output",
  "output-format",
  "profile",
  "workdir",
  "debug",
  "agent",
  "network-id",
  "dns-resolver",
  "create-ticket",
  "help",
  "version",
  "wait",
  "timeout",
  "body",
  "file",
]);

const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.]/g, "-")
    .toLowerCase();

/** Compiles the supported project-scoped scalar command surface, rejecting unsupported shapes. */
export function generateApiCommands(source: unknown, operationIds: ReadonlyArray<string>) {
  const document = record(source);
  const schemas = record(record(document.components).schemas);
  const resolve = (value: unknown): Record<string, unknown> => {
    const schema = record(value);
    if (typeof schema.$ref !== "string") return schema;
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix)) throw new Error(`Unsupported reference: ${schema.$ref}`);
    return record(schemas[schema.$ref.slice(prefix.length)]);
  };
  const operations = new Map<
    string,
    { path: string; verb: string; operation: Record<string, unknown> }
  >();
  for (const [path, pathItem] of Object.entries(record(document.paths))) {
    for (const [verb, value] of Object.entries(record(pathItem))) {
      if (!["get", "post", "put", "patch", "delete"].includes(verb)) continue;
      const operation = record(value);
      if (typeof operation.operationId === "string")
        operations.set(operation.operationId, { path, verb, operation });
    }
  }
  const getOperation = (id: string) => {
    const operation = operations.get(id);
    if (!operation || operation.operation["x-internal"] === true)
      throw new Error(`Missing public operation: ${id}`);
    return operation;
  };
  const responseSchema = (id: string) => {
    const responses = record(getOperation(id).operation.responses);
    const success = Object.entries(responses).find(([code]) => /^2\d\d$/.test(code));
    if (!success) throw new Error(`No success response: ${id}`);
    return resolve(record(record(record(success[1]).content)["application/json"]).schema);
  };
  const atPointer = (id: string, pointer: string) => {
    if (!pointer.startsWith("/")) throw new Error(`Invalid response pointer: ${pointer}`);
    let schema = responseSchema(id);
    for (const segment of pointer.slice(1).split("/")) {
      schema = resolve(record(schema.properties)[segment.replace(/~1/g, "/").replace(/~0/g, "~")]);
    }
    return schema;
  };
  const commands = operationIds.map((operationId) => {
    const { path, verb, operation } = getOperation(operationId);
    if (!path.startsWith("/v2/projects/{ref}/") || verb !== "post") {
      throw new Error(`Unsupported command scope or verb: ${operationId}`);
    }
    const naming = Schema.decodeUnknownSync(Naming)(operation["x-cli"]);
    if (
      !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){0,2}$/.test(naming.group) ||
      !/^[a-z][a-z0-9-]*$/.test(naming.method)
    ) {
      throw new Error(`Invalid command name: ${operationId}`);
    }
    const parameters = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
      operation.parameters ?? [],
    ).map((value) => record(value));
    if (parameters.length !== 1 || parameters[0]?.name !== "ref" || parameters[0]?.in !== "path") {
      throw new Error(`Unsupported parameters: ${operationId}`);
    }
    let body = resolve(
      record(record(record(operation.requestBody).content)["application/json"]).schema,
    );
    let prefix: string[] = [];
    const constants: Array<{ path: string[]; value: string }> = [];
    if (record(body.properties).data !== undefined) {
      const data = resolve(record(body.properties).data);
      const properties = record(data.properties);
      const type = resolve(properties.type);
      const values = strings(type.enum);
      if (
        Object.keys(record(body.properties)).join() !== "data" ||
        Object.keys(properties).sort().join() !== "attributes,type" ||
        values.length !== 1
      ) {
        throw new Error(`Unsupported resource envelope: ${operationId}`);
      }
      const value = values[0];
      if (value === undefined) throw new Error(`Missing resource type: ${operationId}`);
      constants.push({ path: ["data", "type"], value });
      prefix = ["data", "attributes"];
      body = resolve(properties.attributes);
    }
    const fields: Array<{
      name: string;
      path: string[];
      type: "string" | "number" | "integer" | "boolean";
      required: boolean;
      repeatable: boolean;
      description: string;
      choices?: ReadonlyArray<string>;
    }> = [];
    const renames = naming.flags ?? {};
    const consumedRenames = new Set<string>();
    const flatten = (
      object: Record<string, unknown>,
      parent: string[],
      requiredParent: boolean,
    ) => {
      for (const [property, value] of Object.entries(record(object.properties))) {
        const schema = resolve(value);
        const path = [...parent, property];
        const relative = path.slice(prefix.length).join(".");
        const required = requiredParent && strings(object.required ?? []).includes(property);
        if (schema.type === "object" && schema.properties !== undefined) {
          flatten(schema, path, required);
          continue;
        }
        const repeatable = schema.type === "array";
        const scalar = repeatable ? resolve(schema.items) : schema;
        const type = scalar.type;
        if (
          !["string", "number", "integer", "boolean"].includes(String(type)) ||
          scalar.anyOf ||
          scalar.oneOf ||
          scalar.nullable
        ) {
          throw new Error(`Unsupported input shape: ${operationId}.${relative}`);
        }
        if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")
          throw new Error("Unsupported scalar");
        const name = renames[relative] ?? kebab(relative);
        if (renames[relative] !== undefined) consumedRenames.add(relative);
        if (
          reserved.has(name) ||
          fields.some((field) => field.name === name) ||
          !/^[a-z][a-z0-9-]*$/.test(name)
        ) {
          throw new Error(`Flag collision or invalid name: ${name}`);
        }
        fields.push({
          name,
          path,
          type,
          required,
          repeatable,
          description: typeof schema.description === "string" ? schema.description : "",
          ...(type === "string" && scalar.enum ? { choices: strings(scalar.enum) } : {}),
        });
      }
    };
    flatten(body, prefix, true);
    for (const name of Object.keys(renames))
      if (!consumedRenames.has(name)) throw new Error(`Unresolved flag rename: ${name}`);
    const wait = naming.wait;
    if (wait) {
      if (!wait.read)
        throw new Error(`A mutation waiter requires a read operation: ${operationId}`);
      const read = getOperation(wait.read);
      if (read.verb !== "get" || !read.path.startsWith("/v2/projects/{ref}/"))
        throw new Error(`Unsafe wait operation: ${wait.read}`);
      const params = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
        read.operation.parameters ?? [],
      ).map((value) => record(value));
      for (const [name, pointer] of Object.entries(wait.params ?? {})) {
        if (!params.some((p) => p.name === name))
          throw new Error(`Unknown wait parameter: ${name}`);
        atPointer(operationId, pointer);
      }
      for (const param of params) {
        if (
          param.required &&
          param.name !== "ref" &&
          !Object.hasOwn(wait.params ?? {}, String(param.name))
        )
          throw new Error(`Unbound wait parameter: ${String(param.name)}`);
      }
      const status = atPointer(wait.read, wait.status);
      if (status.type !== "string") throw new Error("Wait status must be a string");
      if (
        wait.succeeded.length === 0 ||
        wait.failed.length === 0 ||
        wait.succeeded.some((v) => wait.failed.includes(v))
      )
        throw new Error("Invalid terminal statuses");
      if (
        status.enum &&
        [...wait.succeeded, ...wait.failed].some((v) => !strings(status.enum).includes(v))
      )
        throw new Error("Unknown terminal status");
      if (wait.error) atPointer(wait.read, wait.error);
    }
    return {
      operationId,
      httpMethod: verb.toUpperCase(),
      path,
      group: naming.group,
      method: naming.method,
      summary:
        typeof operation.summary === "string"
          ? operation.summary
          : `${naming.group} ${naming.method}`,
      description: typeof operation.description === "string" ? operation.description : "",
      experimental: operation["x-scalar-stability"] === "experimental",
      fields,
      constants,
      ...(wait ? { wait: { ...wait, params: wait.params ?? {} } } : {}),
    };
  });
  const paths = commands.map((c) => `${c.group}.${c.method}`);
  if (new Set(paths).size !== paths.length) throw new Error("Generated command collision");
  return commands;
}
