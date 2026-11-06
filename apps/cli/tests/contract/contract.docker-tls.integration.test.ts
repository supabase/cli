import { describeContract } from "./cases.ts";
import { stackTarget } from "./target.ts";

describeContract("stack/container over api.tls, embedded pair", stackTarget("docker", "default"));
