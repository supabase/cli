import { afterEach } from "vitest";
import { cleanupRegisteredStackProjects } from "./helpers/stack-e2e-cleanup.ts";

afterEach(() => cleanupRegisteredStackProjects());
