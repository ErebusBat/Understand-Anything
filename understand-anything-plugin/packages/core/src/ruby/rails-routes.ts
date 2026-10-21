import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyLiteral, rubyOptions, rubyStatements, type RubyAstNode } from "./ast.js";
import type { DependencyDiagnostic, DependencyFact } from "./types.js";

interface RouteResolver {
  isRails: boolean;
  camelize(value: string): string | null;
  pluralize(value: string): string | null;
  resolveConstant(reference: string, options?: { path?: string; line?: number }): string | null;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const CONTROLLER_PATH = /^[a-z][a-z\d_]*(?:\/[a-z][a-z\d_]*)*$/;

/** A deliberately small route DSL: immediate literal statements in the main
 * application's routes.draw block. No scope, callback or action simulation. */
export function extractRailsRouteDependencies({ path, source, plugin, resolver }: {
  path: string;
  source: string;
  plugin: TreeSitterPlugin;
  resolver: RouteResolver;
}): { dependencies: DependencyFact[]; diagnostics: DependencyDiagnostic[] } {
  const dependencies: DependencyFact[] = [];
  const diagnostics: DependencyDiagnostic[] = [];
  if (!resolver.isRails || !/(^|\/)config\/routes\.rb$/.test(path)) return { dependencies, diagnostics };
  const reject = (node: RubyAstNode | null, message: string) => {
    diagnostics.push({ path, code: "unsupported-route", message, ...(node ? { line: node.startPosition.row + 1 } : {}) });
  };
  // An engine's isolated namespace cannot be inferred from the route filename.
  if (path !== "config/routes.rb") {
    reject(null, "Engine route namespaces are outside the supported literal route subset.");
    return { dependencies, diagnostics };
  }
  plugin.withSyntaxTree(path, source, root => {
    for (const statement of rubyStatements(root)) {
      const draw = rubyCall(statement);
      const routes = rubyCall(draw?.receiver);
      const application = rubyCall(routes?.receiver);
      const recognized = draw?.method === "draw" && draw.args.length === 0 && draw.block
        && routes?.method === "routes" && routes.args.length === 0 && !routes.block
        && application?.method === "application" && application.args.length === 0 && !application.block
        && application.receiver?.type === "constant" && application.receiver.text === "Rails";
      if (!recognized || !draw?.block || draw.block.childForFieldName("parameters")) {
        reject(statement, "Only direct Rails.application.routes.draw blocks without parameters are supported.");
        continue;
      }
      for (const node of rubyStatements(draw.block.childForFieldName("body"))) {
        const call = rubyCall(node);
        if (!call || call.receiver || call.block) {
          reject(node, "Nested scopes, blocks, conditions and receiver-based routes are unsupported.");
          continue;
        }
        let controller: string | null = null;
        let reference: string | null = null;
        if (HTTP_METHODS.has(call.method)) {
          const routePath = rubyLiteral(call.args[0]);
          const options = rubyOptions(call.args.slice(1));
          const destination = options?.get("to");
          if (typeof routePath !== "string" || call.args[0]?.type !== "string"
            || options?.size !== 1 || typeof destination !== "string") {
            reject(node, "HTTP routes require a literal path and only a literal to: 'controller#action' option.");
            continue;
          }
          const parts = destination.split("#");
          if (parts.length !== 2 || !CONTROLLER_PATH.test(parts[0]) || !/^[a-z_]\w*[!?]?$/.test(parts[1])) {
            reject(node, "Route destination must name a literal controller path and action.");
            continue;
          }
          controller = parts[0];
          reference = destination;
        } else if (call.method === "resource" || call.method === "resources") {
          const name = rubyLiteral(call.args[0]);
          if (call.args.length !== 1 || typeof name !== "string" || !/^[a-z][a-z\d_]*$/.test(name)) {
            reject(node, "Resource declarations require one literal name and no options or block.");
            continue;
          }
          controller = call.method === "resource" ? resolver.pluralize(name) : name;
          reference = `${call.method} :${name}`;
        } else {
          reject(node, `Route DSL method ${call.method} is outside the supported subset.`);
          continue;
        }
        const constant = controller && resolver.camelize(`${controller}_controller`);
        if (!constant) {
          reject(node, "Controller inflection could not be determined statically.");
          continue;
        }
        const line = node.startPosition.row + 1;
        const target = resolver.resolveConstant(`::${constant}`, { path, line });
        if (!target || !/(^|\/)app\/controllers\/.+\.rb$/.test(target)) {
          diagnostics.push({ path, line, code: "unresolved-route", message: `No unambiguous local controller file for ${constant}.` });
          continue;
        }
        dependencies.push({ target, type: "routes", kind: "route", reference: reference!, line });
      }
    }
  });
  return { dependencies, diagnostics };
}
