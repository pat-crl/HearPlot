const test=require("node:test");const assert=require("node:assert/strict");
const {readId3Metadata,readMp4Metadata}=require("../metadata.cjs");
function atom(name,payload){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(name,4,"latin1");payload.copy(b,8);return b;}
function tagFrame(name,text){const payload=Buffer.concat([Buffer.from([3]),Buffer.from(text)]);const h=Buffer.alloc(10);h.write(name);h.writeUInt32BE(payload.length,4);return Buffer.concat([h,payload]);}
function tag(frames,extended=false){const body=Buffer.concat(frames);const b=Buffer.alloc(10);b.write("ID3");b[3]=3;b[5]=extended?0x40:0;const extra=extended?Buffer.from([0,0,0,6,0,0,0,0,0,0]):Buffer.alloc(0);const size=body.length+extra.length;for(let i=0;i<4;i++)b[9-i]=(size>>>(i*7))&127;return Buffer.concat([b,extra,body]);}
test("MP3 title and artist including extended headers and Unicode are decoded",()=>{
  for(const extended of [false,true])assert.deepEqual(readId3Metadata(tag([tagFrame("TIT2","Café ♫"),tagFrame("TPE1","Artist")],extended)),{title:"Café ♫",artist:"Artist"});
});
test("truncated and arbitrary metadata buffers fail safely",()=>{
  for(let size=0;size<256;size++){
    const b=Buffer.alloc(size,255);assert.doesNotThrow(()=>readId3Metadata(b));assert.doesNotThrow(()=>readMp4Metadata(b));
    if(size>=3){b.write("ID3");assert.doesNotThrow(()=>readId3Metadata(b));}
  }
});
test("deeply nested MP4 atoms cannot exhaust the call stack",()=>{
  let b=atom("free",Buffer.alloc(0));for(let i=0;i<2000;i++)b=atom("moov",b);
  assert.deepEqual(readMp4Metadata(b),{});
});
test("MP4 reads iTunes text and supports an atom extending to EOF",()=>{
  const header=Buffer.alloc(8);header.writeUInt32BE(1,0);
  const title=atom("\xa9nam",atom("data",Buffer.concat([header,Buffer.from("Study")])));
  const b=atom("moov",atom("udta",atom("meta",Buffer.concat([Buffer.alloc(4),atom("ilst",title)]))));
  assert.deepEqual(readMp4Metadata(b),{title:"Study"});b.writeUInt32BE(0,0);assert.deepEqual(readMp4Metadata(b),{title:"Study"});
});
