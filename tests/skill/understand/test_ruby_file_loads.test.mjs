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
