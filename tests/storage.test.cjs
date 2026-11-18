const test=require("node:test");const assert=require("node:assert/strict");
const {createResilientStorage}=require("../storage.js");
test("quota failures preserve the current edit in memory and warn without throwing",()=>{
  const backing=new Map([["old","existing"]]);let full=false;let warnings=0;
  const storage=createResilientStorage(()=>({getItem:k=>backing.get(k)??null,setItem(k,v){if(full)throw new Error("quota");backing.set(k,v)}}),()=>warnings++);
  assert.equal(storage.getItem("old"),"existing");full=true;
  assert.equal(storage.setItem("analysis","new notes"),false);
  assert.equal(storage.getItem("analysis"),"new notes");assert.equal(storage.getItem("old"),"existing");assert.equal(warnings,1);
  full=false;assert.equal(storage.setItem("analysis","recovered"),true);assert.equal(backing.get("analysis"),"recovered");
});
test("denied storage access cannot stop startup or later editing",()=>{
  let warnings=0;const storage=createResilientStorage(()=>{throw new Error("access denied")},()=>warnings++);
  assert.equal(storage.getItem("theme"),null);assert.equal(storage.setItem("theme","night"),false);assert.equal(storage.getItem("theme"),"night");assert.ok(storage.hasFailed);assert.equal(warnings,2);
});
