import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync('src/stores/appStore.ts','utf8');
const ast=ts.createSourceFile('appStore.ts',source,ts.ScriptTarget.Latest,true);
const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='retryLargeFileEdits');assert.ok(node);
const code=ts.transpileModule(node.getText(ast).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const create=new Function('deps',`const {appStore,captureLargeSessionIdentity,largeOutboxFor,syncLargeOutboxProjection,largeQueueFor,currentLargeSessionIdentity,invokeLargeSource,setLargeBackendState}=deps; const LargeSessionStaleError=Error,LargeOutboxBlockedError=Error,LargeOutboxStaleError=Error,LARGE_COORDINATE_SPACE='utf16-code-units'; ${code}; return retryLargeFileEdits;`);
const edits=[{startLine:0,startColumn:0,endLine:0,endColumn:0,text:'owned'}];
const batch={id:'operation-original',sessionId:'session',expectedRevision:0,edits,failed:Error('unknown completion')};
const outbox=[batch],tab={},current={tab,sessionId:'session',revision:2};let calls=[],published=0;
const retry=create({appStore:{splitLayout:{activePaneId:'main'}},captureLargeSessionIdentity:()=>current,largeOutboxFor:()=>outbox,syncLargeOutboxProjection(){},largeQueueFor:()=>({enqueue:async(_name,captured,_get,task)=>task(captured,current)}),currentLargeSessionIdentity:()=>current,
 invokeLargeSource:async(command,args)=>{calls.push({command,args});return {operationId:args.operationId,coordinateSpace:'utf16-code-units',revision:1,savedRevision:0,pendingEditCount:1,isDirty:true}},
 setLargeBackendState(){published++;assert.equal(outbox.length,1,'pending input is removed only after a valid projection');}});
await assert.rejects(retry(edits),/回执/);
assert.equal(calls[0].args.expectedRevision,0,'unknown completion is retried at the original revision');
assert.equal(batch.expectedRevision,0);assert.equal(outbox.length,1);assert.equal(published,0);
await assert.rejects(retry([{...edits[0],text:'different'}]),/相同输入/);assert.equal(calls.length,1);
current.revision=0;
await retry(edits);
assert.equal(calls[1].args.expectedRevision,0);assert.equal(calls[1].args.operationId,'operation-original');
assert.equal(outbox.length,0);assert.equal(published,1);
console.log('Production large retry keeps the exact operation payload/revision and preserves stale input.');
