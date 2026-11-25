export const RUBY_DEPENDENCY_RESOLVER_VERSION = 5;

/** File-to-file evidence, kept separate from explicit require/import edges. */
export interface DependencyFact {
  target: string;
  type: "depends_on" | "inherits" | "routes";
  kind: "constant" | "superclass" | "include" | "extend" | "association" | "route" | "render";
  reference?: string;
  line?: number;
}

/** Unsupported/ambiguous semantics, never a substitute for read/parse failures. */
export interface DependencyDiagnostic {
  path: string | null;
  code: string;
  message: string;
  line?: number;
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
