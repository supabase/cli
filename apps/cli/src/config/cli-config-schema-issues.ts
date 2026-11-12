import { Schema, SchemaIssue } from "effect";

type SchemaIssueCode = "invalid_type" | "invalid_enum" | "invalid_value" | "missing_required";

/** One leaf of a schema decode failure; `reason` and `help` never quote the offending input. */
export interface FlatSchemaIssue {
  readonly path: ReadonlyArray<string>;
  readonly code: SchemaIssueCode;
  readonly reason: string;
  readonly help?: string;
}

const TAG = "\u0000";

const typeReason = (expected: string | undefined): string => {
  switch (expected) {
    case "Boolean":
      return "expected a boolean";
    case "Number":
      return "expected a number";
    case "String":
      return "expected a string";
    case "Objects":
      return "expected a table";
    case "Arrays":
      return "expected an array";
    default:
      return "wrong type";
  }
};

const MISSING_FIELD = /^Missing required field in config: /;

/** A schema-authored message is shown only when it quotes nothing, so it cannot carry the input. */
const safeLeafMessage = (message: string): string =>
  MISSING_FIELD.test(message)
    ? "missing required key"
    : /["'`]/.test(message)
      ? "invalid value"
      : message.replace(/, got [\s\S]*$/, "");

const leafMessage: SchemaIssue.LeafHook = (leaf) => {
  if (leaf._tag === "MissingKey") return `${TAG}missing_required${TAG}`;
  if (leaf._tag === "InvalidType") {
    return `${TAG}invalid_type${TAG}${typeReason(leaf.ast._tag)}`;
  }
  return `${TAG}invalid_value${TAG}${safeLeafMessage(SchemaIssue.defaultLeafHook(leaf))}`;
};

const ENUM_MESSAGE = /^Expected ((?:"[^"]*"(?: \| )?)+)$/;

function classify(message: string): Omit<FlatSchemaIssue, "path"> {
  if (message.startsWith(TAG)) {
    const [, code, reason] = message.split(TAG);
    if (code === "missing_required") {
      return { code, reason: "missing required key", help: "add the key" };
    }
    if (code === "invalid_type") return { code, reason: reason ?? "wrong type" };
    if (reason === "missing required key") {
      return { code: "missing_required", reason, help: "add the key" };
    }
    return { code: "invalid_value", reason: reason ?? "invalid value" };
  }
  const choices = ENUM_MESSAGE.exec(message)?.[1]
    ?.split(" | ")
    .map((item) => (item.length === 2 ? item : item.slice(1, -1)));
  if (choices !== undefined) {
    const list = choices.join(", ");
    return { code: "invalid_enum", reason: `expected one of ${list}`, help: `use one of ${list}` };
  }
  const first = message.slice(0, 1).toLowerCase() + message.slice(1);
  return { code: "invalid_value", reason: first.replace(/, got [\s\S]*$/, "") };
}

const segmentOf = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  String(typeof segment === "object" ? segment.key : segment);

/** Every leaf a schema decode failure reports, with its key path. */
export function flattenSchemaIssues(cause: unknown): ReadonlyArray<FlatSchemaIssue> {
  if (!Schema.isSchemaError(cause)) return [];
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: leafMessage })(
    cause.issue,
  );
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(segmentOf),
    ...classify(issue.message),
  }));
}
