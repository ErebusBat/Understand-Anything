import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extractor = fileURLToPath(new URL('../../../understand-anything-plugin/skills/understand/extract-import-map.mjs', import.meta.url));
let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function scan(sources, analysisPaths) {
  root = mkdtempSync(join(tmpdir(), 'ua-template-'));
  const files = Object.entries(sources).map(([path, content]) => {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), content);
    const ruby = path.endsWith('.rb');
    return {path, language: ruby ? 'ruby' : path.split('.').at(-1), fileCategory: ruby ? 'code' : 'markup'};
  });
  const input = join(root, 'input.json'), output = join(root, 'output.json');
  writeFileSync(input, JSON.stringify({projectRoot: root, files, analysisPaths}));
  execFileSync(process.execPath, [extractor, input, output], {stdio: 'pipe'});
  const result = JSON.parse(readFileSync(output, 'utf8'));
  expect(result.failures).toEqual([]);
  return result.dependencyMap;
}

const application = 'class Demo < Rails::Application; end';
const partial = 'app/views/shared/_row.html.haml';
it('links explicit HTML partial calls inside selected ERB, Haml and Slim templates', () => {
  const views = 'orders/app/views/';
  const erb = views + 'items/show.html.erb', haml = views + 'shared/_main.haml', slim = views + 'items/new.slim';
  const row = 'orders/' + partial;
  const facts = scan({
    'orders/config/application.rb': application, [row]: '',
    'other/config/application.rb': application, ['other/' + partial]: '', 'other/app/views/shared/_missing.html.erb': '',
    [erb]: [
      '<%%= render "shared/row" %> <%# render "shared/row" %> <%= "render" %>',
      '<p><%= render partial: "shared/row", locals: { user: current_user } %></p>',
      '<%= render("shared/row" + suffix) %> <%= current_user.render("shared/row") %>',
      '<%= render partial: "shared/row", formats: [:text] %> <%= render "row" %>',
      '<%= render partial: "shared/row", **options %> <%= render "shared/missing" %>',
      '<%= render partial: "shared/row", partial: dynamic %>',
      '<%= render template: "shared/row" %> <%= render "../shared/row" %>',
    ].join('\n'),
    [haml]: [
      '-# do not compile', '  = render "shared/row"', ':plain', '  = render "shared/row"',
      '=render "shared/row",', '  first: user,', '  second: order',
      '= render partial: "shared/main"', '= render partial: "shared/row", locale: :de',
    ].join('\n'),
    [slim]: ['javascript:', '  = render "shared/row"', '= render partial: "shared/row", collection: users'].join('\n'),
  }, [erb, haml, slim]);
  const expected = line => [{target: row, type: 'depends_on', kind: 'render', reference: 'shared/row', line}];
  expect(facts).toEqual({[erb]: expected(2), [haml]: expected(5), [slim]: expected(3)});
});

it('suppresses ambiguous partial formats and templates outside Rails', () => {
  const source = 'app/views/catalog/show.html.erb';
  expect(scan({
    'config/application.rb': application, [source]: '<%= render "shared/row" %>', [partial]: '',
    'app/views/shared/_row.fr.html.erb': '', 'other/config/application.rb': '# plain Ruby',
    ['other/' + source]: '<%= render "shared/row" %>', ['other/' + partial]: '',
  }, [source, 'other/' + source])).toEqual({[source]: [], ['other/' + source]: []});
});
