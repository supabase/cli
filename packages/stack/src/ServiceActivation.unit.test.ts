import { describe, expect, it } from "vitest";
import {
  activationTargetsForService,
  eagerServices,
  SERVICE_ACTIVATION_POLICY,
} from "./ServiceActivation.ts";
import { SERVICE_NAMES } from "./versions.ts";

describe("service activation", () => {
  it("defines an access policy for every stack service", () => {
    expect(Object.keys(SERVICE_ACTIVATION_POLICY).sort()).toEqual([...SERVICE_NAMES].sort());
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

  it("activates storage and analytics companions together", () => {
    expect(activationTargetsForService(SERVICE_NAMES, "storage")).toEqual(["storage", "imgproxy"]);
    expect(activationTargetsForService(SERVICE_NAMES, "analytics")).toEqual([
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
  });
});
