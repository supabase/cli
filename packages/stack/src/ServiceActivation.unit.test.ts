import { describe, expect, it } from "vitest";
import {
  activationTargetsForService,
  eagerServices,
  lifecycleTargetsForService,
  SERVICE_ACTIVATION_POLICY,
} from "./ServiceActivation.ts";
import { SERVICE_NAMES } from "./versions.ts";

describe("service activation", () => {
  it("defines an access policy for every stack service", () => {
    expect(Object.keys(SERVICE_ACTIVATION_POLICY).sort()).toEqual([...SERVICE_NAMES].sort());
  });

  it("starts direct endpoints eagerly", () => {
    expect(eagerServices(SERVICE_NAMES)).toEqual(["postgres", "mailpit", "studio", "pooler"]);
  });

  it("activates service companions transitively", () => {
    expect(activationTargetsForService(SERVICE_NAMES, "storage")).toEqual(["storage", "imgproxy"]);
    expect(activationTargetsForService(SERVICE_NAMES, "analytics")).toEqual([
      "analytics",
      "vector",
    ]);
    expect(activationTargetsForService(SERVICE_NAMES, "studio")).toEqual([
      "studio",
      "analytics",
      "vector",
    ]);
  });

  it("omits disabled companions", () => {
    const enabled = SERVICE_NAMES.filter(
      (service) => service !== "imgproxy" && service !== "vector",
    );
    expect(activationTargetsForService(enabled, "storage")).toEqual(["storage"]);
    expect(activationTargetsForService(enabled, "analytics")).toEqual(["analytics"]);
    expect(activationTargetsForService(enabled, "studio")).toEqual(["studio", "analytics"]);
  });

  it("does not assign shared public dependencies to their consumers", () => {
    expect(lifecycleTargetsForService(SERVICE_NAMES, "storage")).toEqual(["storage", "imgproxy"]);
    expect(lifecycleTargetsForService(SERVICE_NAMES, "analytics")).toEqual(["analytics", "vector"]);
    expect(lifecycleTargetsForService(SERVICE_NAMES, "studio")).toEqual(["studio"]);
  });
});
