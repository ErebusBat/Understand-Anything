import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '../../../understand-anything-plugin/skills/understand');
let root;
afterEach(() => { if (root) rmSync(root, {recursive: true, force: true}); });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

it('preserves recovered local dependencies through selective extraction and graph merge', () => {
  root = mkdtempSync(join(tmpdir(), 'ua-rails-local-pipeline-'));
  const helper = 'app/api/atelier/sheets/helpers/palette_helpers.rb';
  const caller = 'app/api/atelier/sheets/layouts.rb';
  const token_rule = 'app/models/atelier/token_rule.rb';
  const engine = 'engines/pigments/lib/pigments/engine.rb';
  const sources = {
    'config/application.rb': 'module Demo; class Application < Rails::Application; end; end',
    [helper]: 'module Atelier; module Sheets::Helpers::PaletteHelpers; end; end',
    [caller]: `module Atelier; module Sheets; class Layouts < Grape::API
      helpers Atelier::Sheets::Helpers::PaletteHelpers
      before { Atelier::TokenRule.read_tiles }
    end; end; end`,
    [token_rule]: 'module Atelier; class TokenRule < ActiveRecord::Base; def self.method_missing(name); super; end; end; end',
    [engine]: 'module Pigments; class Engine < Rails::Engine; end; end',
    'config/routes.rb': "Rails.application.routes.draw do; mount Pigments::Engine => '/pigments'; end",
    'engines/pigments/spec/dummy/config/application.rb': 'module Dummy; class Application < Rails::Application; end; end',
    'engines/pigments/spec/dummy/app/models/atelier/token_rule.rb': 'module Atelier; class TokenRule; end; end',
  };
  const files = Object.entries(sources).map(([path, source]) => {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), source);
    return {path, language: 'ruby', fileCategory: 'code'};
  });
  const input = join(root, 'input.json'), output = join(root, 'output.json');
  const extract = analysisPaths => {
    writeFileSync(input, JSON.stringify({projectRoot: root, files, analysisPaths}));
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    return read(output);
  };
  const full = extract();
  expect(full.failures).toEqual([]);
  for (const path of [caller, 'config/routes.rb']) expect(extract([path]).dependencyMap[path]).toEqual(full.dependencyMap[path]);
  expect(full.dependencyMap[caller]).toContainEqual(expect.objectContaining({target: helper, kind: 'grape_helper'}));
  expect(full.dependencyMap[caller]).toContainEqual(expect.objectContaining({target: token_rule, kind: 'constant', resolution: 'inferred'}));
  expect(full.dependencyMap['config/routes.rb']).toContainEqual(expect.objectContaining({target: engine, type: 'routes'}));

  const intermediate = join(root, '.ua/intermediate');
  mkdirSync(intermediate, {recursive: true});
  writeFileSync(join(intermediate, 'scan-result.json'), JSON.stringify({files, ...full}));
  // Model outputs intentionally omit relationships; the deterministic merge
  // must recover cross-batch facts against actual inventory file endpoints.
  for (const [index, paths] of [[caller, 'config/routes.rb'], Object.keys(sources).filter(p => p !== caller && p !== 'config/routes.rb')].entries()) {
    writeFileSync(join(intermediate, `batch-${index}.json`), JSON.stringify({
      nodes: paths.map(path => ({id: `file:${path}`, type: 'file', name: path.split('/').at(-1), filePath: path})), edges: [],
    }));
  }
  run('python3', [join(scripts, 'merge-batch-graphs.py'), root]);
  const graphPath = join(intermediate, 'assembled-graph.json');
  const graph = read(graphPath);
  for (const [source, target, type] of [[caller, helper, 'depends_on'], [caller, token_rule, 'depends_on'], ['config/routes.rb', engine, 'routes']]) {
    expect(graph.edges).toContainEqual(expect.objectContaining({source: `file:${source}`, target: `file:${target}`, type}));
  }
  expect(graph.edges.some(edge => edge.type === 'calls')).toBe(false);
  const ids = new Set(graph.nodes.map(node => node.id));
  expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  expect(new Set(graph.edges.map(edge => `${edge.source}|${edge.target}|${edge.type}`)).size).toBe(graph.edges.length);
  const serialized = readFileSync(graphPath, 'utf8');
  run('python3', [join(scripts, 'merge-batch-graphs.py'), root]);
  expect(readFileSync(graphPath, 'utf8')).toBe(serialized);
}, 30_000);
