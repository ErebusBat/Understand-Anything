UA_SEED_SCRIPT := source_directory() / 'seed-graph.mjs'
UA_ANALYZE_SCRIPT := source_directory() / 'analyze-graph.sh'

[doc('Seed this checkout from a sibling graph, or from the supplied graph directory')]
[group('understand-anything')]
[no-cd]
ua-seed source_dir='':
    @node {{ quote(UA_SEED_SCRIPT) }} {{ quote(invocation_directory()) }} {{ quote(source_dir) }}

[doc('Seed and analyze this Git worktree with the Understand Anything skill')]
[group('understand-anything')]
[no-cd]
ua-analyze options='': ua-seed
    @sh {{ quote(UA_ANALYZE_SCRIPT) }} {{ quote(options) }}
