import { Option } from "effect";

import { PlatformMetadataError } from "./platform.errors.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import type {
  PlatformHttpMethod,
  PlatformOperationDescriptor,
  PlatformRouteDescriptor,
} from "./platform-types.ts";

const HTTP_METHOD_ORDER: ReadonlyArray<PlatformHttpMethod> = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
];

function compareMethods(left: PlatformHttpMethod, right: PlatformHttpMethod): number {
  return HTTP_METHOD_ORDER.indexOf(left) - HTTP_METHOD_ORDER.indexOf(right);
}

function slugifyRouteGroup(group: string): string {
  return group
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getPlatformDefaultMethod(
  methods: ReadonlyArray<PlatformHttpMethod>,
): Option.Option<PlatformHttpMethod> {
  if (methods.length === 1) {
    return Option.some(methods[0]!);
  }

  const getMethod = methods.find((method) => method === "GET");
  return getMethod === undefined ? Option.none() : Option.some(getMethod);
}

function buildPlatformRouteDescriptor(
  descriptors: ReadonlyArray<PlatformOperationDescriptor>,
): PlatformRouteDescriptor {
  const first = descriptors[0];
  if (first === undefined) {
    throw new PlatformMetadataError({
      message: "Cannot build a route descriptor from an empty operation descriptor set.",
    });
  }

  const methods = [...new Set(descriptors.map((descriptor) => descriptor.method))].sort(
    compareMethods,
  );
  const groups = [...new Set(descriptors.map((descriptor) => descriptor.group))];

  if (groups.length !== 1) {
    throw new PlatformMetadataError({
      message: "OpenAPI route methods use inconsistent tags for the same path.",
      detail: `${first.path}: ${groups.join(", ")}`,
    });
  }

  const defaultMethod = getPlatformDefaultMethod(methods);
  const methodEntries = [...descriptors]
    .sort((left, right) => compareMethods(left.method, right.method))
    .map((descriptor) => ({
      method: descriptor.method,
      summary: descriptor.shortDescription,
      isDefault: Option.isSome(defaultMethod) && descriptor.method === defaultMethod.value,
    }));

  return {
    path: first.path,
    methods: methodEntries,
    group: groups[0]!,
    groupSlug: slugifyRouteGroup(groups[0]!),
  };
}

export const platformRouteDescriptors: ReadonlyArray<PlatformRouteDescriptor> = [
  ...platformOperationDescriptors
    .reduce((map, descriptor) => {
      const current = map.get(descriptor.path);
      map.set(descriptor.path, current ? [...current, descriptor] : [descriptor]);
      return map;
    }, new Map<string, ReadonlyArray<PlatformOperationDescriptor>>())
    .values(),
]
  .map((descriptors) => buildPlatformRouteDescriptor(descriptors))
  .sort(
    (left, right) => left.group.localeCompare(right.group) || left.path.localeCompare(right.path),
  );

export const platformRouteDescriptorsByPath = new Map(
  platformRouteDescriptors.map((route) => [route.path, route] as const),
);

export const platformRouteGroupChoices = [
  ...new Set(platformRouteDescriptors.map((route) => route.groupSlug)),
].sort();

export function listPlatformRouteDescriptors(filters: {
  readonly group?: string;
  readonly method?: PlatformHttpMethod;
  readonly search?: string;
}): ReadonlyArray<PlatformRouteDescriptor> {
  const normalizedGroup = filters.group?.trim();
  const normalizedSearch = filters.search?.trim().toLocaleLowerCase();

  return platformRouteDescriptors.filter((route) => {
    if (normalizedGroup !== undefined && route.groupSlug !== normalizedGroup) {
      return false;
    }

    if (
      filters.method !== undefined &&
      !route.methods.some((method) => method.method === filters.method)
    ) {
      return false;
    }

    if (normalizedSearch === undefined || normalizedSearch.length === 0) {
      return true;
    }

    const haystack = [
      route.path,
      route.group,
      ...route.methods.map((method) => `${method.method} ${method.summary}`),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

export function renderPlatformRouteDescriptors(
  routes: ReadonlyArray<PlatformRouteDescriptor>,
): string {
  const groups = routes.reduce((map, route) => {
    const current = map.get(route.group);
    map.set(route.group, current ? [...current, route] : [route]);
    return map;
  }, new Map<string, Array<PlatformRouteDescriptor>>());

  return [...groups.entries()]
    .map(([group, groupedRoutes]) =>
      [
        group,
        ...groupedRoutes.map((route) =>
          (() => {
            const methodWidth = Math.max(...route.methods.map((method) => method.method.length));
            return [
              `  ${route.path}`,
              ...route.methods.map(
                (method) => `    ${method.method.padEnd(methodWidth, " ")}  ${method.summary}`,
              ),
            ].join("\n");
          })(),
        ),
      ].join("\n"),
    )
    .join("\n\n");
}
