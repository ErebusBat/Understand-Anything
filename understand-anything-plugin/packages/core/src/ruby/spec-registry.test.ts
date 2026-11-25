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

describe("FactoryBot registrations", () => {
  it("resolves explicit builders to literal factories, nested factories, and aliases", () => {
    const factory = "spec/factories/records.rb";
    const result = index({
      [factory]: `FactoryBot.define do
        factory :item, aliases: [:product] do
          factory :archived_item
        end
      end`,
      [spec]: `RSpec.describe Item do
        let(:first) { FactoryBot.build :item }
        let(:second) { ::FactoryBot.create_list(:archived_item, 2) }
        let(:third) { FactoryBot.attributes_for('product') }
      end`,
    });
    expect(result.map(f => [f.kind, f.line, f.target, f.resolution])).toEqual([
      ["factory", 2, factory, "inferred"], ["factory", 3, factory, "inferred"], ["factory", 4, factory, "inferred"],
    ]);
  });

  it("rejects ambiguous names, unrelated builders, dynamic names, and nonregistry declarations", () => {
    expect(index({
      "spec/factories/one.rb": "FactoryBot.define { factory :one, aliases: [:duplicate] }",
      "spec/factories/two.rb": "FactoryBot.define { factory :duplicate }\nfactory :orphan\nFake.define { factory :fake }",
      [spec]: `describe Item do
        it do
          FactoryBot.create(:duplicate)
          Fake.create(:one)
          create(:one)
          FactoryBot.build(active_name)
          FactoryBot.build(:orphan)
          FactoryBot.build(:fake)
        end
      end`,
    })).toEqual([]);
  });
});

it.each(["FactoryBot = LocalRegistry", "class ::FactoryBot; end"])(
  "suppresses registry inference when %s may shadow the receiver", declaration => {
    expect(index({
      "spec/support/replacement.rb": declaration,
      "spec/factories/item.rb": "FactoryBot.define { factory :item }",
      [spec]: "describe Item do; it { FactoryBot.create :item }; end",
    })).toEqual([]);
  },
);

it("keeps a qualified local reopening from hiding the top-level RSpec registry", () => {
  expect(index({
    "spec/support/ci.rb": "class CI::Reporter::RSpec; end",
    [helper]: "RSpec.shared_examples :active do; end",
    [spec]: "describe Item do; include_examples :active; end",
  })).toHaveLength(1);
});
