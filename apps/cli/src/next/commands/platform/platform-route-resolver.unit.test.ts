import { describe, expect, it } from "vitest";

import { PlatformMethodSelectionError, PlatformRouteNotFoundError } from "./platform.errors.ts";
import { resolvePlatformOperationDescriptor } from "./platform-route-resolver.ts";

describe("platform route resolver", () => {
  it("resolves an exact route and method pair", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/projects", "POST");

    expect(descriptor).not.toBeInstanceOf(PlatformRouteNotFoundError);
    expect(descriptor).not.toBeInstanceOf(PlatformMethodSelectionError);
    if (
      descriptor instanceof PlatformRouteNotFoundError ||
      descriptor instanceof PlatformMethodSelectionError
    ) {
      return;
    }
    expect(descriptor.operationId).toBe("v1CreateAProject");
  });

  it("normalizes routes without a leading slash", () => {
    const descriptor = resolvePlatformOperationDescriptor("v1/projects", "GET");

    expect(descriptor).not.toBeInstanceOf(PlatformRouteNotFoundError);
    expect(descriptor).not.toBeInstanceOf(PlatformMethodSelectionError);
    if (
      descriptor instanceof PlatformRouteNotFoundError ||
      descriptor instanceof PlatformMethodSelectionError
    ) {
      return;
    }
    expect(descriptor.operationId).toBe("v1ListAllProjects");
  });

  it("defaults to GET when a route supports multiple operations and includes GET", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/projects");

    expect(descriptor).not.toBeInstanceOf(PlatformRouteNotFoundError);
    expect(descriptor).not.toBeInstanceOf(PlatformMethodSelectionError);
    if (
      descriptor instanceof PlatformRouteNotFoundError ||
      descriptor instanceof PlatformMethodSelectionError
    ) {
      return;
    }
    expect(descriptor.method).toBe("GET");
    expect(descriptor.operationId).toBe("v1ListAllProjects");
  });

  it("uses the sole method when a route exposes only one operation", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/branches/{branch_id_or_ref}/push");

    expect(descriptor).not.toBeInstanceOf(PlatformRouteNotFoundError);
    expect(descriptor).not.toBeInstanceOf(PlatformMethodSelectionError);
    if (
      descriptor instanceof PlatformRouteNotFoundError ||
      descriptor instanceof PlatformMethodSelectionError
    ) {
      return;
    }
    expect(descriptor.method).toBe("POST");
    expect(descriptor.availableMethods).toEqual(["POST"]);
  });

  it("fails with a clear error for an unknown route", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/not-a-route");

    expect(descriptor).toBeInstanceOf(PlatformRouteNotFoundError);
  });

  it("fails with the supported methods when the requested method does not exist", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/projects", "PATCH");

    expect(descriptor).toBeInstanceOf(PlatformMethodSelectionError);
    expect(descriptor).toEqual(
      expect.objectContaining({
        detail: "Supported methods: GET, POST",
      }),
    );
  });

  it("fails when a non-GET multi-method route omits --method", () => {
    const descriptor = resolvePlatformOperationDescriptor("/v1/projects/{ref}/cli/login-role");

    expect(descriptor).toBeInstanceOf(PlatformMethodSelectionError);
    expect(descriptor).toEqual(
      expect.objectContaining({
        detail: "Supported methods: POST, DELETE",
      }),
    );
  });
});
