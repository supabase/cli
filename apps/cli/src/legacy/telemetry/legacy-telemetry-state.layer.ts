import { Effect, FileSystem, Layer, Path } from "effect";
import { homedir } from "node:os";

import { LegacyTelemetryState } from "./legacy-telemetry-state.service.ts";

interface State {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  readonly session_last_active: string;
  readonly distinct_id?: string;
  readonly schema_version: number;
}

const SCHEMA_VERSION = 1;
const SESSION_ROTATION_MS = 30 * 60 * 1000;

function telemetryPath(env: Record<string, string | undefined>, pathSvc: Path.Path): string {
  const supabaseHome = env["SUPABASE_HOME"]?.trim();
  if (supabaseHome !== undefined && supabaseHome.length > 0) {
    return pathSvc.join(supabaseHome, "telemetry.json");
  }
  return pathSvc.join(homedir(), ".supabase", "telemetry.json");
}

function isStringField(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0;
}

interface PriorState {
  enabled?: boolean;
  device_id?: string;
  session_id?: string;
  session_last_active?: string;
  distinct_id?: string;
}

function readExistingState(text: string): PriorState | undefined {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const out: PriorState = {};
    if (typeof record.enabled === "boolean") out.enabled = record.enabled;
    if (isStringField(parsed, "device_id")) out.device_id = record.device_id as string;
    if (isStringField(parsed, "session_id")) out.session_id = record.session_id as string;
    if (isStringField(parsed, "session_last_active")) {
      out.session_last_active = record.session_last_active as string;
    }
    if (isStringField(parsed, "distinct_id")) out.distinct_id = record.distinct_id as string;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Writes `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on every command run.
 * Mirrors Go's `LoadOrCreateState` (`apps/cli-go/internal/telemetry/state.go:74-98`):
 *
 *  - Reuses an existing `device_id` if the file is present.
 *  - Rotates `session_id` if `session_last_active` is older than 30 minutes.
 *  - Always sets `enabled: true` on a fresh state (matches Go — the field is
 *    only flipped to `false` if the user has run `supabase telemetry disable`,
 *    in which case the prior value is preserved). The
 *    `SUPABASE_TELEMETRY_DISABLED` / `DO_NOT_TRACK` env vars suppress event
 *    delivery, not state-file writes.
 *  - Always writes — Go persists the state file even when telemetry is
 *    disabled; only event delivery is suppressed.
 *
 * Best-effort: filesystem or JSON parse errors are swallowed.
 */
export const legacyTelemetryStateLayer = Layer.effect(
  LegacyTelemetryState,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const env = process.env;

    return LegacyTelemetryState.of({
      flush: Effect.gen(function* () {
        const filePath = telemetryPath(env, pathSvc);

        const existing = yield* fs.readFileString(filePath).pipe(
          Effect.option,
          Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
        );
        const prior = existing !== undefined ? readExistingState(existing) : undefined;

        const now = new Date();
        const nowIso = now.toISOString();

        const priorActive =
          prior?.session_last_active !== undefined
            ? new Date(prior.session_last_active).getTime()
            : 0;
        const expired =
          !Number.isFinite(priorActive) || now.getTime() - priorActive > SESSION_ROTATION_MS;

        const state: State = {
          enabled: prior?.enabled ?? true,
          device_id: prior?.device_id ?? crypto.randomUUID(),
          session_id:
            !expired && prior?.session_id !== undefined ? prior.session_id : crypto.randomUUID(),
          session_last_active: nowIso,
          ...(prior?.distinct_id !== undefined ? { distinct_id: prior.distinct_id } : {}),
          schema_version: SCHEMA_VERSION,
        };

        yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, JSON.stringify(state));
      }).pipe(Effect.ignore),
    });
  }),
);
