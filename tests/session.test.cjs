const test = require("node:test");
const assert = require("node:assert/strict");
const { normaliseAnalysis, normaliseSelection, normaliseSharedAudioUrl, validateSession, sessionMatchesAudio } = require("../session.js");
const options = { duration: 12, sampleRate: 48000 };

test("malformed entries cannot poison analysis data or lose valid notes", () => {
  const result = normaliseAnalysis({categories:[null,{}," review ","all","__new__"],annotations:[null,4,{},
    {id:"a",start:1,end:3,note:"Keep <script> as literal text",category:"review",links:[null,{start:5,end:6}]},
    {id:"a",start:2,end:4,note:"Second",category:{}},
    {start:8,end:7}, {start:-5,end:-1}, {start:14,end:15}],sections:[null,{start:0,end:4,name:"Opening",colour:"bad"}]}, options);
  assert.equal(result.annotations.length,2);
  assert.notEqual(result.annotations[0].id,result.annotations[1].id);
  assert.equal(result.annotations[0].note,"Keep <script> as literal text");
  assert.equal(result.annotations[0].links.length,1);
  assert.equal(result.annotations[1].category,"form");
  assert.ok(result.categories.every(c=>typeof c==="string"));
  assert.ok(result.categories.includes("review"));
  assert.ok(!result.categories.includes("__new__"));
  assert.equal(result.sections.length,1);
  assert.ok(result.skipped>0);
});
test("regions stay within audio and invalid spectral bands retain time and note",()=>{
  assert.deepEqual(normaliseSelection({start:-2,end:20,source:"spectrogram",minFrequency:10,maxFrequency:50000},options),{start:0,end:12,source:"spectrogram",minFrequency:20,maxFrequency:24000});
  assert.equal(normaliseSelection({start:3,end:3},options),null);
  assert.equal(normaliseSelection({start:Infinity,end:9},options),null);
  assert.equal(normaliseSelection({start:1,end:2,source:"spectrogram",minFrequency:900,maxFrequency:100},options).source,"waveform");
});
test("normalisation preserves valid session data across a JSON roundtrip",()=>{
  const first=normaliseAnalysis({annotations:[{id:"a",start:1,end:2,source:"spectrogram",minFrequency:200,maxFrequency:1000,category:"toString",note:"Unicode ♫ café\nSecond line",createdAt:"2026-11-17",links:[{id:"l",start:4,end:5,source:"waveform"}]}],sections:[{id:"s",name:"Intro",start:0,end:3,colour:"#f4c95d"}]},options);
  const next=normaliseAnalysis(JSON.parse(JSON.stringify(first)),options);
  assert.deepEqual(next,first);
});
test("only explicit HTTPS links without embedded credentials are accepted",()=>{
  for(const value of [null,{},"javascript:alert(1)","file:///tmp/audio.wav","http://example.com/a","https://name:password@example.com/a"])assert.equal(normaliseSharedAudioUrl(value),"");
  assert.equal(normaliseSharedAudioUrl(" https://example.com/audio.wav?x=1 "),"https://example.com/audio.wav?x=1");
});
test("session versions and audio duration are checked before applying",()=>{
  assert.throws(()=>validateSession({format:"music-analyser-session",annotations:[],version:99}));
  assert.doesNotThrow(()=>validateSession({format:"music-analyser-session",annotations:[],version:3}));
  assert.ok(sessionMatchesAudio({track:{duration:12.1}},12));
  assert.ok(!sessionMatchesAudio({track:{duration:100}},12));
  assert.ok(!sessionMatchesAudio({},12));
});
test("bounded fuzz inputs always produce finite nonempty regions and unique IDs",()=>{
  const values=[null,{},[],"bad",NaN,Infinity,-10,0,1,12,99];
  const annotations=[];
  for(const start of values)for(const end of values)annotations.push({id:"same",start,end,source:"spectrogram",minFrequency:start,maxFrequency:end,category:start});
  const r=normaliseAnalysis({annotations},options);
  assert.equal(new Set(r.annotations.map(a=>a.id)).size,r.annotations.length);
  for(const a of r.annotations)assert.ok(Number.isFinite(a.start)&&a.start>=0&&a.end<=12&&a.end>a.start);
});
test("sessions distinguish differently named recordings of equal duration and support earlier unnamed sessions", () => {
  const track = { fileName: "Étude.wav", duration: 10 };
  assert.ok(sessionMatchesAudio({ track }, 10, "E\u0301tude"));
  assert.equal(sessionMatchesAudio({ track }, 10, "Étude II"), false);
  assert.ok(sessionMatchesAudio({ track: { duration: 10 } }, 10, "Étude"));
});
