import { describe, expect, it } from "vitest";

import { getHelpDoc } from "../../docs/command-docs.ts";
import { apiCommand } from "./api.command.ts";
import { apiRequestCommand } from "./request.command.ts";
import { apiRoutesCommand } from "./routes.command.ts";
import {
  getPlatformDefaultMethod,
  listPlatformRouteDescriptors,
  platformRouteGroupChoices,
  platformRouteDescriptorsByPath,
  renderPlatformRouteDescriptors,
} from "./platform-routes.ts";

describe("platform route discovery", () => {
  it("lists each route path exactly once", () => {
    const paths = listPlatformRouteDescriptors({}).map((route) => route.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it("filters routes by group", () => {
    const routes = listPlatformRouteDescriptors({ group: "projects" });
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes.map((route) => route.group))).toEqual(new Set(["Projects"]));
  });

  it("filters routes by method", () => {
    const routes = listPlatformRouteDescriptors({ method: "PATCH" });
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.methods.some((method) => method.method === "PATCH"))).toBe(
      true,
    );
  });

  it("filters routes by search text across path, group, and all method summaries", () => {
    const routes = listPlatformRouteDescriptors({ search: "updates a project's auth config" });

    expect(routes).toEqual([
      expect.objectContaining({
        path: "/v1/projects/{ref}/config/auth",
      }),
    ]);
  });

  it("derives default methods with the same policy as route execution", () => {
    expect(getPlatformDefaultMethod(["POST"])).toEqual(expect.objectContaining({ value: "POST" }));
    expect(getPlatformDefaultMethod(["GET", "PATCH"])).toEqual(
      expect.objectContaining({ value: "GET" }),
    );
    expect(getPlatformDefaultMethod(["POST", "DELETE"])).toEqual(
      expect.objectContaining({ _tag: "None" }),
    );
  });

  it("renders multi-method routes with aligned method summaries", () => {
    const route = platformRouteDescriptorsByPath.get("/v1/projects/{ref}/config/auth");
    expect(route).toBeDefined();
    const rendered = renderPlatformRouteDescriptors(route ? [route] : []);

    expect(rendered).toContain("Auth");
    expect(rendered).toContain("GET    Gets project's auth config");
    expect(rendered).toContain("PATCH  Updates a project's auth config");
    expect(rendered).not.toContain("methods:");
    expect(rendered).not.toContain("default:");
    expect(rendered).not.toContain("(default)");
  });

  it("renders single-method routes without extra punctuation", () => {
    const route = platformRouteDescriptorsByPath.get("/v1/profile");
    expect(route).toBeDefined();
    const rendered = renderPlatformRouteDescriptors(route ? [route] : []);

    expect(rendered).toContain("GET  Gets the user's profile");
    expect(rendered).not.toContain("(default)");
    expect(rendered).not.toContain("GET:");
  });

  it("derives lowercase slug choices from group labels", () => {
    expect(platformRouteGroupChoices).toEqual(
      expect.arrayContaining(["projects", "edge-functions"]),
    );
  });

  it("keeps a flat route map available by path", () => {
    expect(platformRouteDescriptorsByPath.get("/v1/projects")).toEqual(
      expect.objectContaining({
        path: "/v1/projects",
        group: "Projects",
        methods: [
          {
            method: "GET",
            summary: "List all projects",
            isDefault: true,
          },
          {
            method: "POST",
            summary: "Create a project",
            isDefault: false,
          },
        ],
      }),
    );
  });

  it("shows the routes subcommand in api help docs", () => {
    const helpDoc = getHelpDoc(apiCommand, ["supabase", "api"]);

    expect(helpDoc.subcommands?.flatMap((group) => group.commands)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "routes",
          shortDescription: "Browse available API routes",
        }),
        expect.objectContaining({
          name: "request",
          shortDescription: "Inspect or run one API route",
        }),
      ]),
    );
    expect(helpDoc.examples).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "supabase api routes" })]),
    );
    expect(helpDoc.subcommands?.flatMap((group) => group.commands)).toBeDefined();
  });

  it("shows lowercase group choices in routes help docs", () => {
    const helpDoc = getHelpDoc(apiRoutesCommand, ["supabase", "api", "routes"]);

    expect(helpDoc.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "group",
          type: "choice",
          description: expect.objectContaining({
            value: expect.stringContaining("edge-functions"),
          }),
        }),
      ]),
    );
  });

  it("keeps route-specific help on the request subcommand", () => {
    const helpDoc = getHelpDoc(apiRequestCommand, ["supabase", "api", "request"]);

    expect(helpDoc.args).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "route" })]),
    );
    expect(helpDoc.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "supabase api request /v1/projects",
        }),
      ]),
    );
  });
});
