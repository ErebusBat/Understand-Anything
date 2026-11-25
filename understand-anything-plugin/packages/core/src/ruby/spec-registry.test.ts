import { beforeAll, describe, expect, it } from "vitest";
import { builtinLanguageConfigs } from "../languages/index.js";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { RubySpecRegistry } from "./spec-registry.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
beforeAll(() => plugin.init());
const spec = "spec/models/item_spec.rb";
const helper = "spec/support/shared.rb";

function index(files: Record<string, string>) {
  const registry = new RubySpecRegistry();
  for (const [path, source] of Object.entries(files)) {
    plugin.withSyntaxTree(path, source, root => registry.index(path, root));
  }
  return registry.dependencies(spec);
}

describe("RSpec shared registrations", () => {
  it("matches literal global support groups from nested examples and keeps registry name types distinct", () => {
    const files = {
      [spec]: `RSpec.describe Item do
        context 'archived' do
          it_behaves_like 'a record', :archived
          include_context :active
          include_examples :unknown
          it_behaves_like :active if conditional?
          include_context 'active'
        end
      end`,
      [helper]: "shared_examples_for 'a record' do; end\nRSpec.shared_context :active do; end",
    };
    expect(index(files)).toEqual([
      {target: helper, type: "depends_on", kind: "rspec_shared_group", reference: "it_behaves_like 'a record'", line: 3, resolution: "inferred"},
      {target: helper, type: "depends_on", kind: "rspec_shared_group", reference: "include_context :active", line: 4, resolution: "inferred"},
    ]);
  });

  it("rejects scoped, conditional, duplicate, interpolated and unrelated DSL calls", () => {
    expect(index({
      [spec]: `describe Item do
        it_behaves_like "nested"
        it_behaves_like "conditional"
        it_behaves_like "duplicated"
        it_behaves_like "shadowed"
        it_behaves_like "good#{env}"
        it { include_examples "ok" }
        Fake.include_examples "ok"
        it_behaves_like "local only"
        shared_examples "shadowed" do; end
      end
      Fake.describe { include_examples "ok" }
      include_examples "ok"`,
      [helper]: `shared_examples "ok" do; end
        describe Item do; shared_examples "nested" do; end; end
        if feature?; shared_examples "conditional" do; end; end
        shared_context "duplicated" do; end
        shared_examples "shadowed" do; end`,
      "spec/support/extra.rb": "RSpec.shared_examples 'duplicated' do; end",
      "spec/other_spec.rb": "shared_examples 'local only' do; end",
    })).toEqual([]);
  });
});
