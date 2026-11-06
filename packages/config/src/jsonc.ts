import { printParseErrorCode, visit, type ParseErrorCode } from "jsonc-parser";
import { setOwnProperty } from "./sparse.ts";

/** A JSONC document failed to parse; `line` and `column` are 1-based and the message never quotes source text. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- only ever a thrown cause, never an Effect failure.
export class JsoncSyntaxError extends Error {
  override readonly name = "JsoncSyntaxError";
  readonly reason: string;
  readonly line: number;
  readonly column: number;

  constructor(reason: string, line: number, column: number) {
    super(`${reason} (line ${line}, column ${column})`);
    this.reason = reason;
    this.line = line;
    this.column = column;
  }
}

function describeErrorCode(code: ParseErrorCode): string {
  const words = printParseErrorCode(code)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Container = { readonly value: Record<string, unknown> | unknown[]; key?: string };

/** Parses JSON with comments and trailing commas, keeping `__proto__` keys as own properties like `JSON.parse`. */
export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const stack: Container[] = [];
  let root: unknown;
  let failure: JsoncSyntaxError | undefined;

  const attach = (value: unknown, key?: string) => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      root = value;
    } else if (Array.isArray(parent.value)) {
      parent.value.push(value);
    } else if (key !== undefined) {
      setOwnProperty(parent.value, key, value);
    }
  };

  visit(
    source,
    {
      onObjectBegin: () => {
        stack.push({ value: {} });
      },
      onObjectProperty: (property) => {
        const top = stack[stack.length - 1];
        if (top !== undefined) {
          top.key = property;
        }
      },
      onObjectEnd: () => {
        const done = stack.pop();
        if (done !== undefined) {
          attach(done.value, stack[stack.length - 1]?.key);
        }
      },
      onArrayBegin: () => {
        stack.push({ value: [] });
      },
      onArrayEnd: () => {
        const done = stack.pop();
        if (done !== undefined) {
          attach(done.value, stack[stack.length - 1]?.key);
        }
      },
      onLiteralValue: (value) => {
        attach(value, stack[stack.length - 1]?.key);
      },
      onError: (code, _offset, _length, startLine, startCharacter) => {
        failure ??= new JsoncSyntaxError(
          describeErrorCode(code),
          startLine + 1,
          startCharacter + 1,
        );
      },
    },
    { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false },
  );

  if (failure !== undefined) {
    throw failure;
  }
  return root;
}
