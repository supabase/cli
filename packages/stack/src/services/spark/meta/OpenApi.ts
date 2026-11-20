import { typeInfo } from "./Catalog.ts";
import type { Description } from "./Description.ts";

const OPENAPI_TYPES: Readonly<Record<string, string>> = {
  int2: "integer",
  int4: "integer",
  int8: "integer",
  float4: "number",
  float8: "number",
  numeric: "number",
  bool: "boolean",
  json: "object",
  jsonb: "object",
};

interface Property {
  readonly type: string;
  readonly format: string;
  readonly enum?: ReadonlyArray<string>;
  readonly description?: string;
}

interface Definition {
  readonly type: "object";
  readonly properties: Record<string, Property>;
  readonly required: Array<string>;
  readonly description?: string;
}

/** PostgREST's Swagger 2.0 document for the `public` schema; Spark serves no root document. */
export const openApi = (description: Description, publicUrl: string) => {
  const definitions: Record<string, Definition> = {};
  for (const t of description.tables.filter((x) => x.schema === "public")) {
    const primaryKey = t.constraints.find((k) => k.type === "p")?.columns ?? [];
    const definition: Definition = {
      type: "object",
      properties: {},
      required: [],
      ...(t.comment === null ? {} : { description: t.comment }),
    };
    for (const c of t.columns) {
      const info = typeInfo(description, c.type);
      const isPrimaryKey = primaryKey.includes(c.name);
      const notes = [c.comment ?? "", isPrimaryKey ? "Note:\nThis is a Primary Key.<pk/>" : ""]
        .filter((note) => note !== "")
        .join("\n\n");
      definition.properties[c.name] = {
        type: info.array ? "array" : (OPENAPI_TYPES[info.base] ?? "string"),
        format: c.type,
        ...(info.enum === undefined ? {} : { enum: info.enum.labels }),
        ...(notes === "" ? {} : { description: notes }),
      };
      if (c.not_null && c.default === null && c.identity === null) definition.required.push(c.name);
    }
    definitions[t.name] = definition;
  }
  for (const v of description.views.filter((x) => x.schema === "public"))
    definitions[v.name] = {
      type: "object",
      properties: {},
      required: [],
      ...(v.comment === null ? {} : { description: v.comment }),
    };
  const paths: Record<string, unknown> = {
    "/": {
      get: {
        produces: ["application/openapi+json", "application/json"],
        responses: { "200": { description: "OK" } },
        summary: "OpenAPI description (this document)",
        tags: ["Introspection"],
      },
    },
  };
  const parameters: Record<string, unknown> = {
    select: {
      name: "select",
      description: "Filtering Columns",
      required: false,
      in: "query",
      type: "string",
    },
    order: { name: "order", description: "Ordering", required: false, in: "query", type: "string" },
    limit: {
      name: "limit",
      description: "Limiting and Pagination",
      required: false,
      in: "query",
      type: "string",
    },
    preferPost: {
      name: "Prefer",
      description: "Preference",
      required: false,
      in: "header",
      type: "string",
      enum: ["return=representation", "return=minimal", "return=none"],
    },
  };
  for (const [table, definition] of Object.entries(definitions)) {
    const ref = { $ref: `#/definitions/${table}` };
    const rowFilters = Object.keys(definition.properties).map((name) => ({
      $ref: `#/parameters/rowFilter.${table}.${name}`,
    }));
    paths[`/${table}`] = {
      get: {
        tags: [table],
        parameters: [
          ...rowFilters,
          { $ref: "#/parameters/select" },
          { $ref: "#/parameters/order" },
          { $ref: "#/parameters/limit" },
        ],
        responses: { "200": { description: "OK", schema: { type: "array", items: ref } } },
      },
      post: {
        tags: [table],
        parameters: [{ $ref: `#/parameters/body.${table}` }, { $ref: "#/parameters/preferPost" }],
        responses: { "201": { description: "Created" } },
      },
      patch: {
        tags: [table],
        parameters: [...rowFilters, { $ref: `#/parameters/body.${table}` }],
        responses: { "204": { description: "No Content" } },
      },
      delete: {
        tags: [table],
        parameters: rowFilters,
        responses: { "204": { description: "No Content" } },
      },
    };
    parameters[`body.${table}`] = {
      name: table,
      description: table,
      required: false,
      in: "body",
      schema: ref,
    };
    for (const [name, property] of Object.entries(definition.properties))
      parameters[`rowFilter.${table}.${name}`] = {
        name,
        required: false,
        in: "query",
        format: property.format,
        type: "string",
      };
  }
  const url = new URL(publicUrl);
  return {
    swagger: "2.0",
    info: { description: "", title: "standard public schema", version: "spark" },
    host: url.host,
    basePath: "/rest/v1",
    schemes: [url.protocol.replace(":", "")],
    consumes: ["application/json", "application/vnd.pgrst.object+json", "text/csv"],
    produces: ["application/json", "application/vnd.pgrst.object+json", "text/csv"],
    paths,
    definitions,
    parameters,
    externalDocs: {
      description: "PostgREST Documentation",
      url: "https://postgrest.org/en/v12/references/api.html",
    },
  };
};
