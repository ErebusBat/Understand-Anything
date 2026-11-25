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
    return {path, language: path.endsWith('.yaml') ? 'yaml' : 'ruby', fileCategory: 'code'};
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
});
