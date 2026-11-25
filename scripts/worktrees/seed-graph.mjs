// Usage: node seed-graph.mjs <target checkout> [source graph directory]
import { spawnSync } from 'node:child_process';
import {
  constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const dataDirs = ['.understand-anything', '.ua'];
const stat = path => lstatSync(path, { throwIfNoEntry: false });
class UnusableGraph extends Error {}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function siblingGraphs(root) {
  const paths = [];
  for (const record of git(root, 'worktree', 'list', '--porcelain', '-z').split('\0\0')) {
    const [first, ...fields] = record.split('\0');
    if (!first.startsWith('worktree ') || fields.includes('bare')) continue;
    const checkout = first.slice('worktree '.length);
    if (checkout === root) continue;
    const name = dataDirs.find(name => stat(join(checkout, name)));
    if (name) paths.push(join(checkout, name));
  }
  return paths;
}

function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UnusableGraph(`invalid JSON in ${path}`);
    throw error;
  }
}

function regularFile(path, required = true) {
  const info = stat(path);
  if (!info && !required) return false;
  if (!info?.isFile()) throw new UnusableGraph(`expected a regular file at ${path}`);
  return true;
}

function candidate(root, dir, head) {
  if (!stat(dir)?.isDirectory()) throw new UnusableGraph('expected a graph directory');
  const meta = join(dir, 'meta.json');
  regularFile(meta);
  const commit = json(meta)?.gitCommitHash;
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new UnusableGraph('meta.json needs a full analyzed commit hash');
  }
  let distance = 0;
  if (commit !== head) {
    const check = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, head]);
    if (check.error) throw check.error;
    if (check.status !== 0) throw new UnusableGraph(`${commit} is not a known ancestor of HEAD`);
    distance = Number(git(root, 'rev-list', '--count', `${commit}..${head}`).trim());
  }
  return { dir, commit, distance };
}

function copyBaseline({ dir, commit }, stage) {
  const readSet = new Map();
  function observe(name) {
    const path = join(dir, name);
    readSet.set(path, stat(path));
    return path;
  }
  function copy(name, required = false) {
    const source = observe(name);
    if (!regularFile(source, required)) return false;
    copyFileSync(source, join(stage, name), constants.COPYFILE_FICLONE);
    return true;
  }

  copy('meta.json', true);
  copy('knowledge-graph.json', true);
  const graph = json(join(stage, 'knowledge-graph.json'));
  if (json(join(stage, 'meta.json'))?.gitCommitHash !== commit || graph?.project?.gitCommitHash !== commit
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new UnusableGraph('graph and metadata must describe the same analyzed commit');
  }
  if (copy('fingerprints.json')) {
    const store = json(join(stage, 'fingerprints.json'));
    // Early versions persisted the path -> fingerprint dictionary directly.
    if (!store || typeof store !== 'object' || Array.isArray(store)
        || (('gitCommitHash' in store || 'files' in store) && (store.gitCommitHash !== commit
          || !store.files || typeof store.files !== 'object' || Array.isArray(store.files)))) {
      throw new UnusableGraph('invalid or mismatched fingerprints');
    }
  }
  for (const name of ['config.json', 'code-lessons.json']) {
    if (copy(name)) json(join(stage, name));
  }
  copy('.understandignore');

  const intermediate = stat(observe('intermediate'));
  if (intermediate) {
    if (!intermediate.isDirectory()) throw new UnusableGraph('expected an intermediate directory');
    mkdirSync(join(stage, 'intermediate'));
    const scanName = 'intermediate/scan-result.json';
    const snapshotPath = observe('intermediate/incremental-baseline.json');
    const snapshot = regularFile(snapshotPath, false) ? json(snapshotPath) : null;
    // Preparation refreshes scan-result before the new graph is published.
    // During such a run only the preserved scan belongs to this base commit.
    if (snapshot?.baseCommit === commit) {
      if (Array.isArray(snapshot.scan?.files)) {
        writeFileSync(join(stage, scanName), JSON.stringify(snapshot.scan));
      }
    } else if (copy(scanName) && !Array.isArray(json(join(stage, scanName))?.files)) {
      throw new UnusableGraph('invalid scan inventory');
    }
  }
  for (const [path, before] of readSet) {
    const after = stat(path);
    if (before?.ino !== after?.ino || before?.ctimeMs !== after?.ctimeMs || before?.size !== after?.size) {
      throw new UnusableGraph('source files changed during the copy; retry after analysis finishes');
    }
  }
  // Keep branch-local analysis out of commits, including the ignore file itself.
  writeFileSync(join(stage, '.gitignore'), '*\n');
}

function existingData(root) {
  return dataDirs.find(name => stat(join(root, name)));
}

function seed(target, source) {
  const root = git(target, 'rev-parse', '--show-toplevel').replace(/\n$/, '');
  const existing = existingData(root);
  if (existing || git(root, 'ls-files', '-z', '--', ...dataDirs)) {
    console.log(`Skipping seed: ${root} already has ${existing ?? 'tracked analysis data'}.`);
    return;
  }
  const head = git(root, 'rev-parse', '--verify', 'HEAD').trim();
  const sources = source ? [realpathSync(source)] : siblingGraphs(root);
  const candidates = [];

  function reject(dir, error) {
    if (source || (!(error instanceof UnusableGraph) && error.code !== 'ENOENT')) throw error;
    console.warn(`Skipping ${dir}: ${error.message}`);
  }
  for (const dir of sources) {
    try {
      candidates.push(candidate(root, dir, head));
    } catch (error) {
      reject(dir, error);
    }
  }
  for (const match of candidates.sort((a, b) => a.distance - b.distance)) {
    const stage = mkdtempSync(join(root, '.ua-seed-'));
    try {
      copyBaseline(match, stage);
      if (git(root, 'rev-parse', 'HEAD').trim() !== head) throw new Error('HEAD changed during seed; retry');
      if (existingData(root)) {
        console.log('Skipping seed: analysis data appeared during the copy.');
        return;
      }
      renameSync(stage, join(root, '.ua'));
      const base = match.distance === 0 ? 'exact HEAD' : `${match.distance} commit(s) behind HEAD`;
      console.log(`Seeded ${root}/.ua at ${match.commit} (${base}) from ${match.dir}.`);
      return;
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code) && existingData(root)) {
        console.log('Skipping seed: analysis data already exists.');
        return;
      }
      reject(match.dir, error);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  console.log('No reusable graph found. Analyze the base checkout once, or supply a graph directory.');
}

try {
  const [target, source, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error('Usage: node seed-graph.mjs <target checkout> [source graph directory]');
  seed(target, source);
} catch (error) {
  console.error(`Graph seed failed: ${error.message}`);
  process.exitCode = 1;
}
