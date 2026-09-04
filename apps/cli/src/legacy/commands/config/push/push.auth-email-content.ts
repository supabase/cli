/**
 * `config push` reads HTML from `content_path` before building the auth push
 * body. Both templates and notifications resolve relative paths from the
 * project root (parent of `supabase/`); notifications additionally fall back
 * to the legacy `supabase/`-relative location when the root-resolved file is
 * missing, so configs written for older scaffolds keep working.
 */

import type { CliConfig } from "@supabase/config";
import { legacyResolveNotificationContentPath } from "../../../shared/legacy-config-validate.ts";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type AuthEmail = CliConfig["auth"]["email"];

/**
 * HTML bodies loaded from `content_path` for auth email templates and
 * notifications. Keys are template/notification names (e.g. `invite`,
 * `password_changed`); values are the raw file contents.
 */
export interface LegacyAuthEmailContent {
  readonly template: Readonly<Record<string, string>>;
  readonly notification: Readonly<Record<string, string>>;
}

const EMPTY_AUTH_EMAIL_CONTENT: LegacyAuthEmailContent = {
  template: {},
  notification: {},
};

/**
 * Reads a template HTML file, wrapping a filesystem error with an
 * `Invalid config for auth.email.<kind>.<name>.content_path: <cause>`
 * message — the CLI's established config-validation error shape.
 *
 * @param kind - `template` or `notification` (used in the error prefix).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param resolvedPath - Absolute path to the template HTML.
 * @returns File contents as UTF-8 text.
 * @throws When the file cannot be read.
 */
function readTemplateContent(
  kind: "template" | "notification",
  name: string,
  resolvedPath: string,
): string {
  try {
    return readFileSync(resolvedPath, "utf8");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid config for auth.email.${kind}.${name}.content_path: ${message}`);
  }
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
export function legacyLoadAuthEmailContent(cwd: string, email: AuthEmail): LegacyAuthEmailContent {
  const template: Record<string, string> = {};
  const notification: Record<string, string> = {};

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath = tmpl.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = isAbsolute(contentPath) ? contentPath : join(cwd, contentPath);
    template[name] = readTemplateContent("template", name, resolved);
  }

  for (const [name, notif] of Object.entries(email.notification)) {
    if (!notif.enabled) {
      continue;
    }
    const contentPath = notif.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = legacyResolveNotificationContentPath(cwd, contentPath);
    notification[name] = readTemplateContent("notification", name, resolved);
  }

  if (Object.keys(template).length === 0 && Object.keys(notification).length === 0) {
    return EMPTY_AUTH_EMAIL_CONTENT;
  }

  return { template, notification };
}
