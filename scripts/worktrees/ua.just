UA_SEED_SCRIPT := source_directory() / 'seed-graph.mjs'

[doc('Seed this checkout from a sibling graph, or from the supplied graph directory')]
[group('understand-anything')]
[no-cd]
ua-seed source_dir='':
    @node {{ quote(UA_SEED_SCRIPT) }} {{ quote(invocation_directory()) }} {{ quote(source_dir) }}
