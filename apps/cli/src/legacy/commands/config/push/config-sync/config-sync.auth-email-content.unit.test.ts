/**
 * Unit tests for config-sync.auth-email-content.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { loadAuthEmailContent } from "./config-sync.auth-email-content.ts";

const emptyEmail = {
  enable_signup: true,
  double_confirm_changes: true,
  enable_confirmations: false,
  secure_password_change: false,
  max_frequency: "1s",
  otp_length: 6,
  otp_expiry: 3600,
  template: {},
  notification: {},
};

describe("loadAuthEmailContent", () => {
  let workdir = "";

  afterEach(() => {
    if (workdir.length > 0) {
      rmSync(workdir, { recursive: true, force: true });
      workdir = "";
    }
  });

  function setup(): { cwd: string; supabaseDir: string } {
    workdir = mkdtempSync(join(tmpdir(), "auth-email-content-"));
    const supabaseDir = join(workdir, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    return { cwd: workdir, supabaseDir };
  }

  it("loads templates and notifications from the same project-root base", () => {
    const { cwd, supabaseDir } = setup();
    const templateDir = join(supabaseDir, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");
    writeFileSync(join(templateDir, "password_changed.html"), "<p>Changed</p>");

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      template: {
        invite: {
          subject: "You are invited",
          content_path: "./supabase/templates/invite.html",
        },
      },
      notification: {
        password_changed: {
          enabled: true,
          subject: "Password changed",
          content_path: "./supabase/templates/password_changed.html",
        },
      },
    });

    expect(content.template["invite"]).toBe("<h1>Invite</h1>");
    expect(content.notification["password_changed"]).toBe("<p>Changed</p>");
  });

  it("falls back to the legacy supabase-relative notification path", () => {
    const { cwd, supabaseDir } = setup();
    const templateDir = join(supabaseDir, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "password_changed.html"), "<p>Legacy location</p>");

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      notification: {
        password_changed: {
          enabled: true,
          subject: "Password changed",
          content_path: "./templates/password_changed.html",
        },
      },
    });

    expect(content.notification["password_changed"]).toBe("<p>Legacy location</p>");
  });

  it("falls back when the root-resolved path is a directory, not a file", () => {
    const { cwd, supabaseDir } = setup();
    mkdirSync(join(cwd, "templates", "n.html"), { recursive: true });
    mkdirSync(join(supabaseDir, "templates"), { recursive: true });
    writeFileSync(join(supabaseDir, "templates", "n.html"), "<p>Legacy file</p>");

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      notification: {
        password_changed: {
          enabled: true,
          subject: "s",
          content_path: "./templates/n.html",
        },
      },
    });

    expect(content.notification["password_changed"]).toBe("<p>Legacy file</p>");
  });

  it("prefers the project-root notification path over the legacy fallback", () => {
    const { cwd, supabaseDir } = setup();
    mkdirSync(join(cwd, "templates"), { recursive: true });
    mkdirSync(join(supabaseDir, "templates"), { recursive: true });
    writeFileSync(join(cwd, "templates", "n.html"), "<p>Root</p>");
    writeFileSync(join(supabaseDir, "templates", "n.html"), "<p>Legacy</p>");

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      notification: {
        password_changed: {
          enabled: true,
          subject: "s",
          content_path: "./templates/n.html",
        },
      },
    });

    expect(content.notification["password_changed"]).toBe("<p>Root</p>");
  });

  it("skips notification templates when disabled", () => {
    const { cwd } = setup();

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      notification: {
        password_changed: {
          enabled: false,
          subject: "Password changed",
          content_path: "./password_changed.html",
        },
      },
    });

    expect(content.notification).toEqual({});
  });

  it("skips entries with an empty content_path", () => {
    const { cwd } = setup();

    const content = loadAuthEmailContent(cwd, {
      ...emptyEmail,
      template: {
        invite: {
          subject: "You are invited",
          content_path: "",
        },
      },
    });

    expect(content.template).toEqual({});
    expect(content.notification).toEqual({});
  });

  it("throws a Go-shaped error when a template file is missing", () => {
    const { cwd } = setup();

    expect(() =>
      loadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: "./templates/missing.html",
          },
        },
      }),
    ).toThrow(/^Invalid config for auth\.email\.template\.invite\.content_path:/);
  });
});
