/** Bounded English inflections. Loader basename overrides are intentionally
 * separate from ActiveSupport name camelization used by associations. */
export class RubyInflections {
  readonly acronyms = new Map<string, string>();
  readonly overrides = new Map<string, string>();
  readonly irregular = new Map<string, string>([
    ["person", "people"], ["man", "men"], ["woman", "women"],
    ["child", "children"], ["mouse", "mice"], ["goose", "geese"],
  ]);
  private readonly customIrregular: [string, string][] = [];
  readonly uncountable = new Set([
    "equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police", "news",
  ]);
  supported = true;

  /** ActiveSupport prepends rules: the latest rule wins even if its plural
   * overlaps another singular's rule. Retain older distinct patterns too. */
  addIrregular(singular: string, plural: string): void {
    this.uncountable.delete(singular);
    this.uncountable.delete(plural);
    this.customIrregular.unshift([singular, plural]);
  }

  camelize(value: string, loader = false): string | null {
    if (!this.supported || !/^[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*(?:(?:\/|::)[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*)*$/.test(value)) return null;
    return value.split(/\/|::/).map(part => {
      if (loader && this.overrides.has(part)) return this.overrides.get(part)!;
      return part.split("_").map(word => this.acronyms.get(word.toLowerCase()) ?? word[0].toUpperCase() + word.slice(1)).join("");
    }).join("::");
  }

  singularize(value: string): string | null {
    return this.inflectLast(value, false);
  }

  pluralize(value: string): string | null {
    return this.inflectLast(value, true);
  }

  private inflectLast(value: string, plural: boolean): string | null {
    if (!this.supported || !/^[a-z][a-z\d]*(?:[_/][a-z\d]+)*$/.test(value)) return null;
    const match = value.match(/^(.*[_/])?([^_/]+)$/);
    if (!match) return null;
    const prefix = match[1] ?? "";
    const word = match[2];
    if (this.uncountable.has(word)) return value;
    for (const [one, many] of [...this.customIrregular, ...this.irregular]) {
      if (word === one || word === many) return prefix + (plural ? many : one);
    }
    // Explicit common families avoid the incorrect general "strip s" rule.
    const families: [string, string][] = [
      ["analysis", "analyses"], ["basis", "bases"], ["diagnosis", "diagnoses"],
      ["status", "statuses"], ["alias", "aliases"], ["bus", "buses"], ["menu", "menus"],
      ["index", "indices"], ["matrix", "matrices"], ["vertex", "vertices"],
      ["quiz", "quizzes"], ["wife", "wives"], ["life", "lives"], ["leaf", "leaves"],
    ];
    for (const [one, many] of families) if (word === one || word === many) return prefix + (plural ? many : one);
    if (plural) {
      if (/[^aeiou]y$/.test(word)) return prefix + word.slice(0, -1) + "ies";
      if (/(?:x|ch|ss|sh)$/.test(word)) return prefix + word + "es";
      // Unknown -s/-us/-is nouns are ambiguous, not necessarily plural.
      if (/(?:s|f|fe|o)$/.test(word)) return null;
      return prefix + word + "s";
    }
    if (/[^aeiou]ies$/.test(word)) return prefix + word.slice(0, -3) + "y";
    if (/(?:xes|ches|sses|shes)$/.test(word)) return prefix + word.slice(0, -2);
    if (/(?:ss|us|is|ves|oes)$/.test(word)) return null;
    return prefix + (word.endsWith("s") ? word.slice(0, -1) : word);
  }
}
