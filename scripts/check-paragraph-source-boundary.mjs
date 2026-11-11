import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Schema} from '@tiptap/pm/model';
import {EditorState} from '@tiptap/pm/state';
import {performance} from 'node:perf_hooks';
import {compileTypeScriptModuleGraph} from './transpile-module-graph.mjs';
const temp=fs.mkdtempSync(path.resolve('node_modules/.lightmark-paragraph-boundary-'));
try {
  const {captureWysiwygSourceBaseline}=await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygCodec.ts'),temp)).href);
  const {combinePreservedSourceBlocks}=await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourcePreservation.ts'),temp)).href);
  const schema=new Schema({nodes:{doc:{content:'block+'},htmlBlock:{group:'block',atom:true},paragraph:{group:'block',content:'text*'},heading:{group:'block',content:'text*'},text:{}}});
  for(const eol of ['\n','\r\n']) {
    const source=`<!-- sentinel -->${eol}# heading${eol}${eol}last`;
    const comment=schema.nodes.paragraph.create(null,schema.text('comment')), heading=schema.nodes.heading.create(null,schema.text('heading')), last=schema.nodes.paragraph.create(null,schema.text('last'));
    const before=captureWysiwygSourceBaseline(source,schema.nodes.doc.create(null,[comment,heading,last]));
    const paragraph=schema.nodes.paragraph.create(null,schema.text('Q# heading'));
    const current=[comment,paragraph,last];
    const markdown=combinePreservedSourceBlocks(before.nodes,before.blocks,current,['comment','Q# heading','last'],before.prefix,eol);
    assert.equal(markdown,`<!-- sentinel -->${eol}${eol}Q# heading${eol}${eol}last`,'converting a heading to a paragraph must preserve the paragraph boundary with its preceding comment block');
    const recaptured=captureWysiwygSourceBaseline(markdown,schema.nodes.doc.create(null,current));
    assert.equal(recaptured.aligned,true,'snapshot/redo recapture must retain the same block count');
    assert.equal(combinePreservedSourceBlocks(current,recaptured.blocks,current,['comment','Q# heading','last'],recaptured.prefix,eol),markdown,'unchanged redo is byte-inert');
  }
  const atom=schema.nodes.htmlBlock.create(), oldHeading=schema.nodes.heading.create(null,schema.text('heading'));
  const denseComment='<!-- sentinel\r\n'+'\r\n'.repeat(200)+'trailing text -->';
  const denseBaseline=captureWysiwygSourceBaseline(denseComment+'\r\n# heading',schema.nodes.doc.create(null,[atom,oldHeading]));
  const replacement=schema.nodes.paragraph.create(null,schema.text('Q# heading'));
  const started=performance.now();
  const denseOutput=combinePreservedSourceBlocks(denseBaseline.nodes,denseBaseline.blocks,[atom,replacement],['','Q# heading'],denseBaseline.prefix,'\r\n');
  assert.equal(denseOutput,denseComment+'\r\n\r\nQ# heading');
  assert.ok(performance.now()-started<1000,'200 CRLFs before trailing comment text must not cause ambiguous-EOL regex backtracking');
  const comment=schema.nodes.htmlBlock.create(), heading=schema.nodes.heading.create(null,schema.text('heading'));
  const paragraphs=Array.from({length:50_000},(_,index)=>schema.nodes.paragraph.create(null,schema.text(`paragraph ${index}`)));
  const original=schema.nodes.doc.create(null,[comment,heading,...paragraphs]);
  const source='<!-- sentinel -->\n# heading\n\n'+paragraphs.map(node=>node.textContent).join('\n\n');
  const baseline=captureWysiwygSourceBaseline(source,original);
  let state=EditorState.create({doc:original});
  // Editing exposed heading syntax can demote the heading to a paragraph.
  state=state.apply(state.tr.setNodeMarkup(1,schema.nodes.paragraph).insertText('Q# ',2));
  for(let index=0;index<100;index++) state=state.apply(state.tr.insertText('R',state.doc.content.size-2).insertText('Q',3));
  const current=[];state.doc.forEach(node=>current.push(node));
  const output=combinePreservedSourceBlocks(baseline.nodes,baseline.blocks,current,current.map(node=>node.textContent),baseline.prefix,'\n',baseline.syntheticTailOmitted,
    (raw,before,after)=>before.eq(after)?raw:null);
  assert.ok(output.startsWith('<!-- sentinel -->\n\nQ'+'Q'.repeat(100)+'# heading'));
  const recaptured=captureWysiwygSourceBaseline(output,state.doc);
  assert.equal(recaptured.aligned,true,'100 real PM transactions editing two distant ranges retain the 50k snapshot source map');
  assert.equal(recaptured.prefix+recaptured.blocks.map(block=>block.source+block.separator).join(''),output);
  console.log('Heading→paragraph neighboring source boundary passed (LF/CRLF, comment atom paragraph, snapshot recapture and inert redo).');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
