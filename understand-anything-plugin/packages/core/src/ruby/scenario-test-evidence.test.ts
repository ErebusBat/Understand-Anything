import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { createRubyWorkspaceDependencyResolver } from "./workspace-resolver.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
const roots: string[] = [];
beforeAll(() => plugin.init());
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
const app = {"config/application.rb": "module Demo; class Application < Rails::Application; end; end"};
function fixture(sources: Record<string, string>) {
  const projectRoot = mkdtempSync(join(tmpdir(), "ua-scenario-evidence-"));
  roots.push(projectRoot);
  for (const [path, content] of Object.entries(sources)) {
    mkdirSync(dirname(join(projectRoot, path)), {recursive: true});
    writeFileSync(join(projectRoot, path), content);
  }
  const files = Object.keys(sources).map(path => ({path, language: path.endsWith(".rb") ? "ruby" : "unknown"}));
  return createRubyWorkspaceDependencyResolver({projectRoot, files, plugin});
}
const feature = "features/account.feature", steps = "features/step_definitions/account.rb";
const scenario = (text: string) => "Feature: Accounts\n  Scenario: Login\n" + text;

describe("scenario steps in their owning suite", () => {
  it("links literals and anchored simple Ruby patterns with feature source locations", () => {
    const resolver = fixture({
      [feature]: scenario('    Given an account\n    When I log in as "Ada"\n    Then I have 12 credits\n    And missing'),
      [steps]: 'Given("an account") {}\nWhen(/^I log in as "(.*)"$/) {}\nThen(/^I have (\\d+) credits$/) {}',
    });
    expect(resolver.getDependencies(feature)).toEqual([
      expect.objectContaining({target: steps, kind: "cucumber_step", line: 3, reference: "an account"}),
      expect.objectContaining({target: steps, kind: "cucumber_step", line: 4}),
      expect.objectContaining({target: steps, kind: "cucumber_step", line: 5}),
    ]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path: feature, line: 6, code: "unmatched_cucumber_step"}));
  });

  it("honors optional prefixes and required versus empty captures", () => {
    const resolver = fixture({
      [feature]: scenario(" Given I have 123: paid\n And have 5: paid\n And have : paid\n And I have x: paid"),
      [steps]: 'Given(/^(?:|I )have (\\d+)(\\d*): (.*)paid$/) {}',
    });
    expect(resolver.getDependencies(feature).map(fact => fact.line)).toEqual([3, 4]);
  });

  it("rejects duplicate definitions even within one file and accounts for unsupported competitors", () => {
    const resolver = fixture({
      [feature]: scenario("    Given an account\n    And a customer\n    Then I have <n> credits"),
      [steps]: 'Given("an account") {}\nThen("an account") {}\nGiven(/^a customer$/) {}\nGiven(/^a (customer|merchant)$/) {}',
    });
    expect(resolver.getDependencies(feature)).toEqual([]);
    expect(resolver.diagnostics.filter(d => d.code === "ambiguous_cucumber_step")).toHaveLength(2);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({code: "unsupported_cucumber_outline"}));
  });

  it("isolates engine suites, excludes docstrings and never treats feature prose as a step", () => {
    const resolver = fixture({
      [feature]: 'Feature: Demo\n Given prose\n Scenario: Demo\n Given an account\n """\n Then ignored\n """',
      [steps]: 'Given("an account") {}',
      "engines/reports/reports.gemspec": "",
      "engines/reports/features/account.feature": scenario(" Given an account"),
      "engines/reports/features/step_definitions/account.rb": 'Given("an account") {}',
    });
    expect(resolver.getDependencies(feature)).toHaveLength(1);
    expect(resolver.getDependencies("engines/reports/features/account.feature")).toEqual([
      expect.objectContaining({target: "engines/reports/features/step_definitions/account.rb"}),
    ]);
  });
});

describe("RSpec described subjects", () => {
  const spec = "spec/requests/accounts_spec.rb", model = "app/models/account.rb";
  it("retains explicit production subject evidence separately from ordinary constant reads", () => {
    const resolver = fixture({...app, [model]: "class Account; end", [spec]: "RSpec.describe Account do\n context 'active' do; end\nend"});
    expect(resolver.getDependencies(spec)).toEqual(expect.arrayContaining([
      expect.objectContaining({target: model, kind: "rspec_subject", reference: "Account", line: 1}),
      expect.objectContaining({target: model, kind: "constant"}),
    ]));
  });

  it("rejects ambiguous, string, runtime, fake registry and test-only subjects", () => {
    const resolver = fixture({...app,
      [model]: "class Account; end", "app/services/duplicate.rb": "class Account; end",
      "spec/support/helper.rb": "class TestHelper; end",
      [spec]: 'describe Account do; end\ndescribe "Account" do; end\nFake.describe TestHelper do; end\nif enabled?; RSpec.describe TestHelper do; end; end\nRSpec.describe TestHelper do; end',
    });
    expect(resolver.getDependencies(spec).filter(f => f.kind === "rspec_subject")).toEqual([]);
  });
});

describe("mailer template and partial evidence", () => {
  const mailer = "app/mailers/accounts_mailer.rb", view = "app/views/accounts_mailer/welcome.html.erb";
  const base = {...app, "app/mailers/application_mailer.rb": "class ApplicationMailer < ActionMailer::Base; end"};
  it("links implicit action templates, literal mail options and mailer-local partials", () => {
    const resolver = fixture({...base,
      [mailer]: "class AccountsMailer < ApplicationMailer\n def welcome(user); mail(to: user.email); end\n def resend; mail(template_name: 'welcome'); end\n def custom; mail(template_path: 'shared', template_name: 'notice'); end\nend",
      [view]: '<%= render "footer" %>', "app/views/accounts_mailer/_footer.html.erb": "Hi",
      "app/views/shared/notice.html.erb": "Hi",
    });
    expect(resolver.getDependencies(mailer).filter(f => f.kind === "mailer_template")).toEqual([
      expect.objectContaining({target: view, line: 2, resolution: "inferred"}),
      expect.objectContaining({target: view, line: 3, resolution: "inferred"}),
      expect.objectContaining({target: "app/views/shared/notice.html.erb", line: 4}),
    ]);
    expect(resolver.getDependencies(view)).toEqual([expect.objectContaining({target: "app/views/accounts_mailer/_footer.html.erb", kind: "render"})]);
  });

  it("supports mail with no explicit header arguments", () => {
    const resolver = fixture({...base, [mailer]: "class AccountsMailer < ApplicationMailer; def welcome; mail; end; end", [view]: "Hi"});
    expect(resolver.getDependencies(mailer).filter(f => f.kind === "mailer_template")).toEqual([
      expect.objectContaining({target: view, resolution: "inferred"}),
    ]);
  });

  it.each(["welcome.text.erb", "welcome.json.jbuilder", "welcome.html.haml"])("rejects ambiguous formats and handlers: %s", sibling => {
    const resolver = fixture({...base, [mailer]: "class AccountsMailer < ApplicationMailer; def welcome; mail(to: 'a'); end; end",
      [view]: "Hi", ["app/views/accounts_mailer/" + sibling]: "Hi"});
    expect(resolver.getDependencies(mailer).filter(f => f.kind === "mailer_template")).toEqual([]);
  });

  it("keeps a namespaced superclass shadow from borrowing the global mailer ancestry", () => {
    const resolver = fixture({...base,
      "app/mailers/admin/base_mailer.rb": "module Admin; class BaseMailer < Other; end; end",
      "app/mailers/base_mailer.rb": "class BaseMailer < ActionMailer::Base; end",
      "app/mailers/admin/accounts_mailer.rb": "module Admin; class AccountsMailer < BaseMailer; def welcome; mail; end; end; end",
      "app/views/admin/accounts_mailer/welcome.html.erb": "Hi",
    });
    expect(resolver.getDependencies("app/mailers/admin/accounts_mailer.rb").filter(f => f.kind === "mailer_template")).toEqual([]);
  });

  it("rejects dynamic paths, bodies, format blocks, unrelated classes and lookup overrides", () => {
    for (const source of [
      "class AccountsMailer < ApplicationMailer; def welcome; mail(template_name: choice); end; end",
      "class AccountsMailer < ApplicationMailer; def welcome(mail); mail; end; end",
      "class AccountsMailer < ApplicationMailer; def welcome; mail = 'Hi'; mail; end; end",
      "class AccountsMailer < ApplicationMailer; def welcome; mail(body: 'Hi'); end; end",
      "class AccountsMailer < ApplicationMailer; def welcome; mail { |format| format.html }; end; end",
      "class AccountsMailer < Other; def welcome; mail; end; end",
      "class AccountsMailer < ApplicationMailer; def render; end; def welcome; mail; end; end",
    ]) {
      expect(fixture({...base, [mailer]: source, [view]: "Hi"}).getDependencies(mailer).filter(f => f.kind === "mailer_template")).toEqual([]);
    }
  });
});
