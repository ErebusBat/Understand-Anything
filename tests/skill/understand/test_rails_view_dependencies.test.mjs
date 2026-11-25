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
const partial = 'app/views/shared/_row_V2.html.haml';
it('links explicit HTML partial calls inside selected ERB, Haml and Slim templates', () => {
  const views = 'orders/app/views/';
  const erb = views + 'items/show.html.erb', haml = views + 'shared/_main.haml', slim = views + 'items/new.slim';
  const row = 'orders/' + partial;
  const facts = scan({
    'orders/config/application.rb': application, [row]: '',
    'other/config/application.rb': application, ['other/' + partial]: '', 'other/app/views/shared/_missing.html.erb': '',
    [erb]: [
      '<%%= render "shared/row_V2" %> <%# render "shared/row_V2" %> <%= "render" %>',
      '<p><%= render partial: "shared/row_V2", locals: { user: current_user } %></p>',
      '<%= render("shared/row_V2" + suffix) %> <%= current_user.render("shared/row_V2") %>',
      '<%= render partial: "shared/row_V2", formats: [:text] %> <%= render "row" %>',
      '<%= render partial: "shared/row_V2", **options %> <%= render "shared/missing" %>',
      '<%= render partial: "shared/row_V2", partial: dynamic %>',
      '<%= render template: "shared/row_V2" %> <%= render "../shared/row_V2" %>',
    ].join('\n'),
    [haml]: [
      '-# do not compile', '  = render "shared/row_V2"', ':plain', '  = render "shared/row_V2"',
      '=render "shared/row_V2",', '  first: user,', '  second: order',
      '= render partial: "shared/main"', '= render partial: "shared/row_V2", locale: :de',
    ].join('\n'),
    [slim]: ['javascript:', '  = render "shared/row_V2"', '= render partial: "shared/row_V2", collection: users'].join('\n'),
  }, [erb, haml, slim]);
  const expected = line => [{target: row, type: 'depends_on', kind: 'render', reference: 'shared/row_V2', line}];
  expect(facts).toEqual({[erb]: expected(2), [haml]: expected(5), [slim]: expected(3)});
});

it('suppresses ambiguous partial formats and templates outside Rails', () => {
  const source = 'app/views/catalog/show.html.erb';
  expect(scan({
    'config/application.rb': application, [source]: '<%= render "shared/row_V2" %>', [partial]: '',
    'app/views/shared/_row_V2.fr.html.erb': '', 'other/config/application.rb': '# plain Ruby',
    ['other/' + source]: '<%= render "shared/row_V2" %>', ['other/' + partial]: '',
  }, [source, 'other/' + source])).toEqual({[source]: [], ['other/' + source]: []});
});

it('links literal class and action layouts to full templates with Rails layout prefixes', () => {
  const base = 'app/controllers/application_controller.rb', controller = 'app/controllers/orders_controller.rb';
  const sources = {
    'config/application.rb': application,
    [base]: 'class ApplicationController < ActionController::Base; end',
    [controller]: [
      'class OrdersController < ApplicationController', 'layout "orders", only: [:show]',
      'def show', "render 'show', layout: 'shop/layouts/details'", 'render partial: "line", layout: "orders"',
      'render layout: current_layout', 'render layout: :orders', 'render layout: "orders", variants: :phone',
      'other.render layout: "orders"', 'end', 'end',
    ].join('\n'),
    'app/views/layouts/orders.html.erb': '', 'app/views/shop/layouts/details.html.haml': '',
  };
  expect(scan(sources, [controller])[controller].filter(f => f.kind === 'layout')).toEqual([
    {target: 'app/views/layouts/orders.html.erb', type: 'depends_on', kind: 'layout', reference: 'orders', line: 2},
    {target: 'app/views/shop/layouts/details.html.haml', type: 'depends_on', kind: 'layout', reference: 'shop/layouts/details', line: 4},
  ]);
});

it('skips layout candidates when a controller ancestor overrides template lookup', () => {
  const controller = 'app/controllers/orders_controller.rb';
  const facts = scan({
    'config/application.rb': application,
    'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base; prepend_view_path "themes"; end',
    [controller]: 'class OrdersController < ApplicationController; layout "orders"; end',
    'app/views/layouts/orders.html.erb': '',
  }, [controller]);
  expect(facts[controller].filter(f => f.kind === 'layout')).toEqual([]);
});
