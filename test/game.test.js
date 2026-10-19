import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDeck, freshState, drawInitiative, rollExpression, commandResponse} from '../src/game.js';
test('mazzo: 54 carte con due jolly distinti',()=>assert.equal(new Set(fullDeck().map(c=>c.id)).size,54));
test('dado esplosivo e critico',()=>{
 const seq=[0,0];let i=0;
 const r=rollExpression('1d4! 1d6!',()=>seq[i++]);
 assert.equal(r[0].first,1);assert.equal(r[1].first,1);
});
test('d1! rifiutato',()=>assert.throws(()=>rollExpression('1d1!')));
test('mazzo persistente tra estrazioni',()=>{
 const a=drawInitiative(freshState(),['A','B'],()=>0.5);
 if(!a.cards.some(c=>c.value==='Jolly')) {
   const b=drawInitiative(a.state,['C'],()=>0.5);
   assert.ok(!a.cards.some(c=>c.id===b.cards[0].id));
 }
});
test('reset iniziativa',()=>assert.deepEqual(commandResponse('/iniziativa riavvio',{used:['A:♠️']}).state,freshState()));
