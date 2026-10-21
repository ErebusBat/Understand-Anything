import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GraphEdgeSchema } from "../../packages/core/src/schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MERGE_SCRIPT = resolve(__dirname, "../../skills/understand/merge-batch-graphs.py");
const PYTHON = findPython();

let projectRoot;
let intermediateDir;

function findPython() {
  const candidates = [
    { command: "python3", args: [] },
    { command: "python", args: [] },
    { command: "py", args: ["-3"] },
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf-8",
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python 3 is required to run merge-batch-graphs.py tests");
}

function runMerge() {
  const result = spawnSync(PYTHON.command, [...PYTHON.args, MERGE_SCRIPT, projectRoot], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`merge script failed: status=${result.status}\nstderr:\n${result.stderr}`);
  }
  const assembled = JSON.parse(
    readFileSync(join(intermediateDir, "assembled-graph.json"), "utf-8"),
  );
  return { assembled, stderr: result.stderr };
}

function fileNode(path) {
  return {
    id: `file:${path}`,
    type: "file",
    name: path.split("/").pop(),
    filePath: path,
    summary: "",
    tags: [],
    complexity: "simple",
  };
}

function wholeFileNode(type, path) {
  return {
    ...fileNode(path),
    id: `${type}:${path}`,
    type,
  };
}

function importsEdge(src, tgt) {
  return {
    source: `file:${src}`,
    target: `file:${tgt}`,
    type: "imports",
    direction: "forward",
    weight: 0.7,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "ua-merge-test-"));
  intermediateDir = join(projectRoot, ".understand-anything", "intermediate");
  mkdirSync(intermediateDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("merge-batch-graphs.py imports recovery", () => {
  it("recovers imports edges that batches dropped despite importMap having them", () => {
    // Batch contains all the file nodes but only emits ONE of three imports edges.
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/a.py"), fileNode("src/b.py"), fileNode("src/c.py"), fileNode("src/d.py")],
        edges: [importsEdge("src/a.py", "src/b.py")],
      }),
    );
    // scan-result.json has the full importMap — agent dropped 2/3 of these.
    writeFileSync(
      join(intermediateDir, "scan-result.json"),
      JSON.stringify({
        importMap: {
          "src/a.py": ["src/b.py", "src/c.py", "src/d.py"],
          "src/b.py": [],
        },
      }),
    );

    const { assembled, stderr } = runMerge();
    const importsEdges = assembled.edges.filter((e) => e.type === "imports");
    expect(importsEdges).toHaveLength(3);
    const targets = new Set(importsEdges.map((e) => e.target));
    expect(targets).toEqual(new Set(["file:src/b.py", "file:src/c.py", "file:src/d.py"]));
    // Recovered edges are tagged so downstream consumers can audit.
    const recovered = importsEdges.filter((e) => e.recoveredFromImportMap);
    expect(recovered).toHaveLength(2);
    expect(stderr).toContain("Recovered 2 `imports` edges");
  });

  it("does not duplicate edges the batch already emitted", () => {
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/a.py"), fileNode("src/b.py")],
        edges: [importsEdge("src/a.py", "src/b.py")],
      }),
    );
    writeFileSync(
      join(intermediateDir, "scan-result.json"),
      JSON.stringify({
        importMap: { "src/a.py": ["src/b.py"], "src/b.py": [] },
      }),
    );

    const { assembled, stderr } = runMerge();
    const importsEdges = assembled.edges.filter((e) => e.type === "imports");
    expect(importsEdges).toHaveLength(1);
    expect(stderr).toContain("Recovered 0 `imports` edges");
  });

  it("skips importMap entries whose source file is missing from the graph", () => {
    // src/missing.py is in importMap but has no file: node — must not produce a dangling edge.
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/b.py")],
        edges: [],
      }),
    );
    writeFileSync(
      join(intermediateDir, "scan-result.json"),
      JSON.stringify({
        importMap: { "src/missing.py": ["src/b.py"] },
      }),
    );

    const { assembled, stderr } = runMerge();
    expect(assembled.edges.filter((e) => e.type === "imports")).toHaveLength(0);
    expect(stderr).toContain("Skipped 1 importMap source files with no whole-file node");
  });

  it("skips importMap targets that don't have a file: node", () => {
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/a.py")],
        edges: [],
      }),
    );
    writeFileSync(
      join(intermediateDir, "scan-result.json"),
      JSON.stringify({
        importMap: { "src/a.py": ["src/dropped.py", "src/also-missing.py"] },
      }),
    );

    const { assembled, stderr } = runMerge();
    expect(assembled.edges.filter((e) => e.type === "imports")).toHaveLength(0);
    expect(stderr).toContain("Skipped 2 importMap target paths with no whole-file node");
  });

  it("works when scan-result.json is missing (incremental update path)", () => {
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/a.py"), fileNode("src/b.py")],
        edges: [importsEdge("src/a.py", "src/b.py")],
      }),
    );
    // No scan-result.json written.

    const { assembled, stderr } = runMerge();
    expect(assembled.edges.filter((e) => e.type === "imports")).toHaveLength(1);
    expect(stderr).toContain("importMap recovery skipped");
    expect(stderr).toContain("scan-result.json not found");
  });

  it("never produces self-import edges", () => {
    writeFileSync(
      join(intermediateDir, "batch-0.json"),
      JSON.stringify({
        nodes: [fileNode("src/a.py")],
        edges: [],
      }),
    );
    writeFileSync(
      join(intermediateDir, "scan-result.json"),
      JSON.stringify({
        importMap: { "src/a.py": ["src/a.py"] }, // pathological self-reference
      }),
    );

    const { assembled } = runMerge();
    expect(assembled.edges.filter((e) => e.type === "imports")).toHaveLength(0);
  });

  it.each([
    ['file', 'config'],
    ['file', 'schema'],
    ['config', 'file'],
  ])('recovers %s to %s imports through whole-file nodes', (sourceType, targetType) => {
    writeFileSync(
      join(intermediateDir, 'batch-0.json'),
      JSON.stringify({
        nodes: [
          wholeFileNode(sourceType, 'src/source.ts'),
          wholeFileNode(targetType, 'config/target.json'),
        ],
        edges: [],
      }),
    );
    writeFileSync(
      join(intermediateDir, 'scan-result.json'),
      JSON.stringify({
        importMap: { 'src/source.ts': ['config/target.json'] },
      }),
    );

    const { assembled } = runMerge();
    expect(assembled.edges.filter((edge) => edge.type === 'imports')).toEqual([
      expect.objectContaining({
        source: `${sourceType}:src/source.ts`,
        target: `${targetType}:config/target.json`,
      }),
    ]);
  });

  it('prefers file nodes over other whole-file nodes for the same path', () => {
    writeFileSync(
      join(intermediateDir, 'batch-0.json'),
      JSON.stringify({
        nodes: [
          wholeFileNode('config', 'src/source.ts'),
          wholeFileNode('file', 'src/source.ts'),
          wholeFileNode('schema', 'src/target.ts'),
          wholeFileNode('file', 'src/target.ts'),
        ],
        edges: [],
      }),
    );
    writeFileSync(
      join(intermediateDir, 'scan-result.json'),
      JSON.stringify({ importMap: { 'src/source.ts': ['src/target.ts'] } }),
    );

    const { assembled, stderr } = runMerge();
    expect(assembled.edges.filter((edge) => edge.type === 'imports')).toEqual([
      expect.objectContaining({
        source: 'file:src/source.ts',
        target: 'file:src/target.ts',
      }),
    ]);
    expect(stderr).toContain('multiple whole-file nodes for src/source.ts');
    expect(stderr).toContain('selected file:src/source.ts');
  });

  it('does not use child constructs as whole-file import endpoints', () => {
    const table = {
      ...wholeFileNode('schema', 'db/schema.sql'),
      id: 'table:db/schema.sql:users',
      type: 'table',
    };
    writeFileSync(
      join(intermediateDir, 'batch-0.json'),
      JSON.stringify({ nodes: [fileNode('src/source.ts'), table], edges: [] }),
    );
    writeFileSync(
      join(intermediateDir, 'scan-result.json'),
      JSON.stringify({ importMap: { 'src/source.ts': ['db/schema.sql'] } }),
    );

    const { assembled, stderr } = runMerge();
    expect(assembled.edges.filter((edge) => edge.type === 'imports')).toHaveLength(0);
    expect(stderr).toContain('no whole-file node in graph');
  });
});

describe('merge-batch-graphs.py typed dependency recovery', () => {
  const source = 'app/models/user.rb';
  const target = 'app/models/account.rb';
  function seed(dependencyMap, nodes = [fileNode(source), fileNode(target)], edges = [], importMap = {}) {
    writeFileSync(join(intermediateDir, 'batch-0.json'), JSON.stringify({ nodes, edges }));
    writeFileSync(join(intermediateDir, 'scan-result.json'), JSON.stringify({ importMap, dependencyMap }));
  }

  it('recovers supplied types without inventing imports and preserves schema-safe evidence', () => {
    seed({ [source]: [
      { target, type: 'depends_on', kind: 'association', reference: 'Account', line: 8 },
      { target, type: 'inherits', kind: 'superclass', reference: 'Account', line: 1 },
    ] });
    const { assembled } = runMerge();
    expect(assembled.edges.map(edge => edge.type).sort()).toEqual(['depends_on', 'inherits']);
    for (const edge of assembled.edges) {
      expect(edge).toMatchObject({ source: `file:${source}`, target: `file:${target}`, direction: 'forward', recoveredFromDependencyMap: true });
      const validated = GraphEdgeSchema.parse(edge);
      expect(validated.description).toContain('Account');
      expect(validated.description).toContain('line');
      expect(validated).not.toHaveProperty('recoveredFromDependencyMap');
    }
  });

  it('deduplicates facts and stamps existing matching batch edges for pruning', () => {
    const facts = [
      { target, type: 'depends_on', kind: 'constant', reference: 'Account', line: 12 },
      { target, type: 'depends_on', kind: 'association', reference: 'Account', line: 8 },
    ];
    seed({ [source]: [facts[0], facts[1], facts[0]] }, undefined, [
      { ...importsEdge(source, target), type: 'depends_on', weight: 0.8, description: 'Uses account.' },
    ], { [source]: [target] });
    const { assembled, stderr } = runMerge();
    expect(stderr).toContain('Recovered 0 typed edges');
    expect(assembled.edges).toHaveLength(2);
    expect(assembled.edges.filter(edge => edge.type === 'imports')).toHaveLength(1);
    const edge = assembled.edges.find(edge => edge.type === 'depends_on');
    expect(edge.recoveredFromDependencyMap).toBe(true);
    expect(edge.weight).toBe(0.8);
    expect(edge.dependencyEvidence).toEqual([
      { kind: 'association', reference: 'Account', line: 8 },
      { kind: 'constant', reference: 'Account', line: 12 },
    ]);
    expect(edge.description).toBe('Uses account.\nResolved dependency facts: association Account (line 8); constant Account (line 12).');
    // Running recovery over its own output neither duplicates evidence nor edges.
    writeFileSync(join(intermediateDir, 'batch-0.json'), JSON.stringify(assembled));
    expect(runMerge().assembled).toEqual(assembled);
  });

  it('is stable under shuffled map and fact ordering', () => {
    const facts = [
      { target, type: 'depends_on', kind: 'extend', reference: 'Account', line: 10 },
      { target, type: 'depends_on', kind: 'include', reference: 'Account', line: 2 },
      { target, type: 'inherits', kind: 'superclass', line: 1 },
    ];
    const reverse = { target: source, type: 'depends_on', kind: 'constant' };
    seed({ [target]: [reverse], [source]: facts });
    const first = runMerge().assembled;
    seed({ [source]: facts.slice().reverse(), [target]: [reverse] });
    expect(runMerge().assembled).toEqual(first);
  });

  it('skips missing source/target endpoints, child constructs, self edges, and invalid types', () => {
    seed({
      'app/models/missing.rb': [{ target, type: 'depends_on', kind: 'constant' }],
      [source]: [
        { target: 'app/models/missing.rb', type: 'depends_on', kind: 'constant' },
        { target, type: 'depends_on', kind: 'constant' },
        { target: source, type: 'inherits', kind: 'superclass' },
        { target: source, type: 'imports', kind: 'constant' },
      ],
    }, [fileNode(source), { ...fileNode(target), id: `class:${target}:Account`, type: 'class' }]);
    const { assembled, stderr } = runMerge();
    expect(assembled.edges).toEqual([]);
    expect(stderr).toContain('Skipped 1 dependencyMap source files');
    expect(stderr).toContain('Skipped 2 dependencyMap target facts');
  });

  it('uses whole-file config endpoints for typed routes', () => {
    const routes = 'config/routes.rb';
    seed({ [routes]: [{ target, type: 'routes', kind: 'route', reference: 'accounts#index', line: 2 }] },
      [wholeFileNode('config', routes), fileNode(target)]);
    const { assembled } = runMerge();
    expect(assembled.edges).toEqual([expect.objectContaining({
      source: `config:${routes}`, target: `file:${target}`, type: 'routes',
      description: 'Resolved dependency facts: route accounts#index (line 2).',
    })]);
  });

  it('accepts empty maps and empty fact arrays', () => {
    for (const dependencyMap of [{}, { [source]: [], [target]: [] }]) {
      seed(dependencyMap);
      expect(runMerge().assembled.edges).toEqual([]);
    }
  });
});

describe("merge-batch-graphs.py data-dir resolution (.ua vs legacy)", () => {
  // Self-contained: uses its own temp roots rather than the module-global
  // .understand-anything projectRoot wired up in the top-level beforeEach.
  function runIn(root) {
    const result = spawnSync(PYTHON.command, [...PYTHON.args, MERGE_SCRIPT, root], {
      encoding: "utf-8",
    });
    return result;
  }

  it("fresh project reads/writes under .ua/", () => {
    const root = mkdtempSync(join(tmpdir(), "ua-merge-uadir-"));
    try {
      const inter = join(root, ".ua", "intermediate");
      mkdirSync(inter, { recursive: true });
      writeFileSync(
        join(inter, "batch-0.json"),
        JSON.stringify({ nodes: [fileNode("src/a.py")], edges: [] }),
      );
      const result = runIn(root);
      expect(result.status).toBe(0);
      // Output landed in .ua/, legacy dir never created.
      const out = JSON.parse(
        readFileSync(join(inter, "assembled-graph.json"), "utf-8"),
      );
      expect(out.nodes.map((n) => n.id)).toContain("file:src/a.py");
      expect(existsSync(join(root, ".understand-anything"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("legacy .understand-anything/ wins even when .ua/ also exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ua-merge-legacy-"));
    try {
      const legacyInter = join(root, ".understand-anything", "intermediate");
      mkdirSync(legacyInter, { recursive: true });
      mkdirSync(join(root, ".ua", "intermediate"), { recursive: true });
      writeFileSync(
        join(legacyInter, "batch-0.json"),
        JSON.stringify({ nodes: [fileNode("src/a.py")], edges: [] }),
      );
      const result = runIn(root);
      expect(result.status).toBe(0);
      expect(existsSync(join(legacyInter, "assembled-graph.json"))).toBe(true);
      expect(existsSync(join(root, ".ua", "intermediate", "assembled-graph.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
