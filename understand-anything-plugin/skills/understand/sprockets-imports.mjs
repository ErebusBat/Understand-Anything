import { posix } from 'node:path';

// Match conventional first-party Rails load paths. The prefix keeps sibling
// applications and engines independent. Never walk an asset tree on disk.
function assetInfo(path) {
  if (/^(?:\/|[a-z]:)|(?:^|\/)(?:\.{1,2}|vendor|node_modules)(?:\/|$)|\\/i.test(path)) return null;
  const match = /^(.*\/)?(app|lib)\/assets\/(?:javascripts|stylesheets|templates)\/(.+)$/.exec(path);
  if (!match) return null;
  const [, scope = '', layer, name] = match;
  const suffix = /(?:\.js)?\.(?:coffee|hbs|handlebars)(?:\.erb)?$|\.js(?:\.erb)?$|(?:\.css)?\.(?:scss|sass)(?:\.erb)?$|\.css(?:\.erb)?$/.exec(name);
  if (!suffix) return null;
  const extension = suffix[0];
  const type = /\.(?:css|scss|sass)\b/.test(extension) ? 'css' : 'js';
  const template = /\.(?:hbs|handlebars)\b/.test(extension);
  const stem = name.slice(0, -extension.length);
  return {
    path, scope, stem, type, template,
    assetsRoot: scope + layer + '/assets/',
    physicalStem: path.slice(0, -extension.length),
    coffee: extension.includes('.coffee'),
  };
}

export function isSprocketsAsset(path) {
  return assetInfo(path) !== null;
}

// Sprockets reads directives only from comments before the first source token.
// A sticky expression consumes each complete comment, including block comments.
function* directives(content, coffee) {
  const comments = coffee
    ? /\s+|###[\s\S]*?###|#[^\r\n]*/y
    : /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//y;
  let end = 0;
  while (comments.exec(content)) end = comments.lastIndex;
  for (const line of content.slice(0, end).split(/\r?\n/)) {
    const match = /^\s*(?:\/\/|\/\*+|\*+|#+)?\s*=\s*(require|require_tree|require_directory|stub)\b\s*(.*?)\s*(?:\*\/)?\s*$/.exec(line);
    if (!match) continue;
    const [, kind, arg] = match;
    const literal = /^(?:"([^"\\]+)"|'([^'\\]+)'|([^'"\s\\]+))$/.exec(arg);
    const target = literal && (literal[1] ?? literal[2] ?? literal[3]);
    if (!arg && (kind === 'require_tree' || kind === 'require_directory')) yield [kind, '.'];
    else if (target && !target.startsWith('/') && !/[:*?${}\\]/.test(target)) yield [kind, target];
  }
}

// The default handlebars_assets processor registers underscored filenames as
// partials. TemplatePath uses the directory after the final templates/ and
// drops the filename from its first dot onward.
function partialRegistration(asset) {
  const prefix = '/templates/';
  const at = asset.path.lastIndexOf(prefix);
  if (at < 0) return undefined;
  const match = /^((?:[\w-]+\/)*_[\w-]+)\.[^/]*$/.exec(asset.path.slice(at + prefix.length));
  return match?.[1];
}

function handlebarsPartials(content, registrations, path) {
  // Raw blocks and inline registrations change how a literal partial tag is
  // interpreted. Only parse standalone tags in ordinary single-line mustaches.
  if (!registrations || /\{\{\{\{|\{\{~?\s*#\*\s*inline\b|\{\{~?!|<%/.test(content)) return [];
  const facts = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if ((line.match(/\{\{/g)?.length ?? 0) !== (line.match(/\}\}/g)?.length ?? 0)) return [];
    const match = /^\s*\{\{~?\s*>\s*([\w/-]+)\s*~?\}\}\s*$/.exec(line);
    const target = match && registrations.get(match[1]);
    if (target && target !== path) facts.push({type: 'depends_on', kind: 'render', reference: match[1], line: index + 1, target});
  }
  return facts;
}

export function createSprocketsResolver(files, hasHandlebars = () => false, customTemplateScopes = new Set()) {
  const sources = new Map();
  const groups = new Map();
  const handlebars = new Map();
  const partials = new Map();
  for (const { path } of files) {
    const asset = assetInfo(path);
    if (!asset || sources.has(path)) continue;
    if (asset.template) {
      if (!handlebars.has(asset.scope)) handlebars.set(asset.scope, hasHandlebars(asset.scope));
      if (!handlebars.get(asset.scope)) continue;
      const key = partialRegistration(asset);
      if (key && !customTemplateScopes.has(asset.scope)) {
        if (!partials.has(asset.scope)) partials.set(asset.scope, new Map());
        const registry = partials.get(asset.scope);
        registry.set(key, registry.has(key) ? null : path);
      }
    }
    sources.set(path, asset);
    const key = asset.scope + asset.type;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  }

  return {
    isSource(path) {
      const source = sources.get(path);
      return !!source && (!source.template || partials.has(source.scope));
    },
    templateDependencies(path, content) {
      const source = sources.get(path);
      return source?.template && !path.endsWith('.erb') ? handlebarsPartials(content, partials.get(source.scope), path) : [];
    },
    imports(path, content) {
      const source = sources.get(path);
      if (!source || source.template) return [];
      const assets = groups.get(source.scope + source.type);
      const required = new Set();
      const stubbed = new Set();
      for (const [kind, target] of directives(content, source.coffee)) {
        const relative = /^\.{1,2}(?:\/|$)/.test(target);
        const physical = posix.join(posix.dirname(path), target).replace(/\/+$/, '');
        if (relative && (!physical.startsWith(source.assetsRoot) ||
          !/^(?:javascripts|stylesheets|templates)(?:\/|$)/.test(physical.slice(source.assetsRoot.length)))) continue;
        if (kind === 'require_tree' || kind === 'require_directory') {
          if (!relative) continue;
          for (const asset of assets) {
            if (kind === 'require_tree' ? asset.path.startsWith(physical + '/') : posix.dirname(asset.path) === physical) {
              required.add(asset.path);
            }
          }
        } else {
          const name = relative ? physical : target;
          const ext = '.' + source.type;
          const stem = name.endsWith(ext) ? name.slice(0, -ext.length) : name;
          // A directory's index.js/index.css can satisfy a logical require.
          // Decline collisions between load paths or alternate source formats.
          const candidates = assets.filter(asset => {
            const candidate = relative ? asset.physicalStem : asset.stem;
            return candidate === stem || candidate === stem + '/index';
          });
          if (kind === 'stub') {
            for (const candidate of candidates) stubbed.add(candidate.path);
          } else if (candidates.length === 1) {
            required.add(candidates[0].path);
          }
        }
      }
      return [...required].filter(target => target !== path && !stubbed.has(target)).sort();
    },
  };
}
