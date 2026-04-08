import type { PlatformHttpMethod, PlatformOperationDescriptor } from "./platform-types.ts";
import { PlatformMethodSelectionError, PlatformRouteNotFoundError } from "./platform.errors.ts";
import { normalizePlatformRoute } from "./platform-cli.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";

function compareMethods(left: PlatformHttpMethod, right: PlatformHttpMethod): number {
  const order: ReadonlyArray<PlatformHttpMethod> = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
  ];
  return order.indexOf(left) - order.indexOf(right);
}

function supportedMethodsFor(
  descriptors: ReadonlyArray<PlatformOperationDescriptor>,
): ReadonlyArray<PlatformHttpMethod> {
  return [...new Set(descriptors.map((descriptor) => descriptor.method))].sort(compareMethods);
}

export const platformRouteDescriptorMap = new Map(
  platformOperationDescriptors.map(
    (descriptor) => [`${descriptor.method} ${descriptor.path}`, descriptor] as const,
  ),
);

export const platformRouteDescriptorsByPath = new Map<
  string,
  ReadonlyArray<PlatformOperationDescriptor>
>(
  [
    ...platformOperationDescriptors
      .reduce((map, descriptor) => {
        const current = map.get(descriptor.path);
        map.set(descriptor.path, current ? [...current, descriptor] : [descriptor]);
        return map;
      }, new Map<string, ReadonlyArray<PlatformOperationDescriptor>>())
      .entries(),
  ].map(([path, descriptors]) => [
    path,
    [...descriptors].sort((left, right) => compareMethods(left.method, right.method)),
  ]),
);

export function resolvePlatformOperationDescriptor(
  route: string,
  method?: PlatformHttpMethod,
): PlatformOperationDescriptor | PlatformRouteNotFoundError | PlatformMethodSelectionError {
  const normalizedRoute = normalizePlatformRoute(route);
  const descriptors = platformRouteDescriptorsByPath.get(normalizedRoute);

  if (descriptors === undefined) {
    return new PlatformRouteNotFoundError({
      message: `Unknown API route: ${normalizedRoute}.`,
      suggestion: "Run `supabase api --help` to inspect the low-level Management API command.",
    });
  }

  const supportedMethods = supportedMethodsFor(descriptors);

  if (method !== undefined) {
    const descriptor = descriptors.find((candidate) => candidate.method === method);
    if (descriptor === undefined) {
      return new PlatformMethodSelectionError({
        message: `No ${method} operation exists for ${normalizedRoute}.`,
        detail: `Supported methods: ${supportedMethods.join(", ")}`,
        suggestion: "Pass one of the supported methods with `--method`.",
      });
    }
    return descriptor;
  }

  if (descriptors.length === 1) {
    return descriptors[0]!;
  }

  const getDescriptor = descriptors.find((candidate) => candidate.method === "GET");
  if (getDescriptor !== undefined) {
    return getDescriptor;
  }

  return new PlatformMethodSelectionError({
    message: `Multiple operations match ${normalizedRoute}.`,
    detail: `Supported methods: ${supportedMethods.join(", ")}`,
    suggestion: "Pass `--method <METHOD>` to choose the operation you want to run.",
  });
}
