"""Static test intent stays distinct from execution coverage."""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from tests.skill.understand.test_merge_batch_graphs import mbg, _file_node


class StaticTestEvidenceTests(unittest.TestCase):
    def test_filename_and_explicit_subject_share_one_canonical_edge(self):
        production = 'app/models/account.rb'
        spec = 'spec/models/account_spec.rb'
        graph, _ = mbg.merge_and_normalize([{'nodes': [_file_node(production), _file_node(spec)], 'edges': []}])
        scan = {'dependencyMap': {spec: [
            {'target': production, 'type': 'depends_on', 'kind': 'rspec_subject', 'reference': 'Account', 'line': 3},
            {'target': production, 'type': 'depends_on', 'kind': 'rspec_subject', 'reference': 'Account', 'line': 3},
        ]}}
        with TemporaryDirectory() as root:
            path = Path(root) / 'scan-result.json'
            path.write_text(json.dumps(scan))
            recovered, _ = mbg.recover_dependencies_from_scan(graph, path)
            self.assertEqual(recovered, 0)  # annotates the filename edge
            first = json.dumps(graph, sort_keys=True)
            mbg.recover_dependencies_from_scan(graph, path)
            self.assertEqual(first, json.dumps(graph, sort_keys=True))
        self.assertEqual(len(graph['edges']), 1)
        edge = graph['edges'][0]
        self.assertEqual((edge['source'], edge['target'], edge['type']), ('file:' + production, 'file:' + spec, 'tested_by'))
        self.assertEqual(edge['dependencyEvidence'], [
            {'kind': 'rspec_subject', 'reference': 'Account', 'line': 3, 'path': spec},
            {'kind': 'test_path_convention'},
        ])
        self.assertIn('runtime coverage unknown', edge['description'])
        self.assertIn('tested', graph['nodes'][0]['tags'])

    def test_subject_without_filename_match_is_production_to_test(self):
        production, spec = 'app/services/accounts.rb', 'spec/requests/signup_spec.rb'
        graph, _ = mbg.merge_and_normalize([{'nodes': [_file_node(production), _file_node(spec)], 'edges': []}])
        with TemporaryDirectory() as root:
            path = Path(root) / 'scan-result.json'
            path.write_text(json.dumps({'dependencyMap': {spec: [
                {'target': production, 'type': 'depends_on', 'kind': 'rspec_subject', 'reference': 'Accounts', 'line': 1},
            ]}}))
            mbg.recover_dependencies_from_scan(graph, path)
        self.assertEqual(graph['edges'][0]['source'], 'file:' + production)
        self.assertEqual(graph['edges'][0]['target'], 'file:' + spec)
        self.assertEqual(graph['edges'][0]['dependencyEvidence'][0]['path'], spec)

    def test_shipped_merge_reports_static_evidence_without_claiming_runtime_coverage(self):
        production, spec = 'app/models/account.rb', 'spec/models/account_spec.rb'
        with TemporaryDirectory() as root:
            intermediate = Path(root) / '.ua' / 'intermediate'
            intermediate.mkdir(parents=True)
            (intermediate / 'batch-0.json').write_text(json.dumps({'nodes': [_file_node(production), _file_node(spec)], 'edges': []}))
            (intermediate / 'scan-result.json').write_text(json.dumps({'dependencyMap': {spec: [
                {'target': production, 'type': 'depends_on', 'kind': 'rspec_subject', 'reference': 'Account', 'line': 3},
            ]}}))
            result = subprocess.run([sys.executable, mbg.__file__, root], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Static test associations', result.stderr)
            self.assertIn('rspec_subject', result.stderr)
            self.assertIn('test_path_convention', result.stderr)
            self.assertIn('Runtime coverage: unknown', result.stderr)
            coverage = json.loads((intermediate / 'scan-coverage.json').read_text())
            self.assertEqual(coverage['structuralExtraction']['status'], 'unknown')

    def test_weight_dedup_preserves_independent_evidence(self):
        production, spec = 'app/models/account.rb', 'spec/models/account_spec.rb'
        graph, _ = mbg.merge_and_normalize([{'nodes': [_file_node(production), _file_node(spec)], 'edges': [
            {'source': 'file:' + production, 'target': 'file:' + spec, 'type': 'tested_by', 'weight': .2,
             'dependencyEvidence': [{'kind': 'rspec_subject', 'path': spec, 'line': 2}]},
            {'source': 'file:' + spec, 'target': 'file:' + production, 'type': 'tested_by', 'weight': .8},
        ]}])
        edge = graph['edges'][0]
        self.assertEqual(edge['weight'], .8)
        self.assertEqual({item['kind'] for item in edge['dependencyEvidence']}, {'rspec_subject', 'analyzer_test_association', 'test_path_convention'})


class ScanCoverageTests(unittest.TestCase):
    def test_parser_skips_can_still_have_dependencies_and_assets_can_be_isolated(self):
        view, mailer, asset = 'app/views/accounts_mailer/welcome.html.erb', 'app/mailers/accounts_mailer.rb', 'public/logo.png'
        scan = {'files': [{'path': view, 'language': 'html'}, {'path': mailer, 'language': 'ruby'}, {'path': asset, 'language': 'unknown'}],
                'dependencyMap': {mailer: [{'target': view, 'kind': 'mailer_template'}]}}
        graph = {'nodes': [_file_node(path) for path in [view, mailer, asset]],
                 'edges': [{'source': 'file:' + mailer, 'target': 'file:' + view, 'dependencyEvidence': [{'kind': 'mailer_template'}]}]}
        extraction = {'filesSkipped': [view, asset, 'missing.rb'], 'filesUnreadable': [{'path': 'missing.rb'}], 'results': [{'path': mailer}]}
        coverage = mbg.scan_coverage(graph, scan, [extraction])
        self.assertEqual(coverage['structuralExtraction']['parserSkippedByLanguage'], {'html': 1, 'unknown': 1})
        self.assertEqual(coverage['structuralExtraction']['filesUnreadable'], 1)
        self.assertEqual(coverage['structuralExtraction']['parserSkippedWithGraphRelationships'], 1)
        self.assertEqual(coverage['isolatedNodes'], {'total': 1, 'byRole': {'asset': 1}})
        self.assertEqual(coverage['dependencyExtraction']['graphEdgesByEvidenceKind'], {'mailer_template': 1})
        self.assertIn('runtime coverage unknown', coverage['testEvidence']['meaning'])

    def test_absent_structural_artifacts_mean_unknown(self):
        coverage = mbg.scan_coverage({'nodes': [], 'edges': []}, {}, [])
        self.assertEqual(coverage['structuralExtraction']['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
