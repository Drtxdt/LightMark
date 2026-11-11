import { DOMParser as PMParser, type Schema } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { renderMarkdownForEditor } from '../../src/utils/markdown';
import { createMarkdownPositionMap, sourcePositionToPm } from '../../src/editor/markdownPositionMap';
import { preserveChangedBlock } from '../../src/editor/fineSourcePreservation';

/** Browser-only test: uses the production schema, renderer, parser and patch validator. */
export function runFineSourceCases(schema: Schema) {
  const cases = [
    { name: 'bold edge', source: '__foo__   [link](https://example.com "keep title")', word: 'foo', end: true, mark: 'bold' },
    { name: 'inside rich paragraph', source: 'before __word__   [link](https://example.com "keep title")', word: 'word', mark: 'bold' },
    { name: 'nested list', source: '*   before\r\n    +   __word__   [link](https://example.com)', word: 'word', mark: 'bold' },
    { name: 'task item', source: '- [x] __word__   [link](https://example.com)', word: 'word', mark: 'bold' },
    { name: 'table cell', source: '| a    | __word__  |\n| :--- | ---:      |\n| c    | d         |', word: 'word', mark: 'bold' },
    { name: 'code block', source: '~~~js\r\nconst word = "**literal**";\r\n~~~', word: 'word' },
    { name: 'code block text alias complex literals', source: '~~~text\n==literal== ^sup^ ~sub~ [^not-a-reference] $x$ **bold**\n~~~', word: 'literal', canonicalLanguage: 'plaintext' },
    { name: 'long code fence complex literals', source: '````text\n==literal== ^sup^ ~sub~ [^not-a-reference] $x$ **bold**\n````', word: 'literal', canonicalLanguage: 'plaintext' },
    { name: 'code alias plus input complex literals', source: '~~~text\n==literal== ^sup^ ~sub~ [^not-a-reference] $x$ **bold**\n~~~', word: 'literal', canonicalLanguage: 'text', canonicalAfterLanguage: 'plaintext' },
    { name: 'inline code', source: 'a `` word **literal** ``   tail', word: 'word', mark: 'code' },
  ];
  const results = [];
  for (const item of cases) {
    try {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdownForEditor(item.source);
    const parsed = PMParser.fromSchema(schema).parse(container);
    let before = parsed.firstChild!;
    if (item.canonicalLanguage) before = before.type.create({ ...before.attrs, language: item.canonicalLanguage }, before.content, before.marks);
    const isolated = schema.nodes.doc.create(null, before);
    const raw = item.source.indexOf(item.word) + (item.end ? item.word.length : 2);
    const position = sourcePositionToPm(createMarkdownPositionMap(item.source, isolated), raw);
    let marks = isolated.resolve(position).marks();
    if (item.mark && !marks.some(mark => mark.type.name === item.mark)) marks = schema.marks[item.mark].create().addToSet(marks);
    const transform = new Transform(isolated).insert(position, schema.text('X', marks));
    let after = transform.doc.firstChild!;
    if (item.canonicalAfterLanguage) after = after.type.create({ ...after.attrs, language: item.canonicalAfterLanguage }, after.content, after.marks);
    const actual = preserveChangedBlock(item.source, before, after);
    const expected = item.source.slice(0, raw) + 'X' + item.source.slice(raw);
    results.push({ name: item.name, passed: actual === expected, actual, expected,
      ...(actual === expected && !item.name.includes('complex literals') ? {} : { before: before.toJSON(), after: after.toJSON() }) });
    } catch (error) { results.push({ name: item.name, passed: false, error: String(error) }); }
  }
  const parse = (source: string) => {
    const container = document.createElement('div'); container.innerHTML = renderMarkdownForEditor(source);
    return PMParser.fromSchema(schema).parse(container).firstChild!;
  };
  try {
    const source = 'before __keep__   [link](same.png "keep title")\r\n';
    const before = parse(source), doc = schema.nodes.doc.create(null, before), at = doc.content.size - 1;
    const transform = new Transform(doc).insert(at, schema.text(' bold')).addMark(at + 1, at + 5, schema.marks.bold.create());
    const expected = source.replace('\r\n', ' **bold**\r\n');
    const actual = preserveChangedBlock(source, before, transform.doc.firstChild!);
    results.push({ name: 'combined insert and bold preserves existing rich raw syntax', passed: actual === expected, actual, expected });
  } catch (error) { results.push({ name: 'combined insert and bold preserves existing rich raw syntax', passed: false, error: String(error) }); }
  for (const operation of [
    { name: 'add bold preserves link spelling', source: 'left   word   [link](https://example.com "keep title")', remove: false, expected: 'left   **word**   [link](https://example.com "keep title")' },
    { name: 'remove bold preserves link spelling', source: 'left   __word__   [link](https://example.com "keep title")', remove: true, expected: 'left   word   [link](https://example.com "keep title")' },
  ]) {
    try {
    const before = parse(operation.source), doc = schema.nodes.doc.create(null, before);
    const map = createMarkdownPositionMap(operation.source, doc), raw = operation.source.indexOf('word');
    const from = sourcePositionToPm(map, raw), to = sourcePositionToPm(map, raw + 4);
    const transform = new Transform(doc);
    if (operation.remove) transform.removeMark(from, to, schema.marks.bold); else transform.addMark(from, to, schema.marks.bold.create());
    const actual = preserveChangedBlock(operation.source, before, transform.doc.firstChild!);
    results.push({ name: operation.name, passed: actual === operation.expected, actual, expected: operation.expected });
    } catch (error) { results.push({ name: operation.name, passed: false, error: String(error) }); }
  }
  try {
    const source = '#   __word__   [link](https://example.com "keep title")';
    const before = parse(source), after = before.type.create({ ...before.attrs, level: 3 }, before.content);
    const actual = preserveChangedBlock(source, before, after), expected = source.replace('#', '###');
    results.push({ name: 'heading prefix only', passed: actual === expected, actual, expected });
  } catch (error) { results.push({ name: 'heading prefix only', passed: false, error: String(error) }); }
  try {
    const source = '- [ ] word', before = parse(source), doc = schema.nodes.doc.create(null, before);
    const from = sourcePositionToPm(createMarkdownPositionMap(source, doc), source.indexOf('word'));
    const transform = new Transform(doc).removeMark(from, from + 4, schema.marks.taskState).addMark(from, from + 4, schema.marks.taskState.create({ state: 'checked' }));
    const actual = preserveChangedBlock(source, before, transform.doc.firstChild!), expected = '- [x] word';
    results.push({ name: 'task marker only', passed: actual === expected, actual, expected });
  } catch (error) { results.push({ name: 'task marker only', passed: false, error: String(error) }); }
  try {
    const source = '*   __word__  [link](https://example.com)\n*   next', before = parse(source);
    const after = schema.nodes.orderedList.create({ start: 7 }, before.content);
    const actual = preserveChangedBlock(source, before, after), expected = source.replace(/^\*/gm, (_value, offset) => offset === 0 ? '7.' : '8.');
    results.push({ name: 'list markers only', passed: actual === expected, actual, expected });
  } catch (error) { results.push({ name: 'list markers only', passed: false, error: String(error) }); }
  try {
    const source = '| __word__  | b    |\r\n| :---      | ---: |\r\n| c         | d    |', before = parse(source), doc = schema.nodes.doc.create(null, before);
    const transform = new Transform(doc);
    doc.descendants((node, pos) => { if ((node.type.name === 'tableHeader' || node.type.name === 'tableCell') && node.attrs.textAlign === 'left') transform.setNodeMarkup(pos, undefined, { ...node.attrs, align: 'center', textAlign: 'center' }); });
    const actual = preserveChangedBlock(source, before, transform.doc.firstChild!), expected = source.replace(':---', ':---:');
    results.push({ name: 'table divider only', passed: actual === expected, actual, expected,
      ...(actual === expected ? {} : { before: before.toJSON(), after: transform.doc.firstChild!.toJSON(), candidate: parse(expected).toJSON() }) });
  } catch (error) { results.push({ name: 'table divider only', passed: false, error: String(error) }); }
  try {
    const source = '__word__   [link](https://example.com)', before = parse(source), doc = schema.nodes.doc.create(null, before);
    const from = sourcePositionToPm(createMarkdownPositionMap(source, doc), source.indexOf('word'));
    const after = new Transform(doc).removeMark(from + 1, from + 3, schema.marks.bold).doc.firstChild!;
    // Intraword underscores cannot delimit strong emphasis in CommonMark.
    const actual = preserveChangedBlock(source, before, after), expected = '**w**or**d**   [link](https://example.com)';
    results.push({ name: 'partial mark uses valid boundary delimiters', passed: actual === expected, actual, expected });
  } catch (error) { results.push({ name: 'partial mark uses valid boundary delimiters', passed: false, error: String(error) }); }
  return results;
}
