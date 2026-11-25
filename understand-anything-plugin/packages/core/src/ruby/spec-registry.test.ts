import { beforeAll, describe, expect, it } from "vitest";
import { builtinLanguageConfigs } from "../languages/index.js";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { RubySpecRegistry } from "./spec-registry.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
beforeAll(() => plugin.init());
const spec = "spec/models/item_spec.rb";
const helper = "spec/support/shared.rb";

function index(files: Record<string, string>, hasRailsRoot = false, consumer = spec) {
  const registry = new RubySpecRegistry();
  for (const [path, source] of Object.entries(files)) {
    if (path === ".rspec") registry.readDefaultOptions(source);
    else plugin.withSyntaxTree(path, source, root => registry.index(path, root));
  }
  return registry.dependencies(consumer, hasRailsRoot);
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

describe("legacy FactoryGirl suites", () => {
  const factory = "test/factories/cards.rb";
  const modern = "spec/factories.rb";
  const suite = {
    [factory]: "FactoryGirl.define { factory(:card) { factory :active_card, aliases: [:payment_card] } }",
    [modern]: "FactoryBot.define { factory :card }",
    [spec]: "FactoryBot.create :card\nFactoryGirl.create :card",
    "test/unit/card_test.rb": "::FactoryGirl.build(:active_card)",
    "features/step_definitions/cards.rb": "Given('a card') { FactoryGirl.create :payment_card }",
  };

  it("resolves each named registry independently in specs, tests and Cucumber steps", () => {
    expect(index(suite).map(f => [f.target, f.reference])).toEqual([
      [modern, "FactoryBot.create :card"], [factory, "FactoryGirl.create :card"],
    ]);
    for (const consumer of ["test/unit/card_test.rb", "features/step_definitions/cards.rb"]) {
      expect(index(suite, false, consumer)).toEqual([expect.objectContaining({target: factory, kind: "factory", resolution: "inferred"})]);
    }
  });

  it("resolves literal factory association providers in factory and trait bodies", () => {
    const source = "test/factories/payments.rb";
    const association = `FactoryGirl.define do
      factory :payment do
        association :card
        trait(:active) { association :instrument, factory: :payment_card, strategy: :build }
        after(:create) { association :card }
        association :missing
        association :card, factory: dynamic_name
        association :card, **overrides
        fake.association :card
      end
    end`;
    const files = {...suite, [source]: association};
    expect(index(files, false, source)).toEqual([
      {target: factory, kind: "factory_association", type: "depends_on", resolution: "inferred", reference: "association :card", line: 3},
      {target: factory, kind: "factory_association", type: "depends_on", resolution: "inferred", reference: "association :instrument => payment_card", line: 4},
    ]);
    expect(index({...files, [source]: "FactoryGirl = Other\n" + association}, false, source)).toEqual([]);
  });

  it("keeps rebindings and unknown names scoped to their named registry", () => {
    for (const replacement of ["FactoryGirl = LocalRegistry", "FactoryGirl.define { factory(dynamic_name) }"]) {
      expect(index({...suite, "test/factories/extra.rb": replacement}).map(f => f.target)).toEqual([modern]);
    }
    expect(index({...suite, "test/factories/extra.rb": "FactoryGirl.define { factory :card }"}).map(f => f.target)).toEqual([modern]);
  });

  it("excludes only names that can collide with a literal prefix and suffix around interpolation", () => {
    const source = `FactoryGirl.define do
      factory :supplier
      factory :online_card
      factory :online_supplier
      names.each { |name| factory :"online_#{name}_card" }
      factory :online_gold_card
    end`;
    const uses = "FactoryGirl.create :supplier\nFactoryGirl.create :online_card\nFactoryGirl.create :online_supplier\nFactoryGirl.create :online_gold_card";
    expect(index({[factory]: source, [spec]: uses}).map(f => f.line)).toEqual([1, 2, 3]);
    expect(index({[factory]: source.replace('online_#{name}_card', '#{name}'), [spec]: uses})).toEqual([]);
    expect(index({[factory]: source.replace('_card" }', '_card", aliases: names }'), [spec]: uses})).toEqual([]);
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

describe("FactoryBot instance helpers", () => {
  const wiring = "spec/support/factories_dsl.rb";
  const syntax = "RSpec.configure { |config| config.include FactoryBot::Syntax::Methods }";
  const factory = "spec/factories/item.rb";
  const suite = {
    [wiring]: syntax,
    [factory]: "FactoryBot.define { factory :item }",
    "spec/spec_helper.rb": "require_relative 'support/factories_dsl'",
    [spec]: `require 'spec_helper'
      describe Item do
        let(:item) { build(:item) }
        before { create :item }
        create(:item)
        it { other.instance_exec { create(:item) } }
      end`,
  };

  it("requires a helper load path, explicit DSL registration, and example-instance scope", () => {
    expect(index(suite).map(f => [f.line, f.target, f.reference])).toEqual([[3, factory, "build :item"], [4, factory, "create :item"]]);
    expect(index({...suite, "spec/spec_helper.rb": ""})).toEqual([]);
    expect(index({...suite, [wiring]: syntax.replace("Syntax::Methods", "Syntax::Methods, type: :model")})).toEqual([]);
    expect(index({...suite, [spec]: suite[spec].replace("require 'spec_helper'", "")})).toEqual([]);
  });

  it("recognizes built-in shared example customization blocks as child example groups", () => {
    expect(index({...suite, [spec]: `require 'spec_helper'
      describe Item do
        it_behaves_like "a model" do
          let(:record) { create :item }
        end
        other.it_should_behave_like "a model" do
          let(:record) { create :item }
        end
      end`,
    }).map(f => [f.target, f.line])).toEqual([[factory, 4]]);
  });

  it("loads literal default helpers from plain RSpec options", () => {
    const files = {...suite, [spec]: suite[spec].replace("require 'spec_helper'", "")};
    expect(index({...files, ".rspec": "--tag ~slow\n--require spec_helper\n--format documentation"})).toHaveLength(2);
    for (const options of ["--require other", "<%= options %>\n--require spec_helper", "--require spec_helper\n-I custom_lib"]) {
      expect(index({...files, ".rspec": options})).toEqual([]);
    }
  });

  it("requires an established Rails root for support loaded through a Rails-root glob", () => {
    const glob = 'Dir[Rails.root.join("spec/support/**/*.rb")].each { |file| require file }';
    const files = {...suite, "spec/spec_helper.rb": glob};
    expect(index(files, true)).toHaveLength(2);
    expect(index(files)).toEqual([]);
    expect(index({...files, "spec/spec_helper.rb": "def unused; " + glob + "; end"}, true)).toEqual([]);
    expect(index({...files, "spec/spec_helper.rb": "if special?; " + glob + "; end"}, true)).toEqual([]);
  });

  it("suppresses locally defined builders and helpers that can shadow included methods", () => {
    expect(index({...suite, "spec/support/model_helpers.rb": "module Helpers; def build(name); end; end",
      [spec]: suite[spec].replace("before {", "let(:create) { service }\n before {"),
    })).toEqual([]);
  });
});
