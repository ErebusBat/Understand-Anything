import { LanguageConfigSchema } from "./types.js";
import type { LanguageConfig } from "./types.js";
import { builtinLanguageConfigs } from "./configs/index.js";

function shebangLanguage(content: string): string | null {
  if (!content.startsWith("#!")) return null;
  const [command, ...args] = content.slice(2, 256).split(/[\r\n]/, 1)[0].trim().split(/[ \t]+/);
  const interpreter = command.split("/").pop() === "env"
    ? args[args[0] === "-S" ? 1 : 0] : command;
  const name = interpreter?.split("/").pop() ?? "";
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(name)) return "ruby";
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return "python";
  if (name === "node" || name === "nodejs") return "javascript";
  if (["bash", "dash", "sh", "zsh", "ksh"].includes(name)) return "shell";
  return null;
}

/**
 * Registry for language configurations. Maps language ids and file extensions
 * to their corresponding LanguageConfig objects.
 */
export class LanguageRegistry {
  private byId = new Map<string, LanguageConfig>();
  private byExtension = new Map<string, LanguageConfig>();
  private byFilename = new Map<string, LanguageConfig>();

  register(config: LanguageConfig): void {
    const parsed = LanguageConfigSchema.parse(config);
    this.byId.set(parsed.id, parsed);
    for (const ext of parsed.extensions) {
      // Normalize: strip leading dot if present for lookup consistency
      const key = ext.startsWith(".") ? ext : `.${ext}`;
      this.byExtension.set(key, parsed);
    }
    if (parsed.filenames) {
      for (const filename of parsed.filenames) {
        this.byFilename.set(filename.toLowerCase(), parsed);
      }
    }
  }

  getById(id: string): LanguageConfig | null {
    return this.byId.get(id) ?? null;
  }

  getByExtension(ext: string): LanguageConfig | null {
    const key = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();
    return this.byExtension.get(key) ?? null;
  }

  getForFile(filePath: string, content?: string): LanguageConfig | null {
    // Try filename-based lookup first (more specific: docker-compose.yml, Makefile, etc.)
    const basename = filePath.split(/[\\/]/).pop() ?? filePath;
    const filenameMatch = this.byFilename.get(basename.toLowerCase());
    if (filenameMatch) return filenameMatch;
    // Fall back to extension-based lookup
    const lastDot = basename.lastIndexOf(".");
    if (lastDot >= 0) {
      const extensionMatch = this.getByExtension(basename.slice(lastDot));
      if (extensionMatch || lastDot > 0) return extensionMatch;
    }
    const language = content && shebangLanguage(content);
    return language ? this.getById(language) : null;
  }

  getAllLanguages(): LanguageConfig[] {
    return [...this.byId.values()];
  }

  /**
   * Create a registry pre-populated with all built-in language configs.
   */
  static createDefault(): LanguageRegistry {
    const registry = new LanguageRegistry();
    for (const config of builtinLanguageConfigs) {
      registry.register(config);
    }
    return registry;
  }
}
