import type { UserConfig } from "vite";

/** Vite optimizeDeps preset for apps that import @thatopen/fragments. */
export declare const ffViewerOptimizeDeps: UserConfig["optimizeDeps"];

/** Alias entries pointing at the source root of each viewer package. */
export declare function ffToolingAlias(workspaceRoot: string): Record<string, string>;
