import type { LanguageConfig } from "../types.js";

export const coffeescriptConfig = {
  id: "coffeescript",
  displayName: "CoffeeScript",
  extensions: [".coffee"],
  concepts: ["bound functions", "classes", "implicit objects", "comprehensions"],
  filePatterns: { entryPoints: [], barrels: [], tests: ["*_spec.coffee"], config: [] },
} satisfies LanguageConfig;
