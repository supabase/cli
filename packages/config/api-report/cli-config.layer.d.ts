import { FileSystem, Layer, Path } from "effect";
import { CliConfigStore } from "./cli-config.service.ts";
export declare const cliConfigStoreLayer: Layer.Layer<CliConfigStore, never, FileSystem.FileSystem | Path.Path>;
