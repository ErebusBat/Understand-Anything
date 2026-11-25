export const RUBY_DEPENDENCY_RESOLVER_VERSION = 6;

/** File-to-file evidence, kept separate from explicit require/import edges. */
export interface DependencyFact {
  target: string;
  type: "depends_on" | "inherits" | "routes";
  kind: "constant" | "superclass" | "include" | "extend" | "association" | "route" | "render" | "layout"
    | "rspec_shared_group" | "factory";
  reference?: string;
  line?: number;
  /** A qualified mixin matched a local module across uninspected ancestry. */
  resolution?: "inferred";
}

export type RubyMixinResolution = "pragmatic" | "strict";
export const DEFAULT_RUBY_MIXIN_RESOLUTION: RubyMixinResolution = "pragmatic";

/** Unsupported/ambiguous semantics, never a substitute for read/parse failures. */
export interface DependencyDiagnostic {
  path: string | null;
  code: string;
  message: string;
  line?: number;
  /** Unique file for the top-level spelling of an unresolved qualified mixin. */
  candidateTarget?: string;
}

export interface RubyDependencyFailure {
  path: string | null;
  stage: string;
  message: string;
}

export interface RubyInventoryFile {
  path: string;
  language?: string;
  fileCategory?: string;
}

export interface RubyAutoloadRoot {
  path: string;
  provenance: string;
  kind: "conventional" | "configured";
}
