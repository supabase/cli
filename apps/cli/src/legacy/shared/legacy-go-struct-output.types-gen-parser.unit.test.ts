import { describe, expect, it } from "vitest";

import { parseGoStruct } from "./legacy-go-struct-output.types-gen-parser.ts";

describe("parseGoStruct", () => {
  it("parses plain scalar fields", () => {
    const source = `
type Simple struct {
	Name string \`json:"name"\`
	Count int32 \`json:"count"\`
	Ready bool \`json:"ready"\`
	Score float64 \`json:"score"\`
	CreatedAt time.Time \`json:"created_at"\`
	Id openapi_types.UUID \`json:"id"\`
}
`;
    expect(parseGoStruct(source, "Simple")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        { json: "name", go: "Name", pointer: false, kind: "string" },
        { json: "count", go: "Count", pointer: false, kind: "int" },
        { json: "ready", go: "Ready", pointer: false, kind: "bool" },
        { json: "score", go: "Score", pointer: false, kind: "float" },
        { json: "created_at", go: "CreatedAt", pointer: false, kind: "time" },
        { json: "id", go: "Id", pointer: false, kind: "uuid" },
      ],
    });
  });

  it("parses pointer fields", () => {
    const source = `
type WithPointers struct {
	Name *string \`json:"name,omitempty"\`
	Count *int32 \`json:"count,omitempty"\`
}
`;
    expect(parseGoStruct(source, "WithPointers")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        { json: "name", go: "Name", pointer: true, kind: "string" },
        { json: "count", go: "Count", pointer: true, kind: "int" },
      ],
    });
  });

  it("parses slice fields, including a pointer to a slice", () => {
    const source = `
type WithSlice struct {
	Tags []string \`json:"tags"\`
	Items *[]string \`json:"items,omitempty"\`
}
`;
    expect(parseGoStruct(source, "WithSlice")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        {
          json: "tags",
          go: "Tags",
          pointer: false,
          kind: "slice",
          elem: { pointer: false, kind: "string" },
        },
        {
          json: "items",
          go: "Items",
          pointer: true,
          kind: "slice",
          elem: { pointer: false, kind: "string" },
        },
      ],
    });
  });

  it("parses map[string]... fields", () => {
    const source = `
type WithMap struct {
	Labels map[string]string \`json:"labels"\`
}
`;
    expect(parseGoStruct(source, "WithMap")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        {
          json: "labels",
          go: "Labels",
          pointer: false,
          kind: "map",
          elem: { pointer: false, kind: "string" },
        },
      ],
    });
  });

  it("parses recursively nested anonymous struct fields (saml/attribute_mapping/keys shape)", () => {
    const source = `
type WithNested struct {
	Saml *struct {
		AttributeMapping *struct {
			Keys map[string]struct {
				Name *string \`json:"name,omitempty"\`
			} \`json:"keys"\`
		} \`json:"attribute_mapping,omitempty"\`
		EntityId string \`json:"entity_id"\`
	} \`json:"saml,omitempty"\`
}
`;
    expect(parseGoStruct(source, "WithNested")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        {
          json: "saml",
          go: "Saml",
          pointer: true,
          kind: "struct",
          fields: [
            {
              json: "attribute_mapping",
              go: "AttributeMapping",
              pointer: true,
              kind: "struct",
              fields: [
                {
                  json: "keys",
                  go: "Keys",
                  pointer: false,
                  kind: "map",
                  elem: {
                    pointer: false,
                    kind: "struct",
                    fields: [{ json: "name", go: "Name", pointer: true, kind: "string" }],
                  },
                },
              ],
            },
            { json: "entity_id", go: "EntityId", pointer: false, kind: "string" },
          ],
        },
      ],
    });
  });

  it("resolves a single-level enum-alias field (type X string) to its base kind", () => {
    const source = `
type WithAlias struct {
	Status BranchResponseStatus \`json:"status"\`
}

// BranchResponseStatus This field is deprecated. List action runs to get branch status instead.
type BranchResponseStatus string
`;
    expect(parseGoStruct(source, "WithAlias")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [{ json: "status", go: "Status", pointer: false, kind: "string" }],
    });
  });

  it("skips a full-line // comment (including a Deprecated: line with a backtick-quoted phrase) before a field", () => {
    const source = `
type WithComment struct {
	Name string \`json:"name"\`

	// LatestCheckRunId This field is deprecated and will not be populated.
	// Deprecated: this property has been marked as deprecated upstream, but no \`x-deprecated-reason\` was set
	LatestCheckRunId *float32 \`json:"latest_check_run_id,omitempty"\`
}
`;
    expect(parseGoStruct(source, "WithComment")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [
        { json: "name", go: "Name", pointer: false, kind: "string" },
        { json: "latest_check_run_id", go: "LatestCheckRunId", pointer: true, kind: "float" },
      ],
    });
  });

  it('falls back to kind "unknown" for an unresolvable identifier instead of throwing', () => {
    const source = `
type WithUnknown struct {
	Email openapi_types.Email \`json:"email"\`
}
`;
    expect(parseGoStruct(source, "WithUnknown")).toEqual({
      pointer: false,
      kind: "struct",
      fields: [{ json: "email", go: "Email", pointer: false, kind: "unknown" }],
    });
  });
});
