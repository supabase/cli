/**
 * Minimal Postgres wire protocol mock server (Bun.listen TCP).
 *
 * Handles:
 *   - SSL negotiation (responds with 'N' — not supported)
 *   - Startup handshake (AuthenticationOk, ParameterStatus, BackendKeyData, ReadyForQuery)
 *   - Simple query protocol ('Q' messages):
 *       - SELECT → RowDescription + DataRow×n + CommandComplete + ReadyForQuery
 *       - COPY … TO STDOUT → CopyOutResponse + CopyDone + CommandComplete + ReadyForQuery
 *   - Extended query protocol (pgx v4 default):
 *       - Parse ('P') → ParseComplete
 *       - Describe ('D') → ParameterDescription + RowDescription / NoData
 *       - Bind ('B') → BindComplete
 *       - Execute ('E') → DataRow×n + CommandComplete
 *       - Close ('C') → CloseComplete
 *       - Sync ('S') → ReadyForQuery
 *   - Error injection: returns ErrorResponse for all queries (extended: on Execute)
 *   - Empty state: returns CommandComplete "SELECT 0" for extended Execute;
 *                  returns error for simple SELECT; returns empty COPY for COPY
 *   - Terminate ('X') → closes connection gracefully
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PgFixture {
  /** Lowercase column names matching Go Result struct field names. */
  columns: string[];
  /**
   * Per-column Postgres type OIDs (text format is used throughout).
   * Defaults to 25 (TEXT) for each column if omitted.
   * Common OIDs: TEXT=25, INT4=23, INT8=20, FLOAT8=701, BOOL=16
   */
  typeOids?: number[];
  /** Row data as string values (integers/floats/bools are string-encoded). */
  rows: (string | null)[][];
}

interface PgError {
  /** 5-char SQLSTATE code, e.g. "42501" (insufficient_privilege). */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Severity label. Defaults to "ERROR". */
  severity?: string;
}

type PgMockState =
  | { type: "empty" }
  | { type: "fixture"; fixture: PgFixture }
  | { type: "error"; error: PgError };

export interface PgMockHandle {
  readonly port: number;
  getState(): PgMockState;
  setState(state: PgMockState): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Wire protocol helpers
// ---------------------------------------------------------------------------

const TEXT_OID = 25;
const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION_3 = 196608;

function int32BE(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(value, 0);
  return b;
}

function int16BE(value: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeInt16BE(value, 0);
  return b;
}

function cstr(s: string): Buffer {
  return Buffer.from(s + "\0", "utf8");
}

function msg(type: number, payload: Buffer): Buffer {
  const len = payload.length + 4; // length includes itself
  const header = Buffer.allocUnsafe(5);
  header[0] = type;
  header.writeInt32BE(len, 1);
  return Buffer.concat([header, payload]);
}

function buildAuthOk(): Buffer {
  return msg(0x52, int32BE(0)); // 'R' + auth-type=0
}

function buildParameterStatus(key: string, value: string): Buffer {
  return msg(0x53, Buffer.concat([cstr(key), cstr(value)])); // 'S'
}

function buildBackendKeyData(): Buffer {
  return msg(0x4b, Buffer.concat([int32BE(1), int32BE(1)])); // 'K'
}

function buildReadyForQuery(): Buffer {
  return msg(0x5a, Buffer.from([0x49])); // 'Z' + 'I' (idle)
}

/** Builds RowDescription ('T') for a list of columns. */
function buildRowDescription(columns: string[], typeOids: number[]): Buffer {
  const fieldBufs: Buffer[] = [int16BE(columns.length)];
  for (let i = 0; i < columns.length; i++) {
    const oid = typeOids[i] ?? TEXT_OID;
    fieldBufs.push(
      cstr(columns[i]!), // column name
      int32BE(0), // table OID
      int16BE(0), // column attribute number
      int32BE(oid), // type OID
      int16BE(-1), // type size (-1 = variable)
      int32BE(-1), // type modifier
      int16BE(0), // format code (0 = text)
    );
  }
  return msg(0x54, Buffer.concat(fieldBufs)); // 'T'
}

/** Builds a DataRow ('D') message. */
function buildDataRow(values: (string | null)[]): Buffer {
  const parts: Buffer[] = [int16BE(values.length)];
  for (const v of values) {
    if (v === null) {
      parts.push(int32BE(-1)); // NULL
    } else {
      const encoded = Buffer.from(v, "utf8");
      parts.push(int32BE(encoded.length), encoded);
    }
  }
  return msg(0x44, Buffer.concat(parts)); // 'D'
}

/** Builds CommandComplete ('C'). */
function buildCommandComplete(tag: string): Buffer {
  return msg(0x43, cstr(tag)); // 'C'
}

/** Builds ErrorResponse ('E'). */
function buildErrorResponse(code: string, severity: string, message: string): Buffer {
  const payload = Buffer.concat([
    Buffer.from("S" + severity + "\0", "utf8"), // severity (localized)
    Buffer.from("V" + severity + "\0", "utf8"), // severity (non-localized)
    Buffer.from("C" + code + "\0", "utf8"), // SQLSTATE code
    Buffer.from("M" + message + "\0", "utf8"), // message
    Buffer.from([0]), // terminator
  ]);
  return msg(0x45, payload); // 'E'
}

/** Builds CopyOutResponse ('H') with text format and zero columns. */
function buildCopyOutResponse(): Buffer {
  // format=0 (text), num_cols=0
  return msg(0x48, Buffer.concat([Buffer.from([0]), int16BE(0)])); // 'H'
}

/** Builds CopyDone ('c'). */
function buildCopyDone(): Buffer {
  return msg(0x63, Buffer.alloc(0)); // 'c'
}

// Extended query protocol builders (server → client)

/** Builds ParseComplete ('1'). */
function buildParseComplete(): Buffer {
  return msg(0x31, Buffer.alloc(0)); // '1'
}

/** Builds ParameterDescription ('t') with the given parameter count (all OIDs=0 = unspecified). */
function buildParameterDescription(nparams: number): Buffer {
  const parts: Buffer[] = [int16BE(nparams)];
  for (let i = 0; i < nparams; i++) {
    parts.push(int32BE(0)); // OID 0 = unspecified
  }
  return msg(0x74, Buffer.concat(parts)); // 't'
}

/** Counts the number of distinct $N parameters in a SQL string. */
function countSqlParams(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

/** Extracts the query string from a Parse message payload (after the statement name). */
function parseSqlFromPayload(payload: Buffer): string {
  const nameEnd = payload.indexOf(0);
  if (nameEnd === -1) return "";
  const queryStart = nameEnd + 1;
  const queryEnd = payload.indexOf(0, queryStart);
  if (queryEnd === -1) return "";
  return payload.slice(queryStart, queryEnd).toString("utf8");
}

/** Builds NoData ('n') — sent for Describe when there are no result columns. */
function buildNoData(): Buffer {
  return msg(0x6e, Buffer.alloc(0)); // 'n'
}

/** Builds BindComplete ('2'). */
function buildBindComplete(): Buffer {
  return msg(0x32, Buffer.alloc(0)); // '2'
}

/** Builds CloseComplete ('3'). */
function buildCloseComplete(): Buffer {
  return msg(0x33, Buffer.alloc(0)); // '3'
}

// ---------------------------------------------------------------------------
// Socket state
// ---------------------------------------------------------------------------

interface SocketData {
  buf: Buffer;
  phase: "startup" | "query";
  /** Number of $N parameters in the most recently parsed statement. */
  paramCount: number;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildStartupResponse(): Buffer {
  return Buffer.concat([
    buildAuthOk(),
    buildParameterStatus("server_version", "14.0"),
    buildParameterStatus("client_encoding", "UTF8"),
    buildParameterStatus("DateStyle", "ISO, MDY"),
    buildParameterStatus("TimeZone", "UTC"),
    buildParameterStatus("integer_datetimes", "on"),
    buildBackendKeyData(),
    buildReadyForQuery(),
  ]);
}

function buildSelectResponse(state: PgMockState): Buffer {
  if (state.type === "error") {
    const { code, message, severity = "ERROR" } = state.error;
    return Buffer.concat([buildErrorResponse(code, severity, message), buildReadyForQuery()]);
  }

  if (state.type === "empty") {
    return Buffer.concat([
      buildErrorResponse(
        "08000",
        "ERROR",
        "pg-mock: no fixture configured — set /_ctrl/pg-fixture before running inspect",
      ),
      buildReadyForQuery(),
    ]);
  }

  // fixture
  const { columns, typeOids = [], rows } = state.fixture;
  const resolvedOids = columns.map((_, i) => typeOids[i] ?? TEXT_OID);
  const parts: Buffer[] = [buildRowDescription(columns, resolvedOids)];
  for (const row of rows) {
    parts.push(buildDataRow(row));
  }
  parts.push(buildCommandComplete(`SELECT ${rows.length}`));
  parts.push(buildReadyForQuery());
  return Buffer.concat(parts);
}

function buildCopyResponse(state: PgMockState): Buffer {
  if (state.type === "error") {
    const { code, message, severity = "ERROR" } = state.error;
    return Buffer.concat([buildErrorResponse(code, severity, message), buildReadyForQuery()]);
  }

  // Both "empty" and "fixture" states return an empty COPY response.
  // The CLI writes the received bytes to the CSV file (possibly 0 bytes),
  // which is enough for the file to exist and exit 0.
  return Buffer.concat([
    buildCopyOutResponse(),
    buildCopyDone(),
    buildCommandComplete("COPY 0"),
    buildReadyForQuery(),
  ]);
}

/**
 * Builds the response to a Describe ('D') statement message:
 *   ParameterDescription (nparams) + RowDescription (fixture) or NoData.
 */
function buildDescribeStatementResponse(state: PgMockState, nparams: number): Buffer {
  const paramDesc = buildParameterDescription(nparams);
  if (state.type === "fixture") {
    const { columns, typeOids = [] } = state.fixture;
    const resolvedOids = columns.map((_, i) => typeOids[i] ?? TEXT_OID);
    return Buffer.concat([paramDesc, buildRowDescription(columns, resolvedOids)]);
  }
  return Buffer.concat([paramDesc, buildNoData()]);
}

/**
 * Builds the response to an Execute ('E') message:
 *   DataRow × N + CommandComplete. No ReadyForQuery — that comes from Sync.
 */
function buildExecuteDataResponse(state: PgMockState): Buffer {
  if (state.type === "error") {
    const { code, message, severity = "ERROR" } = state.error;
    return buildErrorResponse(code, severity, message);
  }
  if (state.type === "fixture") {
    const { rows } = state.fixture;
    const parts: Buffer[] = rows.map(buildDataRow);
    parts.push(buildCommandComplete(`SELECT ${rows.length}`));
    return Buffer.concat(parts);
  }
  // empty state — return CommandComplete with 0 rows
  return buildCommandComplete("SELECT 0");
}

// ---------------------------------------------------------------------------
// Message processing
// ---------------------------------------------------------------------------

function processMessages(socket: Bun.Socket<SocketData>, getState: () => PgMockState): void {
  while (true) {
    const { buf, phase } = socket.data;

    if (phase === "startup") {
      // Startup message: 4-byte length followed by content.
      if (buf.length < 4) return;
      const msgLen = buf.readInt32BE(0);
      if (buf.length < msgLen) return;

      const code = buf.readInt32BE(4);
      socket.data.buf = buf.slice(msgLen);

      if (code === SSL_REQUEST_CODE) {
        // Respond with 'N' — SSL not supported
        socket.write(Buffer.from([0x4e]));
        // Stay in startup phase; client will send real startup next
        continue;
      }

      if (code === PROTOCOL_VERSION_3) {
        // Regular startup — respond and enter query phase
        socket.data.phase = "query";
        socket.write(buildStartupResponse());
        continue;
      }

      // Unknown protocol — close
      socket.end();
      return;
    }

    // Query phase: each message is [type:1][length:4][payload]
    if (buf.length < 5) return;
    const msgLen = buf.readInt32BE(1); // length field (includes itself, not the type byte)
    const totalLen = 1 + msgLen;
    if (buf.length < totalLen) return;

    const msgType = buf[0];
    const payload = buf.slice(5, totalLen);
    socket.data.buf = buf.slice(totalLen);

    if (msgType === 0x51) {
      // 'Q' — simple query (used by pgconn.CopyTo and simple-protocol callers)
      const query = payload.slice(0, payload.length - 1).toString("utf8");
      const isCopy = /^\s*COPY\s+/i.test(query);
      socket.write(isCopy ? buildCopyResponse(getState()) : buildSelectResponse(getState()));
    } else if (msgType === 0x50) {
      // 'P' Parse → extract param count from SQL, then ParseComplete
      const sql = parseSqlFromPayload(payload);
      socket.data.paramCount = countSqlParams(sql);
      socket.write(buildParseComplete());
    } else if (msgType === 0x44) {
      // 'D' Describe (client→server) → ParameterDescription + RowDescription / NoData
      // payload[0]: 'S' (0x53) = statement, 'P' (0x50) = portal
      const variant = payload.length > 0 ? payload[0] : 0x53;
      if (variant === 0x53) {
        socket.write(buildDescribeStatementResponse(getState(), socket.data.paramCount));
      } else {
        // Portal describe — RowDescription or NoData
        const s = getState();
        if (s.type === "fixture") {
          const { columns, typeOids = [] } = s.fixture;
          socket.write(
            buildRowDescription(
              columns,
              columns.map((_, i) => typeOids[i] ?? TEXT_OID),
            ),
          );
        } else {
          socket.write(buildNoData());
        }
      }
    } else if (msgType === 0x42) {
      // 'B' Bind → BindComplete
      socket.write(buildBindComplete());
    } else if (msgType === 0x45) {
      // 'E' Execute → DataRow × N + CommandComplete (ReadyForQuery comes from Sync)
      socket.write(buildExecuteDataResponse(getState()));
    } else if (msgType === 0x43) {
      // 'C' Close → CloseComplete
      socket.write(buildCloseComplete());
    } else if (msgType === 0x53) {
      // 'S' Sync → ReadyForQuery
      socket.write(buildReadyForQuery());
    } else if (msgType === 0x58) {
      // 'X' Terminate → close connection
      socket.end();
      return;
    }
    // 'H' (0x48) Flush — no response required (we write synchronously)
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function startPgMock(): PgMockHandle {
  let state: PgMockState = { type: "empty" };

  const server = Bun.listen<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buf: Buffer.alloc(0), phase: "startup", paramCount: 0 };
      },
      data(socket, data) {
        socket.data.buf = Buffer.concat([socket.data.buf, Buffer.from(data)]);
        try {
          processMessages(socket, () => state);
        } catch (err) {
          console.error("[pg-mock] error processing message:", err);
          socket.end();
        }
      },
      close(_socket) {},
      error(_socket, err) {
        console.error("[pg-mock] socket error:", err);
      },
    },
  });

  return {
    get port() {
      return server.port;
    },
    getState() {
      return state;
    },
    setState(next) {
      state = next;
    },
    stop() {
      server.stop();
    },
  };
}
