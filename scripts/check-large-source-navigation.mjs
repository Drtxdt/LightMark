import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp=fs.mkdtempSync(path.resolve('node_modules/.lightmark-large-navigation-'));
try {
 const load=file=>import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve(file),temp)).href);
 const windowModel=await load('src/editor/largeSourceWindow.ts');
 const eol=await load('src/editor/sourceLineEndings.ts');
 const source=fs.readFileSync('src/components/editor/LargeMarkdownEditor.vue','utf8').split('<script setup lang="ts">')[1].split('</script>')[0];
 const ast=ts.createSourceFile('large.ts',source,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='loadWindow');assert.ok(fn);
 const output=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const create=new Function('deps',`const {EditorSelection,Transaction,resetSourceLineEndings,parseSourceDocument,windowPositionOffset,windowOffsetPosition,safeLargeWindowOffset,compareLargePosition,LargeWindowCache,readLargeFileRange}=deps;
 let view={state:deps.state,dispatch(spec){this.state=this.state.update(spec).state}},largeFile={value:{sessionId:'S',revision:1}},requestGeneration=0;
 const totalLines={value:2},loading={value:false},cache=new LargeWindowCache(),windowLabel={},selectionLabel={},jumpLine={},jumpColumn={},props={paneId:'main'};
 let baseText='old',baseRaw='old',windowRange=null,logicalAnchor={line:0,column:0},logicalHead={line:0,column:0},replacingWindow=false,extending=false,compositionWait=null;
 const isPending=()=>false,submitPending=async()=>{},currentIdentity=()=>({sessionId:'S',revision:1}),assertIdentity=()=>{},normalized=s=>s.replace(/\\r\\n?|\\n/g,'\\n'),showError=e=>{throw e},largeSessionBookmarks=()=>({}),updateLargeFileViewportLine=()=>{};
 ${output}
 return {loadWindow,state:()=>({doc:view.state.doc.toString(),logicalHead,logicalAnchor,windowRange,selection:view.state.selection.main})};`);
 const end={line:1,column:6};const tail='tail😀';let calls=[];
 const nav=create({...windowModel,...eol,EditorSelection,Transaction,state:EditorState.create({doc:'old',extensions:[eol.sourceLineEndingsExtension(eol.parseSourceDocument('old').lineEndings)]}),readLargeFileRange:async request=>{calls.push(request);return request.start.line===2?{sessionId:'S',revision:1,startLine:1,startColumn:6,endLine:1,endColumn:6,totalLines:2,text:'',truncated:false}:{sessionId:'S',revision:1,startLine:1,startColumn:0,endLine:1,endColumn:6,totalLines:2,text:tail,truncated:false}}});
 await nav.loadWindow({line:2,column:0});
 assert.deepEqual(nav.state().logicalHead,end);assert.equal(nav.state().doc,tail);assert.equal(nav.state().selection.head,tail.length);assert.equal(calls.length,2);
 await nav.loadWindow({line:1,column:5});
 assert.equal(nav.state().logicalHead.column,4,'an explicitly entered half-surrogate column snaps to its leading boundary');
 console.log('Production large-window navigation passed: EOF canonical tail and valid UTF-16 carets.');
} finally {fs.rmSync(temp,{recursive:true,force:true})}
