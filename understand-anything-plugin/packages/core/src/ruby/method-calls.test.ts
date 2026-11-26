import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { collectRubyMethodCalls } from "./method-calls.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
beforeAll(async () => plugin.init());
const extract = (source: string) => plugin.withSyntaxTree("example.rb", source, collectRubyMethodCalls);

describe("Ruby method-site evidence", () => {
  it("distinguishes selectors by lexical owner, dispatch and declaration location", () => {
    const source = "module A\n class B\n def run; Target.call(1); end\n def self.run; Target.call(2); end\n class << self\n def other; ::Target.call(3); end\n end\n end\nend";
    const {symbols, sites} = extract(source);
    expect(symbols.map(s => [s.owner, s.name, s.dispatch, s.line])).toEqual([
      ["A::B", "run", "instance", 3], ["A::B", "run", "singleton", 4], ["A::B", "other", "singleton", 6],
    ]);
    expect(sites.map(s => [s.receiver, s.selector, s.caller?.line])).toEqual([
      ["Target", "call", 3], ["Target", "call", 4], ["::Target", "call", 6],
    ]);
    // Existing consumers keep exactly the legacy callGraph shape.
    expect(plugin.extractCallGraph("example.rb", source)[0]).toEqual({caller: "run", callee: "Target.call", lineNumber: 3});
  });

  it("retains named helpers and class-body sites without attributing runtime DSL methods to a lexical owner", () => {
    const {sites} = extract("class Api\n helpers { def helper; Target.call; end }\n before { Permission.dynamic }\n included { def installed; Target.call; end }\n class << other\n def runtime; Target.call; end\n end\nend");
    expect(sites.find(s => s.caller?.name === "helper")?.caller?.owner).toBe("Api");
    expect(sites.find(s => s.receiver === "Permission")).toMatchObject({selector: "dynamic", line: 3});
    expect(sites.find(s => s.receiver === "Permission")?.caller).toBeUndefined();
    expect(sites.find(s => s.caller?.name === "installed")?.caller?.owner).toBeNull();
    expect(sites.find(s => s.caller?.name === "runtime")?.caller?.owner).toBeNull();
  });
});
