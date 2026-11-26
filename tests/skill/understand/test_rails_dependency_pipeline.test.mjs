import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '../../../understand-anything-plugin/skills/understand');
const python = ['python3', 'python', 'py'].map(command => ({ command, prefix: command === 'py' ? ['-3'] : [] }))
  .find(({ command, prefix }) => spawnSync(command, [...prefix, '--version']).status === 0);
let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe('Rails dependencies through extraction, batching and deterministic merge', () => {
  it.each(['', 'service/master/'])('resolves an application below the workspace root: %s', prefix => {
    root = mkdtempSync(join(tmpdir(), 'ua-rails-workspace-'));
    const sources = {
      'config/application.rb': 'module Demo; class Application < Rails::Application; end; end',
      'app/models/user.rb': 'class User; end',
      'app/controllers/users_controller.rb': 'class UsersController; def show; User.find(1); end; end',
    };
    const files = Object.entries(sources).map(([localPath, source]) => {
      const path = prefix + localPath;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
      return { path, language: 'ruby', fileCategory: 'code' };
    });
    const input = join(root, 'input.json');
    const output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify({ projectRoot: root, files }));
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    const extraction = JSON.parse(readFileSync(output, 'utf-8'));
    expect(extraction.failures).toEqual([]);
    expect(extraction.dependencyMap[prefix + 'app/controllers/users_controller.rb']).toEqual([
      expect.objectContaining({ target: prefix + 'app/models/user.rb', type: 'depends_on', kind: 'constant' }),
    ]);
  });

  it('keeps nested application facts isolated through selective extraction and merge', () => {
    root = mkdtempSync(join(tmpdir(), 'ua-rails-workspace-pipeline-'));
    const sources = {};
    for (const prefix of ['orders/master/', 'reports/', 'broken/']) {
      Object.assign(sources, {
        [prefix + 'config/application.rb']: 'module Demo; class Application < Rails::Application; end; end',
        [prefix + 'app/models/user.rb']: 'class User; end',
        [prefix + 'app/controllers/users_controller.rb']: "require_relative '../models/user'\nrequire 'shared/logger'\nclass UsersController; def show; User.find; end; end",
        [prefix + 'lib/shared/logger.rb']: 'module Shared; module Logger; end; end',
        [prefix + 'config/routes.rb']: 'Rails.application.routes.draw { resources :users }',
      });
    }
    sources['broken/spec/broken_spec.rb'] = 'class Broken <';
    sources['lib/shared/logger.rb'] = 'module Shared; module Logger; end; end';
    const files = Object.entries(sources).map(([path, source]) => {
      mkdirSync(dirname(join(root, path)), {recursive: true});
      writeFileSync(join(root, path), source);
      return {path, language: 'ruby', fileCategory: 'code'};
    });
    const input = join(root, 'input.json');
    const output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify({projectRoot: root, files}));
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    const full = JSON.parse(readFileSync(output, 'utf-8'));
    expect(full.failures).toEqual([expect.objectContaining({path: 'broken/spec/broken_spec.rb'})]);
    expect(full.dependencyMap['broken/app/controllers/users_controller.rb']).toEqual([]);
    for (const prefix of ['orders/master/', 'reports/']) {
      expect(full.importMap[prefix + 'app/controllers/users_controller.rb']).toEqual([
        prefix + 'app/models/user.rb', prefix + 'lib/shared/logger.rb',
      ]);
      expect(full.dependencyMap[prefix + 'app/controllers/users_controller.rb']).toEqual([
        expect.objectContaining({target: prefix + 'app/models/user.rb', kind: 'constant'}),
      ]);
      expect(full.dependencyMap[prefix + 'config/routes.rb']).toEqual([
        expect.objectContaining({target: prefix + 'app/controllers/users_controller.rb', kind: 'route'}),
      ]);
    }
    const consumer = 'orders/master/app/controllers/users_controller.rb';
    writeFileSync(input, JSON.stringify({projectRoot: root, files: [...files].reverse(), analysisPaths: [consumer]}));
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    const selective = JSON.parse(readFileSync(output, 'utf-8'));
    expect(selective.dependencyMap).toEqual({[consumer]: full.dependencyMap[consumer]});
    expect(selective.dependencyContexts).toEqual(full.dependencyContexts);

    const intermediate = join(root, '.ua/intermediate');
    mkdirSync(intermediate, {recursive: true});
    writeFileSync(join(intermediate, 'scan-result.json'), JSON.stringify({files, ...full}));
    writeFileSync(join(intermediate, 'batch-0.json'), JSON.stringify({
      nodes: files.map(({path}) => ({id: `file:${path}`, type: 'file', name: path.split('/').at(-1), filePath: path})), edges: [],
    }));
    run(python.command, [...python.prefix, join(scripts, 'merge-batch-graphs.py'), root]);
    const graph = JSON.parse(readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8'));
    for (const prefix of ['orders/master/', 'reports/']) {
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({source: `file:${prefix}app/controllers/users_controller.rb`, target: `file:${prefix}app/models/user.rb`, type: 'depends_on'}),
        expect.objectContaining({source: `file:${prefix}config/routes.rb`, target: `file:${prefix}app/controllers/users_controller.rb`, type: 'routes'}),
      ]));
    }
    expect(graph.edges.every(e => e.source.split('/')[0] === e.target.split('/')[0])).toBe(true);
  });

  it('recovers typed file edges and test pairings without inventing imports or action symbols', () => {
    root = mkdtempSync(join(tmpdir(), 'ua-rails-pipeline-'));
    const sources = {
      Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
      'config/application.rb': 'module Demo\n class Application < Rails::Application\n end\nend\n',
      'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\nend\n',
      'app/models/partner.rb': 'class Partner < ApplicationRecord\n include Trackable\n belongs_to :person\n has_many :pictures, as: :imageable\n belongs_to :attachable, polymorphic: true\n has_many :events, through: :pictures\nend\n',
      'app/models/person.rb': 'class Person < ApplicationRecord\nend\n',
      'app/models/picture.rb': 'class Picture < ApplicationRecord\nend\n',
      'app/models/attachable.rb': 'class Attachable < ApplicationRecord\nend\n',
      'app/models/event.rb': 'class Event < ApplicationRecord\nend\n',
      'app/models/concerns/trackable.rb': 'module Trackable\nend\n',
      'app/controllers/partners_controller.rb': 'class PartnersController\n def index\n Partner.find(1)\n end\nend\n',
      'app/controllers/geocoders_controller.rb': 'class GeocodersController\nend\n',
      'config/routes.rb': 'Rails.application.routes.draw do\n get "/partners", to: "partners#index"\n resource :geocoder\n namespace :admin do\n resources :partners\n end\nend\n',
      'lib/unconfigured.rb': 'class Unconfigured\nend\n',
      'app/services/check.rb': 'require_relative "../../lib/explicit"\nclass Check\n def run\n Unconfigured.call\n end\nend\n',
      'lib/explicit.rb': 'module Explicit\nend\n',
      'test/models/partner_test.rb': 'class PartnerTest < ActiveSupport::TestCase\nend\n',
      'spec/requests/partners_spec.rb': 'describe "partners" do\nend\n',
    };
    const files = Object.entries(sources).map(([path, source]) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
      return { path, language: 'ruby', fileCategory: 'code', sizeLines: source.split('\n').length };
    });
    const input = join(root, 'input.json');
    const output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify({ projectRoot: root, files }));
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    const extractionText = readFileSync(output, 'utf-8');
    const extraction = JSON.parse(extractionText);
    expect(extraction.failures).toEqual([]);
    expect(extraction.dependencyResolverVersion).toBe(9);
    expect(extraction.importMap['app/services/check.rb']).toEqual(['lib/explicit.rb']);
    expect(extraction.importMap['app/models/partner.rb']).toEqual([]);
    const facts = extraction.dependencyMap['app/models/partner.rb'];
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'app/models/person.rb', type: 'depends_on', kind: 'association' }),
      expect.objectContaining({ target: 'app/models/picture.rb', type: 'depends_on', kind: 'association' }),
      expect.objectContaining({ target: 'app/models/concerns/trackable.rb', type: 'depends_on', kind: 'include' }),
      expect.objectContaining({ target: 'app/models/application_record.rb', type: 'inherits' }),
    ]));
    expect(facts.some(fact => /\/(attachable|event)\.rb$/.test(fact.target))).toBe(false);
    expect(extraction.dependencyMap['app/services/check.rb'].some(fact => fact.target === 'lib/unconfigured.rb')).toBe(false);
    expect(extraction.dependencyMap['config/routes.rb']).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'app/controllers/partners_controller.rb', type: 'routes' }),
      expect.objectContaining({ target: 'app/controllers/geocoders_controller.rb', type: 'routes' }),
    ]));
    expect(extraction.dependencyDiagnostics.some(d => d.path === 'config/routes.rb')).toBe(true);
    run(process.execPath, [join(scripts, 'extract-import-map.mjs'), input, output]);
    expect(readFileSync(output, 'utf-8')).toBe(extractionText);

    const intermediate = join(root, '.ua/intermediate');
    mkdirSync(intermediate, { recursive: true });
    writeFileSync(join(intermediate, 'scan-result.json'), JSON.stringify({ files, ...extraction }));
    run(process.execPath, [join(scripts, 'compute-batches.mjs'), root]);
    const batches = JSON.parse(readFileSync(join(intermediate, 'batches.json'), 'utf-8')).batches;
    const modelBatch = batches.find(batch => Object.hasOwn(batch.batchDependencyData, 'app/models/partner.rb'));
    expect(modelBatch.batchDependencyData['app/models/partner.rb']).toEqual(facts);
    expect(modelBatch.batchImportData['app/models/partner.rb']).toEqual([]);
    // Simulate an analyzer that drops all relationships. Merge must restore them
    // from the deterministic scan, including facts between different batches.
    for (const batch of batches) {
      writeFileSync(join(intermediate, `batch-${batch.batchIndex}.json`), JSON.stringify({
        nodes: batch.files.map(file => ({ id: `file:${file.path}`, type: 'file', name: file.path.split('/').at(-1), filePath: file.path, summary: '', tags: [], complexity: 'simple' })),
        edges: [],
      }));
    }
    expect(python, 'Python is required for the merge pipeline').toBeDefined();
    run(python.command, [...python.prefix, join(scripts, 'merge-batch-graphs.py'), root]);
    const mergedText = readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8');
    const graph = JSON.parse(mergedText);
    for (const [source, dependencies] of Object.entries(extraction.dependencyMap)) {
      for (const fact of dependencies) {
        expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: `file:${source}`, target: `file:${fact.target}`, type: fact.type })]));
      }
    }
    expect(graph.edges.filter(edge => edge.type === 'imports')).toEqual([
      expect.objectContaining({ source: 'file:app/services/check.rb', target: 'file:lib/explicit.rb' }),
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'file:app/models/partner.rb', target: 'file:test/models/partner_test.rb', type: 'tested_by' })]));
    expect(graph.edges.some(edge => edge.type === 'tested_by' && edge.target === 'file:spec/requests/partners_spec.rb')).toBe(false);
    expect(graph.edges.some(edge => edge.type === 'calls')).toBe(false);
    expect(new Set(graph.edges.map(edge => `${edge.source}|${edge.target}|${edge.type}`)).size).toBe(graph.edges.length);
    run(python.command, [...python.prefix, join(scripts, 'merge-batch-graphs.py'), root]);
    expect(readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8')).toBe(mergedText);
  }, 30_000);
});
