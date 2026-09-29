import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories (test, fixtures). init found test/ on disk.
  //   The scripts under test/fixtures stay out with the rest of test/, and
  //   fixtures/** covers a fixtures directory by name, including a nested one.
  //   Remove one of these entries if that directory holds module content.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "fixtures/**",
    "**/fixtures/**",
  ],
  // src/ is the library. The tag is independent of the module list below:
  // each flat file under src/ is its own module, and every one of those files
  // carries kind:lib.
  classify: [{ glob: "src/**", tags: ["kind:lib"] }],
  // init declared one module per directory that holds TypeScript source and
  // one per TypeScript source file, so every file that check analyzes
  // belongs to exactly one module. Merge, rename, or remove entries freely:
  // init never rewrites this file. After an edit, run archstrict init to
  // regenerate archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "args.ts", glob: "src/args.ts", surface: "args.ts" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "connect.ts", glob: "src/connect.ts", surface: "connect.ts" },
    { name: "frames.ts", glob: "src/frames.ts", surface: "frames.ts" },
    { name: "params.ts", glob: "src/params.ts", surface: "params.ts" },
    { name: "paths.ts", glob: "src/paths.ts", surface: "paths.ts" },
    { name: "protocol.ts", glob: "src/protocol.ts", surface: "protocol.ts" },
    { name: "serve.ts", glob: "src/serve.ts", surface: "serve.ts" },
    { name: "spawn-chain.ts", glob: "src/spawn-chain.ts", surface: "spawn-chain.ts" },
    { name: "stop.ts", glob: "src/stop.ts", surface: "stop.ts" },
  ],
  because: "src is flat, so each file is its own module and those files carry kind:lib. test, fixtures, and hidden directories stay out of the check",
} satisfies Config;
