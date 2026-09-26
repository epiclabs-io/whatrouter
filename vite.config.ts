import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const OUT = "dist/whatrouter.js";

// `bin` entries must be executable; rollup writes 0644.
const makeExecutable: Plugin = {
  name: "whatrouter:chmod-bin",
  closeBundle() {
    const file = resolve(import.meta.dirname, OUT);
    if (existsSync(file)) chmodSync(file, 0o755);
  },
};

export default defineConfig({
  plugins: [makeExecutable],
  build: {
    target: "node24",
    ssr: "src/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      // SSR builds externalize node_modules and `node:` builtins by default;
      // this only fixes the output file name + shebang.
      output: {
        format: "es",
        entryFileNames: "whatrouter.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
});
