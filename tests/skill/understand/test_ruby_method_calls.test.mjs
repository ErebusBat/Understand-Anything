import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TreeSitterPlugin, builtinLanguageConfigs, collectRubyMethodCalls } from '../../../understand-anything-plugin/packages/core/dist/index.js';
import { GraphEdgeSchema } from '../../../understand-anything-plugin/packages/core/dist/schema.js';
import { dependencyRefreshPaths, refreshDependencyData, pruneExistingGraph } from '../../../understand-anything-plugin/skills/understand/prepare-incremental.mjs';
const skills = fileURLToPath(new URL('../../../understand-anything-plugin/skills/understand/', import.meta.url));
const parser = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === 'ruby'));
beforeAll(async () => parser.init());
let root;
afterEach(() => { if (root) rmSync(root, {recursive: true, force: true}); });
const caller = 'app/api/atelier/sheets/layouts.rb', target = 'app/services/tile_catalog.rb';
const sources = {
  'config/application.rb': 'class App < Rails::Application; end',
  [caller]: `module Atelier\n module Sheets\n  class Layouts < Grape::API\n   helpers do\n    def previews\n     TileCatalog.tiles_for_sheet(1)\n     TileCatalog.tiles_for_sheet(2)\n     ::TileCatalog.tiles_for_sheet(3)\n    end\n   end\n   before { ::Atelier::TokenRule.read_tiles }\n  end\n end\nend`,
  [target]: `class TileCatalog\n def tiles_for_sheet; end\n def self.tiles_for_sheet(id); end\n def self.local; ::TileCatalog.tiles_for_sheet(1); end\nend`,
  'app/services/other.rb': 'class Other; def self.tiles_for_sheet(id); end; end',
  'app/models/atelier/token_rule.rb': 'module Atelier; class TokenRule; def self.method_missing(name); end; end; end',
  'spec/dummy/config/application.rb': 'class Dummy < Rails::Application; end',
  'spec/dummy/app/services/tile_catalog.rb': 'class TileCatalog; def self.tiles_for_sheet(id); end; end',
};
function setup() {
  root = mkdtempSync(join(tmpdir(), 'ua-method-calls-'));
  for (const [path, source] of Object.entries(sources)) put(path, source);
  return Object.keys(sources).map(path => ({path, language: 'ruby', fileCategory: 'code'}));
}
function put(path, source) { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), source); }
function extract(files, analysisPaths, mode = 'pragmatic') {
  put('.understand-anything/config.json', JSON.stringify({rubyMixinResolution: mode}));
  put('input.json', JSON.stringify({projectRoot: root, files, analysisPaths}));
  execFileSync(process.execPath, [join(skills, 'extract-import-map.mjs'), join(root, 'input.json'), join(root, 'output.json')], {stdio: 'pipe'});
  return JSON.parse(readFileSync(join(root, 'output.json'), 'utf8'));
}
function readFileSyncSafe(path) { try { return readFileSync(path); } catch { return null; } }
function merge(scan, files, retained) {
  const intermediate = '.understand-anything/intermediate/';
  put(intermediate + 'scan-result.json', JSON.stringify(scan));
  const existing = join(root, intermediate, 'batch-existing.json');
  if (retained) put(intermediate + 'batch-existing.json', JSON.stringify(retained));
  else if (readFileSyncSafe(existing)) unlinkSync(existing);
  // Caller/callee really are in separate batches; both omitted function nodes
  // are recovered from parser evidence after canonical batch assembly.
  for (const [i, batch] of [[0, files.filter(f => f.path === caller)], [1, files.filter(f => f.path !== caller)]]) {
    put(intermediate + `batch-${i}.json`, JSON.stringify({nodes: batch.map(f => ({id: `file:${f.path}`, type: 'file', name: f.path, filePath: f.path, summary: '', tags: [], complexity: 'simple'})), edges: []}));
  }
  execFileSync('python3', [join(skills, 'merge-batch-graphs.py'), root], {stdio: 'pipe'});
  return JSON.parse(readFileSync(join(root, intermediate, 'assembled-graph.json'), 'utf8'));
}

describe('Ruby method calls through the shipped pipeline', () => {
  it('extracts named DSL helpers and keeps instance/singleton identity and locations', () => {
    const full = parser.analyzeFileFull(caller, sources[caller]);
    expect(full.structure.functions).toContainEqual(expect.objectContaining({name: 'previews', owner: 'Atelier::Sheets::Layouts', lineRange: [5, 9]}));
    expect(full.callGraph.filter(c => c.callee === 'TileCatalog.tiles_for_sheet')).toHaveLength(2);
    expect(parser.withSyntaxTree(caller, sources[caller], root => collectRubyMethodCalls(root)).sites.find(s => s.line === 6)).toMatchObject({receiver: 'TileCatalog', selector: 'tiles_for_sheet', caller: {dispatch: 'instance', line: 5}});
  });

  it('recovers same-file and cross-batch calls, reverse lookup, repeated sites and missing endpoint counts', () => {
    const files = setup(), scan = extract(files);
    const resolved = scan.methodCallMap[caller].filter(f => f.outcome === 'resolved');
    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatchObject({target, resolution: 'inferred', callee: {dispatch: 'singleton', line: 3}});
    expect(scan.methodCallMap[caller].find(f => f.selector === 'read_tiles')).toMatchObject({outcome: 'dynamic', receiverTarget: 'app/models/atelier/token_rule.rb'});
    const strict = extract(files, undefined, 'strict');
    expect(strict.methodCallMap[caller].find(f => f.line === 6)).toMatchObject({outcome: 'external_or_ambiguous'});
    expect(strict.methodCallMap[caller].find(f => f.line === 8)).toMatchObject({outcome: 'resolved'});
    const graph = merge(scan, files), again = merge(scan, files);
    const calls = graph.edges.filter(e => e.type === 'calls');
    const cross = calls.find(e => graph.nodes.find(n => n.id === e.source).filePath === caller);
    expect(cross.methodCallEvidence).toHaveLength(3);
    expect(GraphEdgeSchema.parse(cross)).toEqual(cross);
    expect(graph.nodes.find(n => n.id === cross.target)).toMatchObject({filePath: target, lineRange: [3, 3], name: 'TileCatalog.self.tiles_for_sheet'});
    expect(calls.filter(e => e.target === cross.target)).toHaveLength(2); // reverse callers
    expect(calls.filter(e => e.source === cross.source)).toHaveLength(1); // outbound
    expect(calls.some(e => e.target.includes('read_tiles'))).toBe(false);
    expect(graph.methodCallSummary).toMatchObject({crossFileEdges: 1, sameFileEdges: 1, resolvedMissingEndpointSites: 0});
    expect(again).toEqual(graph);
    const missing = merge(scan, files.filter(f => f.path !== target));
    expect(missing.methodCallSummary.resolvedMissingEndpointSites).toBeGreaterThan(0);
  });

  it('keeps ambiguous, shadowed, private and runtime selectors out of method edges', () => {
    const files = setup();
    put(target, 'class TileCatalog; def self.hidden; end; private_class_method :hidden; end');
    put(caller, 'class Caller; def call; ::TileCatalog.hidden; ::TileCatalog.unknown; object.hidden; Unknown.hidden; end; end');
    let scan = extract(files);
    expect(scan.methodCallMap[caller].filter(f => f.receiver === '::TileCatalog').map(f => f.outcome)).toEqual(['dynamic', 'dynamic']);
    expect(scan.methodCallMap[caller].find(f => f.selector === 'hidden' && f.dispatch === 'dynamic').outcome).toBe('dynamic');
    expect(scan.methodCallMap[caller].find(f => f.receiver === 'Unknown').outcome).toBe('external_or_ambiguous');
    const duplicate = 'app/models/tile_catalog.rb';
    put(duplicate, 'class TileCatalog; def self.hidden; end; end');
    scan = extract([...files, {path: duplicate, language: 'ruby', fileCategory: 'code'}]);
    expect(scan.methodCallMap[caller].filter(f => f.receiver === '::TileCatalog').every(f => f.outcome === 'external_or_ambiguous')).toBe(true);
    put(caller, 'class Caller; TileCatalog = Other; def call; TileCatalog.hidden; end; end');
    expect(extract(files).methodCallMap[caller].find(f => f.receiver === 'TileCatalog').outcome).toBe('external_or_ambiguous');
  });

  it('refreshes unchanged callers for competing declarations, rename and deletion, agreeing with full extraction', () => {
    let files = setup(), previous = extract(files);
    let previousGraph = merge(previous, files);
    const competing = 'app/api/atelier/tile_catalog.rb';
    put(competing, 'module Atelier; class TileCatalog; def self.tiles_for_sheet(id); end; end; end');
    files = [...files, {path: competing, language: 'ruby', fileCategory: 'code'}];
    for (const change of [competing, target, 'app/services/renamed_list.rb']) {
      if (change === target) {
        renameSync(join(root, target), join(root, 'app/services/renamed_list.rb'));
        files = files.map(f => f.path === target ? {...f, path: 'app/services/renamed_list.rb'} : f);
      }
      if (change === 'app/services/renamed_list.rb') {
        unlinkSync(join(root, change)); files = files.filter(f => f.path !== change);
      }
      const refresh = dependencyRefreshPaths({previousScan: previous, currentScan: {files}, graph: {}, changedPaths: [change], inventoryChanged: true});
      expect(refresh.paths).toContain(caller);
      const selective = extract(files, refresh.paths), full = extract(files);
      const incremental = refreshDependencyData({previousScan: previous, currentScan: {files}, extraction: selective, refreshPaths: refresh.paths});
      expect(incremental.methodCallMap[caller]).toEqual(full.methodCallMap[caller]);
      if (change === competing) expect(incremental.methodCallMap[caller].find(f => f.line === 6)).toMatchObject({target: competing});
      const old = {nodes: [{id: 'caller', filePath: caller}, {id: 'target', filePath: target}], edges: [{source: 'caller', target: 'target', type: 'calls', recoveredFromMethodCallMap: true}]};
      expect(pruneExistingGraph(old, new Set(), new Set(), new Set(refresh.paths)).edges).toEqual([]);
      const replaced = new Set([change, ...(change === target ? ['app/services/renamed_list.rb'] : [])]);
      const retained = pruneExistingGraph(previousGraph, replaced, new Set(), new Set(refresh.paths));
      const incrementalGraph = merge({...full, ...incremental}, files, retained);
      const fullGraph = merge(full, files);
      const deterministicCalls = graph => graph.edges.filter(edge => edge.recoveredFromMethodCallMap)
        .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
      expect(deterministicCalls(incrementalGraph)).toEqual(deterministicCalls(fullGraph));
      previousGraph = incrementalGraph;
      previous = {...full, files};
    }
  }, 30_000);
});
