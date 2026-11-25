import { expect, it } from "vitest";
import { PluginRegistry } from "../registry.js";
import { registerAllParsers } from "./index.js";

const registry = new PluginRegistry();
registerAllParsers(registry);

it("extracts CoffeeScript classes, methods and assigned functions on their original lines", () => {
  const source = [
    'App.module "Views",',
    '  Entry: class extends Base',
    '    title: "Store"',
    '    @open: (@id, options={}, extra...) ->',
    '      @id',
    '    instance: -> true',
    '',
    'App.ready = (cb) => cb()',
    'class App.Widget',
    '  save: -> true',
    'App.Widget::check = -> true',
    'App[dynamic] = -> false',
  ].join("\r\n");
  const analysis = registry.analyzeFile("app/assets/javascripts/view.js.coffee", source);
  expect(analysis?.classes).toEqual([
    { name: "Entry", lineRange: [2, 6], methods: ["@open", "instance"], properties: ["title"] },
    { name: "App.Widget", lineRange: [9, 10], methods: ["save"], properties: [] },
  ]);
  expect(analysis?.functions).toEqual([
    { name: "@open", lineRange: [4, 5], params: ["@id", "options={}", "extra..."], owner: "Entry" },
    { name: "instance", lineRange: [6, 6], params: [], owner: "Entry" },
    { name: "App.ready", lineRange: [8, 8], params: ["cb"], owner: "" },
    { name: "save", lineRange: [10, 10], params: [], owner: "App.Widget" },
    { name: "App.Widget::check", lineRange: [11, 11], params: [], owner: "" },
  ]);
});

it("declines syntax outside CoffeeScript 1.x and accepts an empty program", () => {
  expect(registry.analyzeFile("modern.coffee", "items = [...others]")).toBeNull();
  expect(registry.analyzeFile("bad.coffee", "class Broken(")).toBeNull();
  expect(registry.analyzeFile("empty.coffee", "# comment")).toEqual({
    functions: [], classes: [], imports: [], exports: [],
  });
});
