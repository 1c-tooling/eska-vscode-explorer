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
