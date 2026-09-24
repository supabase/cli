/**
 * `config push` reads HTML from `content_path` before building the auth push body. Templates
 * and notifications resolve relative paths from the project root (parent of `supabase/`);
 * notifications additionally fall back to the legacy `supabase/`-relative location when the
 * root-resolved file is missing. Containment is enforced centrally by
 * `resolveEmailTemplateContentPath` in `config-validate.ts`, not locally here.
 */

import type { CliConfig } from "@supabase/config";
import { Effect, FileSystem } from "effect";
import {
  emailContentPathReadErrorMessage,
  resolveEmailTemplateContentPath,
} from "../../../command-internal/config-validate.ts";
import { ConfigPushLoadConfigError } from "./push.errors.ts";

type AuthEmail = CliConfig["auth"]["email"];

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

/**
 * Reads a template HTML file, wrapping a filesystem error with the CLI's
 * established config-validation error shape.
 *
 * @param kind - `template` or `notification` (used in the error prefix).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param resolvedPath - Absolute path to the template HTML.
 * @returns File contents as UTF-8 text.
 */
const readTemplateContent = Effect.fnUntraced(function* (
  kind: "template" | "notification",
  name: string,
  resolvedPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(resolvedPath).pipe(
    Effect.mapError(
      (error) =>
        new ConfigPushLoadConfigError({
          message: emailContentPathReadErrorMessage(
            kind,
            name,
            error.reason.cause ?? error.reason.description ?? error.reason,
          ),
        }),
    ),
  );
  // Keeps a leading BOM, which `readFileString` would strip from the pushed HTML.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
});

const resolveContentPath = (
  options: Parameters<typeof resolveEmailTemplateContentPath>[0],
): Effect.Effect<string | undefined, ConfigPushLoadConfigError> =>
  Effect.try({
    try: () => resolveEmailTemplateContentPath(options),
    catch: (cause) =>
      new ConfigPushLoadConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * Loads auth email template HTML from disk for `config push`.
 *
 * Templates and notifications resolve `content_path` from the project root;
 * notifications are only read when `enabled = true`.
 *
 * @param cwd - Discovered project root (parent of `supabase/`).
 * @param email - Decoded `config.auth.email` from `@supabase/config`.
 * @returns Loaded HTML keyed by template/notification name. Empty records when
 *   nothing was configured or all `content_path` values were empty. Fails when a configured
 *   `content_path` points to a missing or unreadable file.
 */
export const loadAuthEmailContent = Effect.fnUntraced(function* (cwd: string, email: AuthEmail) {
  const template: Record<string, string> = {};
  const notification: Record<string, string> = {};

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath = tmpl.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = yield* resolveContentPath({
      section: "template",
      name,
      contentPath,
      // Already checked contentPath.length > 0 above, so this can never fire.
      contentPresent: false,
      base: cwd,
    });
    if (resolved === undefined) {
      continue;
    }
    template[name] = yield* readTemplateContent("template", name, resolved);
  }

  for (const [name, notif] of Object.entries(email.notification)) {
    if (!notif.enabled) {
      continue;
    }
    const contentPath = notif.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = yield* resolveContentPath({
      section: "notification",
      name,
      contentPath,
      // Already checked contentPath.length > 0 above, so this can never fire.
      contentPresent: false,
      base: cwd,
    });
    if (resolved === undefined) {
      continue;
    }
    notification[name] = yield* readTemplateContent("notification", name, resolved);
  }

  if (Object.keys(template).length === 0 && Object.keys(notification).length === 0) {
    return EMPTY_AUTH_EMAIL_CONTENT;
  }

  return { template, notification };
});
