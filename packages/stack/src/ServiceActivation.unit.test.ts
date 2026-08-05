import { describe, expect, it } from "vitest";
import {
  activationTargetsForService,
  eagerServices,
  lifecycleTargetsForService,
} from "./ServiceActivation.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";

describe("service activation", () => {
  it("defines an access policy for every stack service", () => {
    expect(Object.keys(SERVICE_CATALOG).sort()).toEqual([...SERVICE_NAMES].sort());
  });

  it("starts direct endpoints eagerly", () => {
    expect(eagerServices(SERVICE_NAMES)).toEqual([
      "postgres",
      "realtime",
      "mailpit",
      "studio",
      "pooler",
    ]);
  });

  it("activates service companions transitively", () => {
    expect(activationTargetsForService(SERVICE_NAMES, "storage")).toEqual(["imgproxy", "storage"]);
    expect(activationTargetsForService(SERVICE_NAMES, "analytics")).toEqual([
      "vector",
      "analytics",
    ]);
    expect(activationTargetsForService(SERVICE_NAMES, "studio")).toEqual([
      "vector",
      "analytics",
      "studio",
    ]);
  });

  it("omits disabled companions", () => {
    const enabled = SERVICE_NAMES.filter(
      (service) => service !== "imgproxy" && service !== "vector",
    );
    expect(activationTargetsForService(enabled, "storage")).toEqual(["storage"]);
    expect(activationTargetsForService(enabled, "analytics")).toEqual(["analytics"]);
    expect(activationTargetsForService(enabled, "studio")).toEqual(["analytics", "studio"]);
  });

  it("does not assign shared public dependencies to their consumers", () => {
    expect(lifecycleTargetsForService(SERVICE_NAMES, "storage")).toEqual(["storage", "imgproxy"]);
    expect(lifecycleTargetsForService(SERVICE_NAMES, "analytics")).toEqual(["analytics", "vector"]);
    expect(lifecycleTargetsForService(SERVICE_NAMES, "studio")).toEqual(["studio"]);
  });
});
