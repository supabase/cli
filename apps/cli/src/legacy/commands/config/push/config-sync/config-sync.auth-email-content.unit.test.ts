/**
 * Unit tests for config-sync.auth-email-content.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadAuthEmailContent,
  projectDirsFromConfigPath,
} from "./config-sync.auth-email-content.ts";

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

describe("projectDirsFromConfigPath", () => {
  it("derives project root and supabase dir from a config file path", () => {
    expect(projectDirsFromConfigPath("/home/user/myapp/supabase/config.toml")).toEqual({
      projectRoot: "/home/user/myapp",
      supabaseDir: "/home/user/myapp/supabase",
    });
  });
});

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
