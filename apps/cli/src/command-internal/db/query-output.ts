import { DateTime, Effect, Option, Predicate, Schema } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { Random } from "../../shared/runtime/random.service.ts";
import { OutputFlag } from "../global-flags.ts";
import {
  type Advisory,
  coerceLocalJsonRows,
  findNonFiniteJsonValue,
  formatLinkedValue,
  orderedKeys,
  type QueryFormat,
  renderJson,
  renderTablewriter,
  toCsv,
} from "./query.format.ts";

const BOUNDARY_BYTES = 16;

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const isRowObject = (element: unknown): element is { readonly [key: string]: unknown } | null =>
  element === null || Predicate.isObject(element);

/**
 * Writes the resolved payload (json/table/csv) to stdout. CSV and table ignore agent mode; only
 * JSON carries the agent envelope, wrapped as one result event when the output is stream-json.
 */
export const emitQueryResult = Effect.fnUntraced(function* <E>(args: {
  // The caller's error for a value JSON cannot carry; its tag is part of each command's contract.
  readonly encodeError: (message: string) => E;
  readonly format: QueryFormat;
  readonly cols: ReadonlyArray<string>;
  readonly data: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly agentMode: boolean;
  readonly advisory: Option.Option<Advisory>;
  // Only used for table/CSV cells, since JSON output re-marshals the raw values.
  readonly formatCell?: (value: unknown, columnIndex: number) => string;
  // Column OIDs of a direct connection, used to coerce int8/bigint JSON cells to bare numbers;
  // omitted when the rows are already raw JSON values.
  readonly fieldTypeIds?: ReadonlyArray<number>;
}) {
  const output = yield* Output;
  const random = yield* Random;
  const outputFlag = yield* OutputFlag;
  const { format, cols, data, agentMode, advisory, formatCell, fieldTypeIds } = args;
  if (format === "table") {
    return yield* output.raw(renderTablewriter(cols, data, formatCell));
  }
  if (format === "csv") {
    return yield* output.raw(toCsv(cols, data, formatCell));
  }
  // The established JSON encoding fails on NaN/±Inf (empty stdout, exit 1); mirror that instead
  // of letting `JSON.stringify` silently emit `null`.
  const nonFinite = findNonFiniteJsonValue(data);
  if (nonFinite !== undefined) {
    return yield* Effect.fail(
      args.encodeError(`failed to encode JSON: json: unsupported value: ${nonFinite}`),
    );
  }
  const jsonData = fieldTypeIds === undefined ? data : coerceLocalJsonRows(data, fieldTypeIds);
  const boundary = agentMode ? yield* random.randomHex(BOUNDARY_BYTES) : "";
  const rendered = renderJson(cols, jsonData, agentMode, boundary, advisory);
  if (output.format === "stream-json" && Option.getOrUndefined(outputFlag) !== "json") {
    const compactRendered = rendered.trimEnd().replaceAll("\n", "");
    yield* output.raw(
      `{"type":"result","data":${compactRendered},"timestamp":"${DateTime.formatIso(yield* DateTime.now)}"}\n`,
    );
    return;
  }
  yield* output.raw(rendered);
});

/**
 * Renders a Management API `database/query` answer: a JSON array of row objects for a SELECT, or
 * a plain command tag for DDL/DML, which is printed verbatim.
 */
export const emitManagementApiRows = Effect.fnUntraced(function* <E>(
  body: string,
  format: QueryFormat,
  agentMode: boolean,
  encodeError: (message: string) => E,
) {
  const output = yield* Output;
  const decoded = yield* decodeJsonBody(body).pipe(Effect.option);
  if (Option.isNone(decoded)) {
    return yield* output.raw(`${body}\n`);
  }
  const rows = decoded.value;
  if (!Array.isArray(rows) || !rows.every(isRowObject)) {
    return yield* output.raw(`${body}\n`);
  }
  yield* Effect.annotateCurrentSpan("query.row_count", rows.length);
  if (rows.length === 0) {
    return yield* emitQueryResult({
      encodeError,
      format,
      cols: [],
      data: [],
      agentMode,
      advisory: Option.none(),
    });
  }
  const orderedCols = orderedKeys(body);
  const cols = orderedCols.length > 0 ? [...orderedCols] : Object.keys(rows[0] ?? {});
  const data = rows.map((row) => cols.map((col) => row?.[col] ?? null));
  yield* emitQueryResult({
    encodeError,
    format,
    cols,
    data,
    agentMode,
    advisory: Option.none(),
    formatCell: formatLinkedValue,
  });
});
