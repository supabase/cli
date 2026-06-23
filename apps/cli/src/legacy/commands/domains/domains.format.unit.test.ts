import { describe, expect, it } from "vitest";

import {
  formatHostnameStatus,
  formatSslStructDump,
  type LegacyHostnameResponse,
} from "./domains.format.ts";

type Status = Exclude<LegacyHostnameResponse["status"], undefined>;
type Ssl = LegacyHostnameResponse["data"]["result"]["ssl"];

function makeResponse(args: {
  readonly status?: Status;
  readonly customHostname?: string;
  readonly customOriginServer?: string;
  readonly ssl: Ssl;
}): LegacyHostnameResponse {
  const hostname = args.customHostname ?? "example.com";
  return {
    status: args.status,
    custom_hostname: hostname,
    data: {
      success: true,
      errors: [],
      messages: [],
      result: {
        id: "id-1",
        hostname,
        ssl: args.ssl,
        ownership_verification: { type: "txt", name: "n", value: "v" },
        custom_origin_server: args.customOriginServer ?? "origin.example.com",
        status: "active",
      },
    },
  };
}

describe("formatHostnameStatus", () => {
  it("reports completion for 5_services_reconfigured (no trailing newline)", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "5_services_reconfigured",
        customHostname: "shop.acme.dev",
        ssl: { status: "active", validation_records: [] },
      }),
    );
    expect(out).toBe(
      "Custom hostname setup completed. Project is now accessible at shop.acme.dev.",
    );
  });

  it("renders the CNAME activation instructions for 4_origin_setup_completed", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "4_origin_setup_completed",
        customHostname: "shop.acme.dev",
        customOriginServer: "abc.supabase.co",
        ssl: { status: "active", validation_records: [] },
      }),
    );
    expect(out).toBe(
      "Custom hostname configuration complete, and ready for activation.\n\n" +
        "Please ensure that your custom domain is set up as a CNAME record to your Supabase subdomain:\n" +
        "shop.acme.dev CNAME -> abc.supabase.co",
    );
  });

  it("reports an initializing SSL state during verification", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: { status: "initializing", validation_records: [] },
      }),
    );
    expect(out).toBe(
      "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n",
    );
  });

  it("infers in-progress status from sparse processing responses", () => {
    const out = formatHostnameStatus(
      makeResponse({
        ssl: { status: "initializing" },
      }),
    );
    expect(out).toBe(
      "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n",
    );
  });

  it("short-circuits to a CAA mismatch hint when a validation error mentions caa_error", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "3_challenge_verified",
        ssl: {
          status: "pending_validation",
          validation_records: [],
          validation_errors: [{ message: "some unrelated error" }, { message: "boom caa_error!" }],
        },
      }),
    );
    expect(out).toBe(
      'CAA mismatch; please remove any existing CAA records on your domain, or add one for "digicert.com"\n',
    );
  });

  it("joins multiple non-CAA SSL validation errors", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: {
          status: "pending_validation",
          validation_records: [],
          validation_errors: [{ message: "first" }, { message: "second" }],
        },
      }),
    );
    expect(out).toBe("SSL validation errors: \n\t- first\n\t- second\n");
  });

  it("dumps the ssl struct when there is not exactly one validation record (none)", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: { status: "pending_validation", validation_records: [] },
      }),
    );
    expect(out).toBe(
      "expected a single SSL verification record, received: {Status:pending_validation ValidationErrors:<nil> ValidationRecords:[]}",
    );
  });

  it("treats missing validation records as an empty list", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: { status: "pending_validation" },
      }),
    );
    expect(out).toBe(
      "expected a single SSL verification record, received: {Status:pending_validation ValidationErrors:<nil> ValidationRecords:[]}",
    );
  });

  it("dumps the ssl struct when there are multiple validation records", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "3_challenge_verified",
        ssl: {
          status: "pending_validation",
          validation_records: [
            { txt_name: "_a", txt_value: "v1" },
            { txt_name: "_b", txt_value: "v2" },
          ],
        },
      }),
    );
    expect(out).toBe(
      "expected a single SSL verification record, received: {Status:pending_validation ValidationErrors:<nil> ValidationRecords:[{TxtName:_a TxtValue:v1} {TxtName:_b TxtValue:v2}]}",
    );
  });

  it("treats an empty validation_errors array as no errors and falls through to records", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: {
          status: "pending_validation",
          validation_records: [{ txt_name: "_acme", txt_value: "token" }],
          validation_errors: [],
        },
      }),
    );
    expect(out).toBe(
      "Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\n" +
        "Required outstanding validation records:\n" +
        "\t_acme TXT -> token",
    );
  });

  it("omits the record line when the single record has an empty txt_name", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "2_initiated",
        ssl: {
          status: "pending_validation",
          validation_records: [{ txt_name: "", txt_value: "token" }],
        },
      }),
    );
    expect(out).toBe(
      "Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\n" +
        "Required outstanding validation records:\n",
    );
  });

  it("reports the not-started state", () => {
    const out = formatHostnameStatus(
      makeResponse({
        status: "1_not_started",
        ssl: { status: "active", validation_records: [] },
      }),
    );
    expect(out).toBe("Custom hostname configuration not started.\n");
  });
});

describe("formatSslStructDump", () => {
  it("renders <nil> when validation_errors is absent", () => {
    expect(formatSslStructDump({ status: "x", validation_records: [] })).toBe(
      "{Status:x ValidationErrors:<nil> ValidationRecords:[]}",
    );
  });

  it("renders the validation errors slice when present", () => {
    expect(
      formatSslStructDump({
        status: "x",
        validation_records: [{ txt_name: "_n", txt_value: "v" }],
        validation_errors: [{ message: "oops" }],
      }),
    ).toBe(
      "{Status:x ValidationErrors:&[{Message:oops}] ValidationRecords:[{TxtName:_n TxtValue:v}]}",
    );
  });
});
