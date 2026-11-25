import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const extractor = fileURLToPath(new URL('../../../understand-anything-plugin/skills/understand/extract-import-map.mjs', import.meta.url));
const application = 'class Application < Rails::Application; end';
const gem = "gem 'resque-scheduler'";

it('traces explicit and configuration-accessor schedule inputs to jobs within the same Rails application', () => {
  const root = mkdtempSync(join(tmpdir(), 'ua-resque-'));
  try {
    const files = [], analysisPaths = [];
    const app = (name, source, setup = {}) => {
      for (const [path, content] of Object.entries({
        Gemfile: gem,
        'config/application.rb': application,
        'app/jobs/report.rb': 'class Report; def self.perform; end; end',
        'app/jobs/other.rb': 'module Other; module_function; def perform; end; end',
        'app/jobs/missing.rb': 'class Missing; def perform; end; end',
        'config/initializers/resque.rb': "Resque.schedule = YAML.load_file(Rails.root.join('config', 'resque_schedule.yml'))",
        'config/resque_schedule.yml': source,
        ...setup,
      })) {
        const scoped = name + '/' + path;
        mkdirSync(join(root, dirname(scoped)), {recursive:true});
        writeFileSync(join(root, scoped), content);
        const yaml = path.endsWith('.yml');
        files.push({path:scoped, language:yaml ? 'yaml' : 'ruby', fileCategory:yaml ? 'config' : 'code'});
        if (yaml) analysisPaths.push(scoped);
      }
    };
    const direct = [
      'label:', '  cron: "* * * * *"', '  class: Report',
      'Other:', '  every: 5m',
      'Missing:', '  every: 1m',
      'Unbound:', '  every: 1m',
      'bad:', '  every: 1m', '  class: [Report, Other]',
      'custom:', '  every: 1m', '  custom_job_class: Other', '  class: Report',
    ].join('\n');
    app('direct', direct);
    const accessor = {
      'config/job_settings/resque.yml': 'common:\n  schedule:\n    Report:\n      every: 1m\nproduction:\n  schedule:\n    nightly:\n      class: Other\n      cron: "1 2 3 4 *"',
      'config/initializers/resque.rb': "unless skip?\nResque.schedule = Settings.resque.schedule.to_hash\nend",
      'app/services/settings.rb': "class Settings\n Dir[Rails.root.join('config/job_settings/*.yml')].each { |f| YAML.load(File.read(f)) }\nend",
    };
    app('accessor', '', accessor);
    app('wrong_config', '', {...accessor, 'app/services/settings.rb': "class Settings; end"});
    app('missing_gem', direct, {Gemfile:"gem 'resque'"});
    app('dynamic', 'Report:\n  every: <%= interval %>');
    app('alias', 'base: &shared {every: 1m}\nReport: *shared');
    app('duplicate', 'Report: {every: 1m}\nReport: {every: 2m}');
    app('competing_jobs', 'Report: {every: 1m}', {'app/jobs/duplicate.rb':'class Report; def self.perform; end; end'});
    app('competing_loader', direct, {'config/initializers/override.rb': 'Resque.schedule = dynamic_loader'});
    app('other_app', 'External: {every: 1m}');
    app('external', '', {'app/jobs/external.rb':'class External; def self.perform; end; end'});

    const input = join(root, 'input.json'), output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify({projectRoot:root, files, analysisPaths}));
    execFileSync(process.execPath, [extractor, input, output], {stdio:'pipe'});
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result.failures).toEqual([]);
    const fact = (target, line, reference) => ({target, line, reference, type:'depends_on', kind:'resque_schedule', resolution:'inferred'});
    expect(result.dependencyMap['direct/config/resque_schedule.yml']).toEqual([
      fact('direct/app/jobs/other.rb', 4, 'Other => Other'),
      fact('direct/app/jobs/report.rb', 1, 'label => Report'),
    ]);
    expect(result.dependencyMap['accessor/config/job_settings/resque.yml']).toEqual([
      fact('accessor/app/jobs/other.rb', 7, 'production.nightly => Other'),
      fact('accessor/app/jobs/report.rb', 3, 'common.Report => Report'),
    ]);
    for (const [path, facts] of Object.entries(result.dependencyMap)) {
      if (path !== 'direct/config/resque_schedule.yml' && path !== 'accessor/config/job_settings/resque.yml') expect(facts, path).toEqual([]);
    }
  } finally { rmSync(root, {recursive:true, force:true}); }
});
