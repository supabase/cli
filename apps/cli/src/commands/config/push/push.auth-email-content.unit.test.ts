/**
 * Unit tests for push.auth-email-content.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { legacyLoadAuthEmailContent } from "./push.auth-email-content.ts";

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

describe("legacyLoadAuthEmailContent", () => {
  let workdir = "";
  let outsideDir = "";

  afterEach(() => {
    if (workdir.length > 0) {
      rmSync(workdir, { recursive: true, force: true });
      workdir = "";
    }
    if (outsideDir.length > 0) {
      rmSync(outsideDir, { recursive: true, force: true });
      outsideDir = "";
    }
  });

  function setup(): { cwd: string; supabaseDir: string } {
    workdir = mkdtempSync(join(tmpdir(), "auth-email-content-"));
    const supabaseDir = join(workdir, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    return { cwd: workdir, supabaseDir };
  }

  /**
   * Writes a real file outside `cwd`, in a sibling tmpdir, so a containment
   * test proves the escape check fires rather than a missing-file error.
   */
  function setupOutsideFile(): string {
    outsideDir = mkdtempSync(join(tmpdir(), "auth-email-content-outside-"));
    const outsideFile = join(outsideDir, "secret.html");
    writeFileSync(outsideFile, "<p>Outside</p>");
    return outsideFile;
  }

  it("loads templates and notifications from the same project-root base", () => {
    const { cwd, supabaseDir } = setup();
    const templateDir = join(supabaseDir, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");
    writeFileSync(join(templateDir, "password_changed.html"), "<p>Changed</p>");

    const content = legacyLoadAuthEmailContent(cwd, {
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

    const content = legacyLoadAuthEmailContent(cwd, {
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

    const content = legacyLoadAuthEmailContent(cwd, {
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

    const content = legacyLoadAuthEmailContent(cwd, {
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

    const content = legacyLoadAuthEmailContent(cwd, {
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

    const content = legacyLoadAuthEmailContent(cwd, {
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

  it("throws a descriptive error when a template file is missing", () => {
    const { cwd } = setup();

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
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

  it("rejects an absolute template content_path outside the project root", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: outsideFile,
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.template\.invite\.content_path: resolves outside the project root/,
    );
  });

  it("rejects an absolute notification content_path outside the project root", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        notification: {
          password_changed: {
            enabled: true,
            subject: "Password changed",
            content_path: outsideFile,
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.notification\.password_changed\.content_path: resolves outside the project root/,
    );
  });

  it("rejects a relative template content_path that escapes the project root via ..", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();
    const escapePath = relative(cwd, outsideFile);

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: escapePath,
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.template\.invite\.content_path: resolves outside the project root/,
    );
  });

  it("rejects a relative notification content_path that escapes the project root via ..", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();
    const escapePath = relative(cwd, outsideFile);

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        notification: {
          password_changed: {
            enabled: true,
            subject: "Password changed",
            content_path: escapePath,
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.notification\.password_changed\.content_path: resolves outside the project root/,
    );
  });

  it("rejects a template content_path that is an in-root symlink to an outside file", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();
    const symlinkPath = join(cwd, "evil-template.html");
    symlinkSync(outsideFile, symlinkPath);

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: "./evil-template.html",
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.template\.invite\.content_path: resolves outside the project root/,
    );
  });

  it("rejects a notification content_path that is an in-root symlink to an outside file", () => {
    const { cwd } = setup();
    const outsideFile = setupOutsideFile();
    const symlinkPath = join(cwd, "evil-notification.html");
    symlinkSync(outsideFile, symlinkPath);

    expect(() =>
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        notification: {
          password_changed: {
            enabled: true,
            subject: "Password changed",
            content_path: "./evil-notification.html",
          },
        },
      }),
    ).toThrow(
      /^Invalid config for auth\.email\.notification\.password_changed\.content_path: resolves outside the project root/,
    );
  });

  it("does not raise the containment error for a template content_path resolving to exactly the project root", () => {
    const { cwd } = setup();

    let thrown: unknown;
    try {
      legacyLoadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: ".",
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/resolves outside the project root/);
    expect(message).toMatch(/^Invalid config for auth\.email\.template\.invite\.content_path:/);
  });
});
