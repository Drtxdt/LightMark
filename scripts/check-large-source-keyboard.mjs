import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {keymap,runScopeHandlers} from '@codemirror/view';
let action;
const view={state:EditorState.create({extensions:[keymap.of([{key:'Mod-z',run:()=>{action='undo';return true}},{key:'Mod-Shift-z',run:()=>{action='redo';return true}}])]})};
for(const [key,shiftKey,keyCode,expected] of [['z',false,90,'undo'],['Z',true,90,'redo']]){
 action=null;
 assert.ok(runScopeHandlers(view,{key,shiftKey,keyCode,ctrlKey:true,preventDefault(){},stopPropagation(){}},'editor'));
 assert.equal(action,expected);
}
console.log('Real CodeMirror Windows undo/redo KeyboardEvent normalization passed.');
