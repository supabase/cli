import { Effect, Option } from "effect";

import { jsonResponse } from "../../../tests/helpers/command-mocks.ts";
import { describeHostedTargetSelection } from "../../../tests/helpers/hosted-target-selection.ts";
import { branchRow } from "../../../tests/helpers/remote-selection.ts";
import { branchesCreate } from "./create/create.handler.ts";
import { branchesDelete } from "./delete/delete.handler.ts";
import { branchesDisable } from "./disable/disable.handler.ts";
import { branchesGet } from "./get/get.handler.ts";
import { branchesList } from "./list/list.handler.ts";
import { branchesPause } from "./pause/pause.handler.ts";
import { branchesUnpause } from "./unpause/unpause.handler.ts";
import { branchesUpdate } from "./update/update.handler.ts";

const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_PROJECT_REF = "cccccccccccccccccccc";

const featBranch = (projectRef: string) =>
  branchRow("feat-x", {
    id: BRANCH_UUID,
    project_ref: projectRef,
    parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  });

const BRANCH_CONFIG = {
  ref: BRANCH_UUID,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

/** A parent project with one branch, `feat-x`, whose project ref is `lookupRef`. */
const respondWithBranch = (lookupRef: string) => (request: Parameters<typeof jsonResponse>[0]) => {
  const { pathname } = new URL(request.url);
  const reply = (status: number, body: unknown) =>
    Effect.succeed(jsonResponse(request, status, body));
  if (request.method === "GET" && /^\/v1\/projects\/[a-z]{20}\/branches\/feat-x$/.test(pathname)) {
    return reply(200, featBranch(lookupRef));
  }
  if (request.method === "GET" && /^\/v1\/projects\/[a-z]{20}\/branches$/.test(pathname)) {
    return reply(200, [featBranch(lookupRef)]);
  }
  if (request.method === "POST" && /^\/v1\/projects\/[a-z]{20}\/branches$/.test(pathname)) {
    return reply(201, featBranch(lookupRef));
  }
  if (request.method === "GET" && pathname.startsWith("/v1/branches/")) {
    return reply(200, BRANCH_CONFIG);
  }
  if (request.method === "DELETE" && pathname.startsWith("/v1/branches/")) {
    return reply(200, { message: "ok" });
  }
  if (request.method === "PATCH" && pathname.startsWith("/v1/branches/")) {
    return reply(200, featBranch(BRANCH_PROJECT_REF));
  }
  return reply(200, null);
};

describeHostedTargetSelection("branches list", {
  mode: "parent",
  respond: respondWithBranch(BRANCH_PROJECT_REF),
  run: (flags) => branchesList(flags),
});

describeHostedTargetSelection("branches create", {
  mode: "parent",
  operands: ["feat-x"],
  respond: respondWithBranch(BRANCH_PROJECT_REF),
  run: (flags) =>
    branchesCreate({
      ...flags,
      name: Option.some("feat-x"),
      region: Option.none(),
      size: Option.none(),
      persistent: Option.none(),
      withData: Option.none(),
      notifyUrl: Option.none(),
      gitBranch: Option.none(),
    }),
});

describeHostedTargetSelection("branches get", {
  mode: "parent",
  operands: ["feat-x"],
  respond: respondWithBranch(BRANCH_UUID),
  run: (flags) => branchesGet({ ...flags, name: Option.some("feat-x") }),
});

describeHostedTargetSelection("branches update", {
  mode: "parent",
  operands: ["feat-x", "--persistent"],
  respond: respondWithBranch(BRANCH_UUID),
  run: (flags) =>
    branchesUpdate({
      ...flags,
      branchId: Option.some("feat-x"),
      name: Option.none(),
      gitBranch: Option.none(),
      persistent: Option.some(true),
      status: Option.none(),
      notifyUrl: Option.none(),
    }),
});

describeHostedTargetSelection("branches delete", {
  mode: "parent",
  operands: ["feat-x"],
  respond: respondWithBranch(BRANCH_UUID),
  run: (flags) => branchesDelete({ ...flags, name: Option.some("feat-x") }),
});

describeHostedTargetSelection("branches pause", {
  mode: "parent",
  operands: ["feat-x"],
  respond: respondWithBranch(BRANCH_PROJECT_REF),
  run: (flags) => branchesPause({ ...flags, name: Option.some("feat-x") }),
});

describeHostedTargetSelection("branches unpause", {
  mode: "parent",
  operands: ["feat-x"],
  respond: respondWithBranch(BRANCH_PROJECT_REF),
  run: (flags) => branchesUnpause({ ...flags, name: Option.some("feat-x") }),
});

describeHostedTargetSelection("branches disable", {
  mode: "parent",
  respond: respondWithBranch(BRANCH_PROJECT_REF),
  run: (flags) => branchesDisable(flags),
});
