/**
 * `config push` reads HTML from `content_path` before building the auth push
 * subset. Both templates and notifications resolve relative paths from the
 * project root (parent of `supabase/`); notifications additionally fall back
 * to the legacy `supabase/`-relative location when the root-resolved file is
 * missing, so configs written for older scaffolds keep working.
 */

import type { ProjectConfig } from "@supabase/config";
import { Data, Effect, FileSystem, Path } from "effect";
import { legacyResolveNotificationContentPath } from "../../../../shared/legacy-config-validate.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../../shared/telemetry/error-actionability.ts";

type AuthEmail = ProjectConfig["auth"]["email"];

/**
 * HTML bodies loaded from `content_path` for auth email templates and
 * notifications. Keys are template/notification names (e.g. `invite`,
 * `password_changed`); values are the raw file contents.
 */
export interface AuthEmailContent {
  readonly template: Readonly<Record<string, string>>;
  readonly notification: Readonly<Record<string, string>>;
}

const EMPTY_AUTH_EMAIL_CONTENT: AuthEmailContent = {
  template: {},
  notification: {},
};

export class LegacyAuthEmailContentError extends Data.TaggedError("LegacyAuthEmailContentError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Reads a template HTML file and wraps filesystem errors in Go-shaped messages.
 *
 * @param kind - `template` or `notification` (used in the error prefix).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param resolvedPath - Absolute path to the template HTML.
 * @returns File contents as UTF-8 text.
 * @throws When the file cannot be read.
 */
function readTemplateContent(
  fileSystem: FileSystem.FileSystem,
  kind: "template" | "notification",
  name: string,
  resolvedPath: string,
): Effect.Effect<string, LegacyAuthEmailContentError> {
  return fileSystem.readFileString(resolvedPath).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyAuthEmailContentError({
          message: `Invalid config for auth.email.${kind}.${name}.content_path: ${cause.message}`,
        }),
    ),
  );
}

/**
 * Loads auth email template HTML from disk for `config push`.
 *
 * Templates and notifications resolve `content_path` from the project root;
 * notifications are only read when `enabled = true`.
 *
 * @param cwd - Discovered project root (parent of `supabase/`).
 * @param email - Decoded `config.auth.email` from `@supabase/config`.
 * @returns Loaded HTML keyed by template/notification name. Empty records when
 *   nothing was configured or all `content_path` values were empty.
 * @throws When a configured `content_path` points to a missing or unreadable file.
 */
export const loadAuthEmailContent = Effect.fnUntraced(function* (cwd: string, email: AuthEmail) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const template: Record<string, string> = {};
  const notification: Record<string, string> = {};

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath = tmpl.content_path ?? "";
    if (contentPath.length === 0) continue;
    const resolved = path.isAbsolute(contentPath) ? contentPath : path.join(cwd, contentPath);
    template[name] = yield* readTemplateContent(fileSystem, "template", name, resolved);
  }

  for (const [name, notif] of Object.entries(email.notification)) {
    if (!notif.enabled) continue;
    const contentPath = notif.content_path ?? "";
    if (contentPath.length === 0) continue;
    const resolved = yield* legacyResolveNotificationContentPath(
      path,
      fileSystem,
      cwd,
      contentPath,
    );
    notification[name] = yield* readTemplateContent(fileSystem, "notification", name, resolved);
  }

  return Object.keys(template).length === 0 && Object.keys(notification).length === 0
    ? EMPTY_AUTH_EMAIL_CONTENT
    : { template, notification };
});
