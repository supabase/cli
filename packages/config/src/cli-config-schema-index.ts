import type { SchemaAST } from "effect";
import { isDeferredEnvField, leafExpectedType, unwrapAst } from "./lib/env.ts";
import type { SchemaIndexNode } from "./schema-index-core.ts";

/** Builds the serializable schema index from the Effect AST, using the same helpers the Effect env walker uses. */
export function buildSchemaIndex(
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): SchemaIndexNode {
  const node = unwrapAst(ast);
  if (seen.has(node)) {
    throw new Error("recursive config schemas are not supported by the schema index");
  }
  const path = new Set(seen).add(node);
  const type = leafExpectedType(node);
  const base = {
    ...(type === "unknown" ? {} : { t: type }),
    ...(isDeferredEnvField(node) ? { d: true as const } : {}),
  };
  switch (node._tag) {
    case "Objects": {
      const indexSignature = node.indexSignatures[0];
      return {
        ...base,
        p: node.propertySignatures.map((signature) => [
          String(signature.name),
          buildSchemaIndex(signature.type, path),
        ]),
        ...(indexSignature === undefined ? {} : { a: buildSchemaIndex(indexSignature.type, path) }),
      };
    }
    case "Arrays": {
      const rest = node.rest[0];
      return {
        ...base,
        e: node.elements.map((element) => buildSchemaIndex(element, path)),
        ...(rest === undefined ? {} : { i: buildSchemaIndex(rest, path) }),
      };
    }
    case "Union":
      return { ...base, u: node.types.map((variant) => buildSchemaIndex(variant, path)) };
    default:
      return base;
  }
}
