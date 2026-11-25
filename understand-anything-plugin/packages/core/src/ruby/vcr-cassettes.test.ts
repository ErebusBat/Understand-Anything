import { beforeAll, expect, it } from "vitest";
import { builtinLanguageConfigs } from "../languages/index.js";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { RubyTestSuites } from "./spec-registry.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
beforeAll(() => plugin.init());
const spec = "spec/services/lookup_spec.rb", support = "spec/support/vcr.rb", target = "spec/vcr/accounts/lookup.yml";
const settings = 'VCR.configure do |c|\n c.hook_into :webmock\n c.cassette_library_dir = Rails.root.join("spec", "vcr")\nend';
const suite = {
  "spec/spec_helper.rb": 'Dir[Rails.root.join("spec/support/**/*.rb")].each { |f| require f }',
  [spec]: "require 'spec_helper'\nVCR.use_cassette('accounts/lookup') { lookup }",
  [support]: settings, [target]: "# contents are not parsed",
};

function resolve(files: Record<string, string>, source = spec, rails = true) {
  const suites = new RubyTestSuites(Object.keys(files).map(path => ({path})));
  for (const [path, contents] of Object.entries(files)) {
    if (path.endsWith(".rb")) plugin.withSyntaxTree(path, contents, root => suites.index(path, root));
  }
  return suites.dependencies(source, rails);
}

it("links a literal VCR call through its loaded configuration to inventoried YAML", () => {
  expect(resolve(suite)).toEqual([{kind: "vcr_cassette", type: "depends_on", reference: "VCR.use_cassette 'accounts/lookup'",
    line: 2, target, resolution: "inferred"}]);
  expect(resolve(suite, spec, false)).toEqual([]);
  expect(resolve({...suite, "spec/spec_helper.rb": ""})).toEqual([]);
  expect(resolve(Object.fromEntries(Object.entries(suite).filter(([path]) => path !== target)))).toEqual([]);
});

it("uses only the owning package suite and supports an explicitly loaded helper", () => {
  const prefix = "engines/demo/";
  const files = {...suite, [prefix + "demo.gemspec"]: "", [prefix + spec]: "require 'support/vcr'\nVCR.use_cassette(:lookup) { lookup }",
    [prefix + support]: settings.replace('Rails.root.join("spec", "vcr")', "'spec/cassettes'"), [prefix + "spec/cassettes/lookup.yml"]: ""};
  expect(resolve(files, prefix + spec)[0]?.target).toBe(prefix + "spec/cassettes/lookup.yml");
  expect(resolve({...files, [prefix + support]: ""}, prefix + spec)).toEqual([]);
  expect(resolve(files)[0]?.target).toBe(target);
});

it("rejects unsupported options, configuration, shadowing and dynamic names", () => {
  for (const use of ["VCR.use_cassette(name) { lookup }", "VCR.use_cassette('accounts/lookup', serialize_with: :json) { lookup }",
    "Other.use_cassette('accounts/lookup') { lookup }", "VCR.use_cassette('../secret') { lookup }"]) {
    expect(resolve({...suite, [spec]: "require 'spec_helper'\n" + use})).toEqual([]);
  }
  for (const source of [settings.replace('Rails.root.join("spec", "vcr")', "some_path"), settings.replace("c.hook_into :webmock",
    "c.default_cassette_options = {serialize_with: :json}"), settings.replace("c.hook_into :webmock", "customize(c)"),
    "if enabled?; " + settings + "; end", settings + "\nVCR.configure { |c| c.cassette_library_dir = 'elsewhere' }",
    settings + "\nVCR = LocalRecorder"]) expect(resolve({...suite, [support]: source})).toEqual([]);
});
