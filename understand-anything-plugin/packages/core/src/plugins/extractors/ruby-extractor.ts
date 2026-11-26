import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild } from "./base-extractor.js";
import { nestedRubyClassName } from "../symbol-ast.js";
import { rubyCall, rubyConstant, rubyMethodName, rubySelfSingletonClass, rubyStatements } from "../../ruby/ast.js";

/**
 * Set of method names that Ruby uses for imports.
 * These are handled separately from regular call graph entries.
 */
const IMPORT_METHODS = new Set(["require", "require_relative"]);

/**
 * Set of method names that define class properties (attr_* macros).
 * Their arguments are symbols that become accessor methods / properties.
 */
const ATTR_METHODS = new Set(["attr_accessor", "attr_reader", "attr_writer"]);

/**
 * Extract parameter names from a Ruby `method_parameters` node.
 *
 * Handles: identifier (plain), optional_parameter (with default),
 * splat_parameter (*args), hash_splat_parameter (**kwargs),
 * block_parameter (&block).
 */
function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;

    switch (child.type) {
      case "identifier":
        params.push(child.text);
        break;

      case "optional_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push(ident.text);
        break;
      }

      case "splat_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("*" + ident.text);
        break;
      }

      case "hash_splat_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("**" + ident.text);
        break;
      }

      case "block_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("&" + ident.text);
        break;
      }
    }
  }

  return params;
}

/**
 * Extract property names from attr_accessor/attr_reader/attr_writer calls.
 * These calls take symbol arguments like `:name, :email`.
 */
function extractAttrProperties(callNode: TreeSitterNode): string[] {
  const properties: string[] = [];
  const args = callNode.childForFieldName("arguments");
  if (!args) return properties;

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (child && child.type === "simple_symbol") {
      // Strip leading colon from `:name` -> `name`
      properties.push(child.text.slice(1));
    }
  }

  return properties;
}

/**
 * Extract the string value from a Ruby string node.
 * Ruby strings have a `string_content` child containing the unquoted value.
 */
function getStringContent(node: TreeSitterNode): string {
  const content = findChild(node, "string_content");
  if (content) return content.text;
  // Fallback: strip surrounding quotes
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Ruby extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles methods, classes, modules, require imports, and call graphs
 * for Ruby source code.
 *
 * Ruby-specific mapping decisions:
 * - Both `class` and `module` nodes are mapped to the `classes` array.
 * - `singleton_method` (def self.foo) is prefixed with "self." in the name.
 * - `attr_accessor`/`attr_reader`/`attr_writer` define properties on classes.
 * - `require` and `require_relative` calls are mapped to imports.
 * - All top-level definitions (classes, modules, methods) are treated as exports,
 *   since Ruby has no formal export syntax.
 */
export class RubyExtractor implements LanguageExtractor {
  readonly languageIds = ["ruby"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "method":
          this.extractMethod(node, functions);
          exports.push({
            name: this.getMethodName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "singleton_method":
          this.extractMethod(node, functions);
          exports.push({
            name: "self." + this.getSingletonMethodName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "class":
        case "module": {
          const name = node.childForFieldName("name")?.text;
          if (name) {
            this.extractClass(node, name, classes, functions);
            exports.push({ name, lineNumber: node.startPosition.row + 1 });
          }
          break;
        }

        case "call":
          this.extractTopLevelCall(node, imports);
          break;
      }
    }

    // Grape's helpers block contains ordinary named methods. Preserve them
    // even when the normal direct-body walk stops at the DSL call.
    const visitHelpers = (node: TreeSitterNode, owner: string | null = "") => {
      if (node.type === "class" || node.type === "module") {
        const raw = rubyConstant(node.childForFieldName("name"));
        owner = raw?.startsWith("::") ? raw.slice(2)
          : raw && !raw.includes("::") ? (owner ? owner + "::" + raw : raw)
          : owner === "" ? raw : null;
      }
      const call = rubyCall(node);
      if (call?.block && !call.receiver && call.method === "helpers" && !call.args.length) {
        for (const definition of rubyStatements(call.block.childForFieldName("body"))) {
          if ((definition.type === "method" || definition.type === "singleton_method")
            && !functions.some(fn => fn.lineRange[0] === definition.startPosition.row + 1 && fn.name === rubyMethodName(definition))) {
            this.extractMethod(definition, functions, owner);
          }
        }
      }
      if (node.type === "method" || node.type === "singleton_method") return;
      for (const child of node.namedChildren) visitHelpers(child, owner);
    };
    visitHelpers(rootNode);
    functions.sort((a, b) => a.lineRange[0] - b.lineRange[0]);
    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walkForCalls = (node: TreeSitterNode) => {
      let pushedName = false;

      // Track entering method definitions
      if (node.type === "method" || node.type === "singleton_method") {
        const name = rubyMethodName(node);
        if (name) {
          functionStack.push(name);
          pushedName = true;
        }
      }

      // Extract call expressions (but not imports or attr_* macros)
      if (node.type === "call") {
        const methodNode = node.childForFieldName("method");
        if (methodNode && functionStack.length > 0) {
          const methodName = methodNode.text;

          // Skip require/require_relative (imports) and attr_* macros
          if (!IMPORT_METHODS.has(methodName) && !ATTR_METHODS.has(methodName)) {
            const receiverNode = node.childForFieldName("receiver");
            const callee = receiverNode
              ? receiverNode.text + "." + methodName
              : methodName;

            entries.push({
              caller: functionStack[functionStack.length - 1],
              callee,
              lineNumber: node.startPosition.row + 1,
            });
          }
        }
      }

      // Ruby bare method calls without arguments (e.g., `setup`) are parsed as
      // `identifier` nodes inside `body_statement`, not as `call` nodes.
      // Treat them as calls when inside a function context.
      if (
        node.type === "identifier" &&
        node.parent?.type === "body_statement" &&
        functionStack.length > 0
      ) {
        entries.push({
          caller: functionStack[functionStack.length - 1],
          callee: node.text,
          lineNumber: node.startPosition.row + 1,
        });
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walkForCalls(child);
      }

      if (pushedName) {
        functionStack.pop();
      }
    };

    walkForCalls(rootNode);

    return entries;
  }

  // ---- Private helpers ----

  private getMethodName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : "";
  }

  private getSingletonMethodName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : "";
  }

  private extractMethod(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    owner?: string | null,
  ): void {
    const name = rubyMethodName(node);
    if (!name) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);

    functions.push({
      name,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      ...(owner !== undefined ? { owner } : {}),
    });
  }

  /** Walk direct class and module bodies. Methods and properties belong to
   * the immediate declaration, even when two nested classes share a basename. */
  private extractClass(
    node: TreeSitterNode,
    name: string,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
  ): void {
    const methods: string[] = [];
    const properties: string[] = [];
    classes.push({
      name,
      lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
      methods,
      properties,
    });

    const body = node.childForFieldName("body");
    let concern = false;
    const customHooks = new Set<string>();
    for (const member of body?.namedChildren ?? []) {
      if (member.type === "class" || member.type === "module") {
        const nestedName = nestedRubyClassName(member.childForFieldName("name"), name);
        if (nestedName) this.extractClass(member, nestedName, classes, functions);
      } else if (member.type === "method") {
        const nameNode = member.childForFieldName("name");
        if (nameNode) {
          methods.push(nameNode.text);
          this.extractMethod(member, functions);
        }
      } else if (member.type === "singleton_method") {
        const nameNode = member.childForFieldName("name");
        if (nameNode) {
          methods.push("self." + nameNode.text);
          this.extractMethod(member, functions);
          if (member.childForFieldName("object")?.type === "self") customHooks.add(nameNode.text);
        }
      } else if (member.type === "call") {
        const call = rubyCall(member);
        if (!call) continue;
        if (ATTR_METHODS.has(call.method)) {
          properties.push(...extractAttrProperties(member));
        }
        if (node.type !== "module" || call.receiver) continue;
        if (call.method === "extend" && !call.block && call.args.some(arg =>
          rubyConstant(arg)?.replace(/^::/, "") === "ActiveSupport::Concern")) {
          concern = true;
        }
        if (concern && !customHooks.has(call.method) && call.block && !call.args.length
          && (call.method === "included" || call.method === "class_methods")) {
          // included evaluates on each host. class_methods evaluates on the
          // concern's ClassMethods module. Neither defines methods on the concern itself.
          const owner = call.method === "class_methods" ? name + "::ClassMethods" : null;
          for (const definition of rubyStatements(call.block.childForFieldName("body"))) {
            if (rubySelfSingletonClass(definition)) {
              for (const method of rubyStatements(definition.childForFieldName("body"))) {
                if (method.type === "method") this.extractMethod(method, functions, owner);
              }
            } else if (definition.type === "method" || (definition.type === "singleton_method"
              && definition.childForFieldName("object")?.type === "self")) {
              this.extractMethod(definition, functions, owner);
            }
          }
        }
      }
    }
  }

  /**
   * Handle top-level call nodes: extract require/require_relative as imports.
   */
  private extractTopLevelCall(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const methodNode = node.childForFieldName("method");
    if (!methodNode) return;

    if (IMPORT_METHODS.has(methodNode.text)) {
      const args = node.childForFieldName("arguments");
      if (!args) return;

      // The first argument is typically the string source
      const firstArg = findChild(args, "string");
      if (firstArg) {
        const source = getStringContent(firstArg);
        imports.push({
          source,
          specifiers: [source],
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }
}
