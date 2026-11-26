"""Method facts reconcile against canonical nodes after batch assembly."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[3] / 'understand-anything-plugin/skills/understand/merge-batch-graphs.py'
spec = importlib.util.spec_from_file_location('ruby_method_merge', path)
merge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = merge
spec.loader.exec_module(merge)


class RubyMethodMergeTests(unittest.TestCase):
    def fixture(self, graph):
        caller = {'owner': 'Api', 'name': 'helper', 'dispatch': 'instance', 'line': 2, 'endLine': 5}
        callee = {'owner': 'Service', 'name': 'run', 'dispatch': 'singleton', 'line': 8, 'endLine': 10}
        fact = {'caller': caller, 'callee': callee, 'target': 'service.rb', 'receiver': 'Service',
                'selector': 'run', 'line': 3, 'column': 5, 'outcome': 'resolved'}
        with tempfile.TemporaryDirectory() as directory:
            scan = Path(directory) / 'scan.json'
            scan.write_text(json.dumps({'methodCallMap': {'api.rb': [fact, fact, {**fact, 'line': 4}]}}))
            merge.recover_method_calls_from_scan(graph, scan)
            before = json.loads(json.dumps(graph))
            merge.recover_method_calls_from_scan(graph, scan)
            self.assertEqual(graph, before)
        return graph

    def test_recovers_missing_symbols_once_and_preserves_each_supporting_location(self):
        graph = {'nodes': [{'id': f'file:{p}', 'type': 'file', 'filePath': p} for p in ['api.rb', 'service.rb']], 'edges': []}
        self.fixture(graph)
        calls = [edge for edge in graph['edges'] if edge['type'] == 'calls']
        self.assertEqual(len(calls), 1)
        self.assertEqual([site['line'] for site in calls[0]['methodCallEvidence']], [3, 4])
        self.assertEqual(graph['methodCallSummary']['parsedSites'], 2)
        self.assertEqual(graph['methodCallSummary']['recoveredFunctionNodes'], 2)

    def test_counts_unavailable_whole_file_endpoints_instead_of_creating_dangling_edges(self):
        graph = {'nodes': [{'id': 'file:api.rb', 'type': 'file', 'filePath': 'api.rb'}], 'edges': []}
        self.fixture(graph)
        self.assertEqual(graph['methodCallSummary']['resolvedMissingEndpointSites'], 2)
        self.assertFalse(any(edge['type'] == 'calls' for edge in graph['edges']))

    def test_reuses_canonical_functions_with_different_display_spelling(self):
        graph = {'nodes': [
            {'id': f'file:{p}', 'type': 'file', 'filePath': p} for p in ['api.rb', 'service.rb']
        ] + [
            {'id': 'existing-caller', 'type': 'function', 'filePath': 'api.rb', 'name': 'Api#helper', 'lineRange': [2, 5]},
            {'id': 'existing-callee', 'type': 'function', 'filePath': 'service.rb', 'name': 'Service.run', 'lineRange': [8, 10]},
        ], 'edges': []}
        self.fixture(graph)
        calls = [edge for edge in graph['edges'] if edge['type'] == 'calls']
        self.assertEqual([(edge['source'], edge['target']) for edge in calls], [('existing-caller', 'existing-callee')])
        self.assertEqual(graph['methodCallSummary']['recoveredFunctionNodes'], 0)


if __name__ == '__main__':
    unittest.main()
