import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSprocketsResolver } from '../../../understand-anything-plugin/skills/understand/sprockets-imports.mjs';

const js = 'app/assets/javascripts/';
const css = 'app/assets/stylesheets/';
const views = 'app/assets/templates/';
const script = fileURLToPath(new URL('../../../understand-anything-plugin/skills/understand/extract-import-map.mjs', import.meta.url));

describe('Sprockets require directives', () => {
  it('resolves header directives against the full inventory during selective extraction', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-sprockets-'));
    try {
      const inputs = [
        ['Gemfile', 'ruby', 'code', "gem 'handlebars_assets', '~> 0.16'"],
        [js + 'application.js.coffee', 'coffeescript', 'code', [
          '#= require_tree ../templates', '#= require_directory ./models',
          "#= require './extra file'", '#= require_self', '#= require missing',
          '#= require jquery', '#= require style.css', '#= require ./models/user.js',
          'App = {}', '#= require after', '',
        ].join('\n')],
        [js + 'extra file.js', 'javascript', 'code', ''],
        [js + 'models/user.js.coffee', 'coffeescript', 'code', ''],
        [js + 'models/nested/other.js', 'javascript', 'code', ''],
        [js + 'after.js', 'javascript', 'code', ''],
        [views + 'admin/cart.hbs', 'handlebars', 'markup', ''],
        [views + 'page.html.erb', 'erb', 'markup', ''],
        ['vendor/assets/javascripts/jquery.js', 'javascript', 'code', ''],
        ['other/' + js + 'missing.js', 'javascript', 'code', ''],
        ['other/' + js + 'application.js', 'javascript', 'code', '//= require_tree ../templates'],
        ['other/' + views + 'cart.hbs', 'handlebars', 'markup', ''],
        [css + 'application.css', 'css', 'markup', '/*\n *= require style\n */\nbody {}\n/*= require after */'],
        [css + 'style.scss', 'css', 'markup', ''],
        [css + 'after.scss', 'css', 'markup', ''],
      ];
      const files = inputs.map(([path, language, fileCategory, content]) => {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), content);
        return { path, language, fileCategory };
      });
      const analysisPaths = [files[1].path, css + 'application.css', 'other/' + js + 'application.js'];
      const input = join(root, 'input.json'), output = join(root, 'output.json');
      writeFileSync(input, JSON.stringify({ projectRoot: root, files, analysisPaths }));
      execFileSync(process.execPath, [script, input, output], { stdio: 'pipe' });
      const result = JSON.parse(readFileSync(output, 'utf8'));
      expect(result.failures).toEqual([]);
      expect(result.importMap).toEqual({
        [analysisPaths[0]]: [js + 'extra file.js', js + 'models/user.js.coffee', views + 'admin/cart.hbs'],
        [analysisPaths[1]]: [css + 'style.scss'],
        [analysisPaths[2]]: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous logical paths, respects stubs and skips self and other output types', () => {
    const path = js + 'entry.js';
    const files = [path, js + 'item.coffee', 'lib/assets/javascripts/item.js',
      js + 'skip.js', js + 'dir/index.js', js + 'dir/sub/example.js', js + 'wrong.css'
    ].map(path => ({ path }));
    const resolver = createSprocketsResolver(files);
    const content = ['//= require item', '//= require dir', '//= require_tree ./dir',
      '//= require_directory .', '//= stub ./skip', '//= require_tree /',
    ].join('\n');
    expect(resolver.imports(path, '//= require item')).toEqual([]);
    expect(resolver.imports(path, '#= require dir')).toEqual([]);
    expect(resolver.imports(path, '//= require_tree ..\n//= require_tree ../../..')).toEqual([]);
    expect(resolver.imports(path, content)).toEqual([
      js + 'dir/index.js', js + 'dir/sub/example.js', js + 'item.coffee',
    ]);
    expect(resolver.imports(path, "const example = '\\n//= require dir';")).toEqual([]);
  });
});
