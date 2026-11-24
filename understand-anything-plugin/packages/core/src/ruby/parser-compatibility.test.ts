import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { PluginRegistry } from "../plugins/registry.js";
import { rubyConfig } from "../languages/configs/ruby.js";
import { rubyCall, walkRuby } from "./ast.js";

let plugin: TreeSitterPlugin;
beforeAll(async () => { plugin = new TreeSitterPlugin([rubyConfig]); await plugin.init(); });

describe("Ruby grammar compatibility", () => {
  it("analyzes an extensionless Ruby binstub using its real path and interpreter", () => {
    const registry = new PluginRegistry();
    registry.register(plugin);
    const source = "#!/usr/bin/env ruby\ndef boot; end";
    expect(registry.analyzeFileFull("bin/shop", source)?.structure.functions[0]?.name).toBe("boot");
    expect(plugin.withSyntaxTree("bin/shop", source, root => root.type)).toBe("program");
    expect(plugin.analyzeFileStrict("bin/shop", source)).toMatchObject({ status: "succeeded", language: "ruby" });
  });

  it.each(["config.ru", "app.gemspec", "config/watch.god", "services/shop/Gemfile", "Rakefile", "Brewfile"])(
    "selects the Ruby grammar for %s", path => {
      expect(plugin.analyzeFileStrict(path, "def boot; end")).toMatchObject({
        status: "succeeded", language: "ruby", structure: { functions: [{ name: "boot" }] },
      });
    },
  );

  it("parses an adjacent append operator inside a method without inventing a heredoc", () => {
    const source = "def setter(value)\n model.send(attribute.to_s<<'=', value)\nend";
    const operators = plugin.withSyntaxTree("setter.rb", source, root => {
      const result: string[] = [];
      walkRuby(root, n => { if (n.type === "binary") result.push(n.childForFieldName("operator")!.text); });
      return result;
    });
    expect(operators).toEqual(["<<"]);
    expect(plugin.analyzeFileStrict("setter.rb", source)).toMatchObject({status:"succeeded", structure:{functions:[{name:"setter"}]}});
  });

  it("preserves the receiver and block of a chained command call with parenthesized arguments", () => {
    const source = "expect(emitter)\n .to receive(:event) do |&block|\n block.call\n end\n .with('name', tags: [])";
    plugin.withSyntaxTree("chain.rb", source, root => {
      const outer = rubyCall(root.namedChildren[0])!;
      expect(outer.method).toBe("with");
      const receiver = rubyCall(outer.receiver)!;
      expect(receiver.method).toBe("to");
      expect(receiver.block?.type).toBe("do_block");
      expect(rubyCall(receiver.args[0])?.method).toBe("receive");
    });
  });

  it.each([
    "text = <<'DOC'\nhello\nDOC\n",
    "puts <<~DOC\n  hello\nDOC\n",
    "puts(<<'DOC')\nhello\nDOC\n",
    "class << self\n def call; end\nend",
    "values << 'item'\nnumber = 1 << 2\n",
  ])("retains heredocs, singleton classes and shifts: %s", source => {
    expect(() => plugin.withSyntaxTree("valid.rb", source, () => true)).not.toThrow();
  });

  it("still rejects malformed Ruby for dependency and structural evidence", () => {
    const source = "class Broken\n def call(\nend";
    expect(() => plugin.withSyntaxTree("broken.rb", source, () => true)).toThrow();
    expect(plugin.analyzeFileStrict("broken.rb", source).status).toBe("failed");
  });
});
