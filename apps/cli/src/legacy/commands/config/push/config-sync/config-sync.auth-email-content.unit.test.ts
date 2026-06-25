/**
 * Unit tests for config-sync.auth-email-content.ts — parity with Go
 * `(*email).validate` and `(*baseConfig).resolve` path rules.
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

  it("loads transactional templates relative to the project root", () => {
    const { cwd, supabaseDir } = setup();
    const templateDir = join(cwd, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");

    const content = loadAuthEmailContent(cwd, supabaseDir, {
      ...emptyEmail,
      template: {
        invite: {
          subject: "You are invited",
          content_path: "./templates/invite.html",
        },
      },
    });

    expect(content.template["invite"]).toBe("<h1>Invite</h1>");
    expect(content.notification).toEqual({});
  });

  it("loads notification templates relative to supabase/", () => {
    const { cwd, supabaseDir } = setup();
    writeFileSync(join(supabaseDir, "password_changed.html"), "<p>Changed</p>");

    const content = loadAuthEmailContent(cwd, supabaseDir, {
      ...emptyEmail,
      notification: {
        password_changed: {
          enabled: true,
          subject: "Password changed",
          content_path: "./password_changed.html",
        },
      },
    });

    expect(content.notification["password_changed"]).toBe("<p>Changed</p>");
    expect(content.template).toEqual({});
  });

  it("skips notification templates when disabled", () => {
    const { cwd, supabaseDir } = setup();
    writeFileSync(join(supabaseDir, "password_changed.html"), "<p>Changed</p>");

    const content = loadAuthEmailContent(cwd, supabaseDir, {
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
    const { cwd, supabaseDir } = setup();

    const content = loadAuthEmailContent(cwd, supabaseDir, {
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
    const { cwd, supabaseDir } = setup();

    expect(() =>
      loadAuthEmailContent(cwd, supabaseDir, {
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
