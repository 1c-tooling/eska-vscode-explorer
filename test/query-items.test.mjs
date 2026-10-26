import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectItems} from '../resources/query/items.mjs';
/** Filtered rows use visible UI order; selection never invents a hidden core index. */
test('item selection supports replace toggle range and filtered select all',()=>{
 const indices=[0,2,4,7];
 assert.deepEqual(selectItems([0],4,0,false,false,indices),[4]);
 assert.deepEqual(selectItems([0],4,0,false,true,indices),[0,4]);
 assert.deepEqual(selectItems([0,4],0,4,false,true,indices),[4]);
 assert.deepEqual(selectItems([0],7,2,true,false,indices),[2,4,7]);
 assert.deepEqual(selectItems([0],2,99,true,false,indices),[2]);
});

/** Native text controls expose UTF-16 offsets, including surrogate pairs and a selected replacement. */
test('expression insertion uses the cursor and not a reconstructed SQL expression',async()=>{
 const {insertAtSelection}=await import('../resources/query/expression.mjs');
 let event,focused=false;
 const control={value:'😀 + old',selectionStart:5,selectionEnd:8,setRangeText(value,start,end){this.value=this.value.slice(0,start)+value+this.value.slice(end);this.selectionStart=this.selectionEnd=start+value.length;},dispatchEvent(value){event=value;},focus(){focused=true;}};
 insertAtSelection(control,'T.Name');assert.equal(control.value,'😀 + T.Name');assert.equal(control.selectionStart,11);assert.equal(event.type,'input');assert.equal(focused,true);
});
