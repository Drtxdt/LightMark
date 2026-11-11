import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { ChangeSet } from '@codemirror/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-pending-commands-'));
const load = file => import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve(file), temp)).href);
try {
  const broker = await load('src/editor/pendingDocumentCommands.ts');
  const { markAssetAttributeTransaction, pendingPmCommandMaps } = await load('src/editor/pendingPmCommandMaps.ts');
  const { captureAssetReferenceBookmark, validateAssetReferenceBookmark, projectAssetReferenceBookmark, assetBookmarkTransaction } = await load('src/editor/assetReferenceTransaction.ts');
  const { inactiveDocumentPatch, blockSpacedMarkdown } = await load('src/editor/inactiveDocumentPatch.ts');
  const identity = { documentId: 'real-document', epoch: 9 };
  const mapsFromPm = transaction => transaction.mapping.maps.map(map => {
    const ranges = []; map.forEach((from, to, newFrom, newTo) => ranges.push({ from, to, inserted: newTo - newFrom })); return ranges;
  });
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: {}, alt: { default: '' }, width: { default: null }, editing: { default: false } } },
  }, marks: { link: { attrs: { href: {} } } } });
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
    schema.nodes.image.create({ src: 'same.png' }), schema.text(' gap '), schema.nodes.image.create({ src: 'same.png' }),
  ])) });
  let markdown = '![a](same.png) gap ![b](same.png)';
  const secondRaw = markdown.lastIndexOf('same.png');
  const anchor = captureAssetReferenceBookmark(state, markdown, { from: secondRaw, to: secondRaw + 8, expected: 'same.png' });
  const handle = broker.beginPendingCommand(identity, 'asset', 'wysiwyg', 1, anchor);
  let transaction = state.tr.insertText('NEW ', 1);
  state = state.apply(transaction);
  broker.mapPendingCommands(identity.documentId, 1, mapsFromPm(transaction), mapped => validateAssetReferenceBookmark(state.doc, mapped));
  markdown = 'NEW ' + markdown;
  transaction = state.tr.insertText(' AFTER', state.doc.content.size - 1);
  state = state.apply(transaction);
  broker.mapPendingCommands(identity.documentId, 1, mapsFromPm(transaction), mapped => validateAssetReferenceBookmark(state.doc, mapped));
  markdown += ' AFTER';
  const mapped = broker.pendingCommand(handle).native.anchor;
  const linkSchema = new Schema({ nodes: { doc: { content: 'paragraph' }, paragraph: { content: 'text*' }, text: {} }, marks: { link: { attrs: { href: {} } } } });
  const href = linkSchema.marks.link.create({ href: 'same.png' });
  let linkState = EditorState.create({ doc: linkSchema.nodes.doc.create(null, linkSchema.nodes.paragraph.create(null, linkSchema.text('label', [href]))) });
  const linkAnchor = captureAssetReferenceBookmark(linkState, '[label](same.png "title")', { from: 8, to: 16, expected: 'same.png' });
  const linkCommand = broker.beginPendingCommand(identity, 'asset', 'wysiwyg', 13, linkAnchor);
  const linkTyping = linkState.tr.insertText(' MORE', linkAnchor.to);
  linkState = linkState.apply(linkTyping);
  broker.mapPendingCommands(identity.documentId, 13, mapsFromPm(linkTyping), anchor => validateAssetReferenceBookmark(linkState.doc, anchor));
  const linkMapped = broker.pendingCommand(linkCommand).native.anchor;
  const linkProjection = projectAssetReferenceBookmark(linkState, '[label MORE](same.png "title")', linkMapped);
  assert.equal(linkProjection.from, 13, 'typing at the link edge keeps its original reference as the label grows');
  const relinkedLabel = assetBookmarkTransaction(linkState, linkMapped, 'new.png');
  assert.equal(relinkedLabel.doc.firstChild.childCount, 1);
  assert.equal(relinkedLabel.doc.firstChild.firstChild.marks[0].attrs.href, 'new.png', 'the complete current link receives the URI patch, including new label text');
  const attributes = broker.beginPendingCommand(identity, 'asset', 'wysiwyg', 11, mapped);
  let attributeState = state;
  for (const attrs of [{ editing: true }, { alt: 'new alt', width: 400 }]) {
    const tr = markAssetAttributeTransaction(attributeState.tr.setNodeMarkup(mapped.from, undefined, { ...attributeState.doc.nodeAt(mapped.from).attrs, ...attrs }), mapped.from);
    attributeState = attributeState.apply(tr);
    broker.mapPendingCommands(identity.documentId, 11, pendingPmCommandMaps([tr]), anchor => validateAssetReferenceBookmark(attributeState.doc, anchor));
    assert.equal(broker.pendingCommand(attributes).native.anchor.from, mapped.from, 'explicit NodeView attributes preserve the original URI identity');
  }
  const changedUri = markAssetAttributeTransaction(attributeState.tr.setNodeMarkup(mapped.from, undefined, { ...attributeState.doc.nodeAt(mapped.from).attrs, src: 'changed.png' }), mapped.from);
  broker.mapPendingCommands(identity.documentId, 11, pendingPmCommandMaps([changedUri]), anchor => validateAssetReferenceBookmark(changedUri.doc, anchor));
  assert.throws(() => broker.pendingCommand(attributes), /修改或删除/, 'attribute origin never permits changing the bound URI');
  const replacement = broker.beginPendingCommand(identity, 'asset', 'wysiwyg', 12, mapped);
  const replaceSame = attributeState.tr.replaceWith(mapped.from, mapped.to, attributeState.doc.nodeAt(mapped.from));
  broker.mapPendingCommands(identity.documentId, 12, pendingPmCommandMaps([replaceSame]), anchor => validateAssetReferenceBookmark(replaceSame.doc, anchor));
  assert.throws(() => broker.pendingCommand(replacement), /修改或删除/, 'generic same-width identical replacement is not an attribute transaction');
  const raw = projectAssetReferenceBookmark(state, markdown, mapped);
  assert.equal(raw.from, markdown.lastIndexOf('same.png'), 'multi-edit mapping keeps the exact second duplicate reference');
  transaction = assetBookmarkTransaction(state, mapped, 'new.png');
  assert.equal(transaction.doc.firstChild.child(1).attrs.src, 'same.png');
  assert.equal(transaction.doc.firstChild.child(3).attrs.src, 'new.png');
  const command = broker.pendingCommand(handle);
  broker.projectPendingCommand(command, 1, command.sequence, { ...raw, markdown, revision: 2 });
  broker.detachPendingCommands(identity.documentId, 1);
  assert.equal(command.native, null, 'unmounted command is source data, not an editor reference');
  const output = inactiveDocumentPatch(markdown, { ...command.raw, insert: 'new.png' });
  assert.equal(output.markdown, 'NEW ![a](same.png) gap ![b](new.png) AFTER');

  const doomed = broker.beginPendingCommand(identity, 'asset', 'wysiwyg', 2, mapped);
  transaction = state.tr.delete(mapped.from, mapped.to);
  broker.mapPendingCommands(identity.documentId, 2, mapsFromPm(transaction));
  state = state.apply(transaction);
  transaction = state.tr.insert(mapped.from, schema.nodes.image.create({ src: 'same.png' }));
  broker.mapPendingCommands(identity.documentId, 2, mapsFromPm(transaction));
  assert.throws(() => broker.pendingCommand(doomed), /修改或删除/, 'a deleted reference never retargets an identical replacement');

  const image = broker.beginPendingCommand(identity, 'image', 'source', 3, { from: 5, to: 5 });
  let changes = ChangeSet.of([{ from: 0, insert: '++' }, { from: 9, insert: '!' }], 12);
  const map = []; changes.iterChangedRanges((from, to, nextFrom, nextTo) => map.push({ from, to, inserted: nextTo - nextFrom }));
  broker.mapPendingCommands(identity.documentId, 3, [map]);
  assert.equal(broker.pendingCommand(image).native.anchor.from, changes.mapPos(5, 1));
  const queued = broker.pendingCommand(image);
  queued.native = { lease: 4, model: 'source', anchor: null, queued: [] };
  broker.mapPendingCommands(identity.documentId, 4, [[{ from: 0, to: 0, inserted: 3 }], [{ from: 10, to: 10, inserted: 2 }]]);
  broker.hydratePendingCommand(queued, 4, { from: 7, to: 7 });
  assert.equal(queued.native.anchor.from, 12, 'edits during mode hydration are replayed as real coordinate maps');

  const source = '\uFEFFbefore\r\n![old](assets/old.png)\nTAIL\rEND';
  const from = source.indexOf('assets/old.png');
  const patched = inactiveDocumentPatch(source, { from, to: from + 14, expected: 'assets/old.png', insert: 'assets/new.png' });
  assert.equal(patched.markdown, source.replace('old.png', 'new.png'), 'inactive transactions preserve BOM and untouched mixed EOL bytes');
  assert.equal(blockSpacedMarkdown('before\r\nafter', 8, 8, '![x](x.png)'), '\n![x](x.png)\n\n');
  broker.clearPendingCommands(identity.documentId);
  assert.throws(() => broker.pendingCommand(image), /已关闭/);
  console.log('Pending document commands: real PM/CM maps, duplicate ownership, deletion, detach, hydration, inactive EOL and close passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
