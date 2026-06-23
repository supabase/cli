import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { storage } from "./storage.ts";

describe("storage schema", () => {
  const decodeStorage = Schema.decodeUnknownSync(storage);

  describe("file_size_limit accepts numeric and string forms (Go sizeInBytes parity)", () => {
    // Mirrors apps/cli-go/pkg/config/config_test.go:TestFileSizeLimitConfigParsing.
    test("accepts a bare byte count and normalizes it to a string", () => {
      expect(decodeStorage({ file_size_limit: 5000000 }).file_size_limit).toBe("5000000");
    });

    test("accepts human-readable string forms unchanged", () => {
      expect(decodeStorage({ file_size_limit: "5MB" }).file_size_limit).toBe("5MB");
      expect(decodeStorage({ file_size_limit: "5MiB" }).file_size_limit).toBe("5MiB");
      expect(decodeStorage({ file_size_limit: "5000000" }).file_size_limit).toBe("5000000");
    });

    test("normalizes a numeric per-bucket file_size_limit to a string", () => {
      const decoded = decodeStorage({
        buckets: { images: { public: true, file_size_limit: 5000000 } },
      });
      expect(decoded.buckets?.["images"]?.file_size_limit).toBe("5000000");
    });

    test("rejects a non-number/non-string file_size_limit", () => {
      expect(() => decodeStorage({ file_size_limit: [] })).toThrow();
    });
  });

  describe("default-enabled values match Go's merged template", () => {
    test("vector.enabled defaults to true when omitted", () => {
      // Go merges templates/config.toml (enabled = true) as the base layer, so an
      // omitted key resolves to true (config_test.go:40). Common partial configs
      // declare [storage.vector.buckets.*] without [storage.vector].enabled.
      expect(decodeStorage({}).vector.enabled).toBe(true);
      expect(decodeStorage({ vector: { buckets: { "docs-openai": {} } } }).vector.enabled).toBe(
        true,
      );
    });

    test("analytics.enabled defaults to false (template sets enabled = false)", () => {
      expect(decodeStorage({}).analytics.enabled).toBe(false);
    });
  });
});
