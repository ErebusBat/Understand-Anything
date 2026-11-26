import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/skills/understand/SKILL.md'),
  'utf-8',
);
const hook = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/hooks/auto-update-prompt.md'),
  'utf-8',
);
const analyzer = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/agents/file-analyzer.md'), 'utf-8',
);
const scanner = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/agents/project-scanner.md'), 'utf-8',
);

describe('incremental execution contract', () => {
  it.each([skill, hook])('routes inventory and baseline updates through bundled helpers', content => {
    expect(content).toContain('prepare-incremental.mjs');
    expect(content).toContain('finalize-incremental.mjs');
    expect(content).toContain('filesToReanalyze');
    expect(content).toContain('batch-existing.json');
    expect(content).toContain('generated-artifact-only');
  });

  it('skips whole-graph LLM phases for ordinary partial updates', () => {
    expect(skill).toContain('Both incremental actions skip assemble-reviewer');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no architecture agent');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no tour agent');
    expect(skill).toContain('Without `--review`');
    expect(skill).toContain('Do not run Phase 6');
  });

  it('keeps explicit review and architecture escalation behavior', () => {
    expect(skill).toContain('The user-facing `--review` option is still honored');
    expect(skill).toContain('where `rerunArchitecture === true`');
    expect(skill).toContain('where `rerunTour === true`');
    expect(skill).toContain('`FULL_UPDATE`');
    expect(skill).toContain('With explicit `--review`');
    expect(skill).toContain('jump to the `--review` graph-reviewer path in Phase 6');
  });

  it.each([skill, hook])('requires deterministic symbol checking and one targeted repair', content => {
    expect(content).toContain('incremental-symbol-baseline.json');
    expect(content).toContain('validate-incremental-symbols.mjs');
    expect(content).toContain('incremental-symbol-report.json');
    expect(content).toContain('prepare-symbol-retry.mjs');
    expect(content).toContain('incremental-symbol-retry.json');
    expect(content).toContain('previousSymbols');
    expect(content).toContain('missingSymbols');
    expect(content).toContain('independently reruns the shared symbol');
  });

  it('keeps significance filtering for new symbols but requires accounting for old methods', () => {
    expect(analyzer).toContain('New symbols continue to use the filter above');
    expect(analyzer).toContain('classes[].methods');
    expect(analyzer).toContain('check the complete `previousSymbols` checklist');
    expect(analyzer).toContain('explicitly report an error with its ID/name');
  });

  it.each([skill, hook])('carries typed facts through normal and retry dispatch contracts', content => {
    expect(content).toContain('`dependencyMap`');
    expect(content).toContain('`dependencyDiagnostics`');
    expect(content).toContain('`dependencyResolverVersion`');
    expect(content).toContain('`batchImportData`, `batchDependencyData`, `neighborMap`');
    expect(content).toContain('recoveredFromDependencyMap: true');
    expect(content).toContain('description');
    expect(content).toContain('resolver-version changes and missing dependency baselines are checked');
  });

  it('preserves extractor facts verbatim in scanning and keeps imports separate in analysis', () => {
    expect(scanner).toContain('`importMap`, `dependencyMap`, `methodCallMap`, `dependencyContexts`, `dependencyDiagnostics`, `dependencyResolverVersion`, and `rubyMixinResolution` MUST equal');
    expect(scanner).toContain('RUBY_DEPENDENCY_RESOLVER_VERSION');
    expect(scanner).toContain('extraction infrastructure failures');
    expect(analyzer).toContain('a typed-only fact produces no import edge');
    expect(analyzer).toContain('Keep file-level facts even when symbol nodes exist');
    expect(analyzer).toContain('`description` is required because schema validation preserves it');
  });
});
