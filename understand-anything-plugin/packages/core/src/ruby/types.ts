export const RUBY_DEPENDENCY_RESOLVER_VERSION = 8;

/** File-to-file evidence, kept separate from explicit require/import edges. */
export interface DependencyFact {
  target: string;
  type: "depends_on" | "inherits" | "routes";
  kind: "constant" | "superclass" | "include" | "extend" | "association" | "route" | "render" | "layout" | "grape_helper"
    | "rspec_shared_group" | "factory" | "factory_association" | "factory_sequence" | "serializer" | "validator" | "file_read" | "resque_schedule" | "vcr_cassette";
  reference?: string;
  line?: number;
  /** The source identifies a local candidate through a convention or uninspected ancestry. */
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
  /** Unique file for the top-level spelling of an unresolved mixin. */
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
