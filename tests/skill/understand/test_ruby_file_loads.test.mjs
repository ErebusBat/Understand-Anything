import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../understand-anything-plugin/skills/understand/extract-import-map.mjs', import.meta.url));
let projectRoot;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, {recursive: true, force: true});
});

function extract(sources, analysisPaths) {
  projectRoot = mkdtempSync(join(tmpdir(), 'ua-file-loads-'));
  const files = Object.entries(sources).map(([path, source]) => {
    mkdirSync(join(projectRoot, dirname(path)), {recursive: true});
    writeFileSync(join(projectRoot, path), source);
    return {path, language: /\.ya?ml$/.test(path) ? 'yaml' : 'ruby', fileCategory: 'code'};
  });
  const input = join(projectRoot, 'input.json'), output = join(projectRoot, 'output.json');
  writeFileSync(input, JSON.stringify({projectRoot, files, analysisPaths}));
  execFileSync(process.execPath, [script, input, output], {stdio: 'pipe'});
  return JSON.parse(readFileSync(output, 'utf8'));
}

describe('Ruby filesystem dependencies', () => {
  it('resolves rooted require paths within the owning workspace application', () => {
    const sources = {
      'alpha/config/application.rb': "require File.expand_path('../boot', __FILE__)\nclass Application < Rails::Application; end",
      'alpha/config/boot.rb': '',
      'alpha/config/environment.rb': "require ::File.expand_path('../application', __FILE__)",
      'alpha/config.ru': "require ::File.expand_path('../config/environment', __FILE__)",
      'alpha/script/rails': "#!/usr/bin/env ruby\nrequire File.expand_path(File.dirname(__FILE__) + '/../config/boot.rb')",
      'alpha/lib/tasks/boot.rake': "require Rails.root.join('config', 'boot')",
      'alpha/shadow.rb': "module Shadow; File = Other; require File.expand_path('../config/boot', __FILE__); end",
      'alpha/dynamic.rb': [
        "require File.expand_path('config/boot')", "require File.expand_path('../config/boot', selected_base)",
        "require File.expand_path('../../beta/config/boot', __FILE__)", "require Rails.root.join('/config/boot')",
        "require Rails.root.join('inner/config/boot')", "require Rails.root.join(:config, :boot)",
      ].join('\n'),
      'alpha/inner/config/application.rb': 'class Other < Rails::Application; end',
      'alpha/inner/config/boot.rb': '',
      'beta/config/application.rb': 'class Application < Rails::Application; end',
      'beta/config/boot.rb': '',
      'standalone/lib/example/engine.rb': "class Example < Rails::Engine; end\nrequire Rails.root.join('config', 'boot')",
      'standalone/config/boot.rb': '',
    };
    const {importMap, failures} = extract(sources, Object.keys(sources));
    expect(failures).toEqual([]);
    expect(importMap['alpha/config/application.rb']).toEqual(['alpha/config/boot.rb']);
    expect(importMap['alpha/config/environment.rb']).toEqual(['alpha/config/application.rb']);
    expect(importMap['alpha/config.ru']).toEqual(['alpha/config/environment.rb']);
    expect(importMap['alpha/script/rails']).toEqual(['alpha/config/boot.rb']);
    expect(importMap['alpha/lib/tasks/boot.rake']).toEqual(['alpha/config/boot.rb']);
    expect(importMap['alpha/shadow.rb']).toEqual([]);
    expect(importMap['alpha/dynamic.rb']).toEqual([]);
    expect(importMap['standalone/lib/example/engine.rb']).toEqual([]);
  });
  it('resolves literal imports against the local gems selected by the host bundle', () => {
    const gemspec = (name, paths = '') => [
      'Gem::Specification.new do |s|', `  s.name = "${name}"`, paths, 'end',
    ].join('\n');
    const sources = {
      'alpha/Gemfile': [
        "gem 'news', '~> 1', :path => 'gems/news', :require => false",
        "gem 'shop', path: 'engines/shop'", "gem 'sometimes', path: 'gems/sometimes' if enabled?",
        "gem 'custom', path: 'gems/custom'", "gem 'outside', path: '../../../outside'",
      ].join('\n'),
      'alpha/config/application.rb': 'class App < Rails::Application; end',
      'alpha/gems/news/Gemfile': 'gemspec',
      'alpha/gems/news/news.gemspec': gemspec('news', '  s.require_paths = %w[src lib]'),
      'alpha/gems/news/lib/news.rb': '', 'alpha/gems/news/src/news.rb': '',
      'alpha/gems/news/src/shared.rb': '', 'alpha/gems/news/src/logger.rb': '', 'alpha/gems/news/src/maybe.rb': '',
      'alpha/engines/shop/Gemfile': 'gemspec',
      'alpha/engines/shop/shop.gemspec': gemspec('shop'),
      'alpha/engines/shop/lib/shop.rb': 'require "news.rb"',
      'alpha/engines/shop/lib/shared.rb': '', 'alpha/lib/logger.rb': '',
      'alpha/gems/sometimes/sometimes.gemspec': gemspec('sometimes'),
      'alpha/gems/sometimes/lib/conditional.rb': '', 'alpha/gems/sometimes/lib/maybe.rb': '',
      'alpha/gems/custom/custom.gemspec': gemspec('custom', '  s.require_paths << ENV["LIB"] if enabled?'),
      'alpha/gems/custom/lib/mutated.rb': '',
      'alpha/run.rb': ['news', 'shop', 'shared', 'logger', 'conditional', 'mutated', 'maybe', '../gems/news/src/news']
        .map(feature => `require "${feature}"`).join('\n'),
      'alpha/engines/shop/spec/dummy/config/application.rb': 'require "shop"\nclass App < Rails::Application; end',
      'alpha/private/config/application.rb': 'require "news"\nclass App < Rails::Application; end',
      'alpha/tools/Gemfile': 'gem "json"', 'alpha/tools/run.rb': 'require "shop"',
      'bravo/Gemfile': 'gem "json"', 'bravo/run.rb': 'require "news"',
    };
    const paths = ['alpha/run.rb', 'alpha/engines/shop/lib/shop.rb',
      'alpha/engines/shop/spec/dummy/config/application.rb', 'alpha/private/config/application.rb',
      'alpha/tools/run.rb', 'bravo/run.rb'];
    const {importMap, failures} = extract(sources, paths);
    expect(failures).toEqual([]);
    expect(importMap).toEqual({
      [paths[0]]: ['alpha/engines/shop/lib/shop.rb', 'alpha/gems/news/src/news.rb'],
      [paths[1]]: ['alpha/gems/news/src/news.rb'], [paths[2]]: ['alpha/engines/shop/lib/shop.rb'],
      [paths[3]]: [], [paths[4]]: [], [paths[5]]: [],
    });
  });

  it('resolves Rails require_dependency in autoload paths before consulting bundle load paths', () => {
    const sources = {
      'host/config/application.rb': 'class App < Rails::Application; end',
      'host/Gemfile': 'gem "billing", path: "gems/billing"',
      'host/gems/billing/billing.gemspec': 'Gem::Specification.new do |s|; s.name = "billing"; end',
      'host/gems/billing/lib/billing/types.rb': '', 'host/gems/billing/lib/billing/client.rb': '',
      'host/app/models/billing/types.rb': '', 'host/app/services/duplicate.rb': '', 'host/app/models/duplicate.rb': '',
      'host/lib/private.rb': '',
      'host/use.rb': [
        'require_dependency "billing/types.rb"', 'require_dependency("billing/client")', 'require_dependency "private"',
        'require_dependency "duplicate"', 'require_dependency chosen', 'require_dependency "../lib/private"',
        'other.require_dependency "ignored"', 'Kernel.require_dependency "ignored"',
      ].join('\n'),
      'host/lib/ignored.rb': '',
      'host/redefined.rb': 'def require_dependency(feature); end; require_dependency "private"',
      'other/config/application.rb': 'class Other < Rails::Application; end',
      'other/test.rb': 'require_dependency "billing/client"', 'loose/lib/feature.rb': '',
      'loose/test.rb': 'require_dependency "loose/lib/feature"',
    };
    const paths = ['host/use.rb', 'host/redefined.rb', 'other/test.rb', 'loose/test.rb'];
    const {importMap, failures} = extract(sources, paths);
    expect(failures).toEqual([]);
    expect(importMap).toEqual({
      [paths[0]]: ['host/app/models/billing/types.rb', 'host/gems/billing/lib/billing/client.rb', 'host/lib/private.rb'],
      [paths[1]]: [], [paths[2]]: [], [paths[3]]: [],
    });
  });

  it('resolves selected glob members only when the block consumes the yielded path directly', () => {
    const source = 'alpha/lib/config.rb';
    const sources = {
      'alpha/config/application.rb': 'class App < Rails::Application; end',
      [source]: [
        'def load_config',
        `  pattern = "#{File.expand_path(File.dirname(__FILE__)+'/..')}/config/settings/*.yml"`,
        '  Dir[pattern].each do |f|',
        '    values = YAML.load(ERB.new(File.read(f)).result)',
        '  end',
        'end',
        "Dir[Rails.root.join('spec/support/**/*.rb')].each { |path| require path }",
      ].join('\n'),
      'alpha/config/settings/z.yml': '', 'alpha/config/settings/a.yml': '',
      'alpha/config/settings/nested/extra.yml': '', 'alpha/config/settings/.hidden.yml': '',
      'alpha/spec/support/provider.rb': '', 'alpha/spec/support/sub/another.rb': '',
      'alpha/spec/support/.hidden.rb': '', 'alpha/spec/support/.old/skip.rb': '',
      'alpha/spec/support/dummy/config/application.rb': 'class Dummy < Rails::Application; end',
      'alpha/spec/support/dummy/child.rb': '',
      'alpha/lib/rejected.rb': [
        "Dir['spec/support/**/*.rb'].each { |r| require r }",
        "Dir[Rails.root.join('spec/support/**/*.rb')].each { |r| require r if enabled? }",
        "Dir[Rails.root.join('spec/support/**/*.rb')].each { |r| r.replace('fake'); require r }",
        "Dir.glob(Rails.root.join('config/settings/*.yml')) { |f| parse(transform!(f), File.read(f)) }",
        "path = Rails.root.join('config/settings/*.yml')",
        "mutate(path)",
        "Dir[path].each { |f| File.read(f) }",
        "Dir.glob(Rails.root.join('config/settings/*.{yml,yaml}')) { |f| File.read(f) }",
      ].join('\n'),
      'alpha/lib/shadow.rb': [
        "module Foo", "  Dir = Other",
        "  Dir.glob(Rails.root.join('config/settings/*.yml')) { |f| File.read(f) }", "end",
      ].join('\n'),
    };
    const result = extract(sources, [source, 'alpha/lib/rejected.rb', 'alpha/lib/shadow.rb']);
    expect(result.failures).toEqual([]);
    expect(result.importMap).toEqual({
      [source]: ['alpha/spec/support/provider.rb', 'alpha/spec/support/sub/another.rb'],
      'alpha/lib/rejected.rb': [], 'alpha/lib/shadow.rb': [],
    });
    const reads = path => result.dependencyMap[path].filter(fact => fact.kind === 'file_read');
    expect(reads(source)).toEqual(['a', 'z'].map(name => ({
      type: 'depends_on', kind: 'file_read', reference: 'alpha/config/settings/*.yml',
      target: 'alpha/config/settings/' + name + '.yml', line: 4,
    })));
    expect(reads('alpha/lib/rejected.rb')).toEqual([]);
    expect(reads('alpha/lib/shadow.rb')).toEqual([]);
  });
});
