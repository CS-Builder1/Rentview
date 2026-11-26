import assert from "node:assert/strict";
import test from "node:test";
import { authDestination, callbackParams, claimPath, normalizeInviteCode, safeReturnPath } from "../lib/invites";
import { localDateKey, rentState, rentSummaries } from "../lib/tenantRent";

test("invitation codes normalize without accepting paths, markup or unbounded input",()=>{
 assert.equal(normalizeInviteCode("  aBcD1234  "),"ABCD1234");
 assert.equal(normalizeInviteCode("A".repeat(32)),"A".repeat(32));
 for(const invalid of [null,undefined,{},123,"abc","A".repeat(65),"ABC-123","<script>","ABC 123","ABC\n123"]){assert.equal(normalizeInviteCode(invalid),null);}
 assert.equal(claimPath("abcd1234"),"/claim?code=ABCD1234");
});
test("authentication redirects allow only known internal routes",()=>{
 for(const attack of ["https://evil.example/","//evil.example/","/\\evil.example/","/\nevil","/%2f%2fevil.example","/%252f%252fevil.example","/tenant/../../evil","javascript:alert(1)","/callback?next=https://evil.example","/tenant?next=//evil.example","/tenant#//evil.example"]){
  const actual=safeReturnPath(attack);
  assert.ok(actual==="/"||actual==="/tenant",`${attack} returned ${actual}`);
 }
 assert.equal(safeReturnPath("/claim?code=abcd1234&next=https://evil.example"),"/claim?code=ABCD1234");
 assert.equal(safeReturnPath("invalid","https://evil.example"),"/");
 assert.equal(safeReturnPath("/tenant/request/00000000-0000-4000-8000-000000000001"),"/tenant/request/00000000-0000-4000-8000-000000000001");
 assert.equal(safeReturnPath(["/tenant"]),"/");
});
test("PKCE callback parsing preserves invitation but drops external returns",()=>{
 const code="test-code";
 assert.deepEqual(callbackParams(`rentview://callback?code=${code}&next=${encodeURIComponent("/claim?code=ABCD1234")}`),{code,error:null,next:"/claim?code=ABCD1234",recovery:false});
 assert.equal(callbackParams("https://app.example/callback?next=https://evil.example&intent=recovery").next,"/");
 assert.equal(callbackParams("https://app.example/callback?error_description=Expired").error,"Expired");
});
test("default auth callbacks preserve a pending invitation until it is claimed", () => {
 const saved = "/claim?code=ABCD1234";
 assert.equal(authDestination("/", saved), saved);
 assert.equal(authDestination(undefined, saved), saved);
 assert.equal(authDestination("//evil.example", saved), saved);
 assert.equal(authDestination("/account", saved), "/account");
 assert.equal(authDestination("/", "https://evil.example"), "/");
});
test("rent status separates calendar due dates from paid, future and undated records",()=>{
 assert.equal(rentState({paid_on:null,due_date:"2026-10-25"},"2026-10-26"),"overdue");
 assert.equal(rentState({paid_on:null,due_date:"2026-10-26"},"2026-10-26"),"due");
 assert.equal(rentState({paid_on:null,due_date:"2026-10-27"},"2026-10-26"),"upcoming");
 assert.equal(rentState({paid_on:null,due_date:null},"2026-10-26"),"unscheduled");
 assert.equal(rentState({paid_on:"2026-10-24",due_date:"2026-10-25"},"2026-10-26"),"paid");
 assert.equal(localDateKey(new Date(2026,9,26,23,30)),"2026-10-26");
});
test("unpaid rent aggregates keep lease and currency boundaries intact",()=>{
 const rows=[
  {lease_id:"a",amount:100,currency:"USD",paid_on:null,due_date:"2026-10-25"},
  {lease_id:"a",amount:100,currency:"EUR",paid_on:null,due_date:"2026-10-25"},
  {lease_id:"b",amount:50,currency:"USD",paid_on:null,due_date:"2026-11-01"},
  {lease_id:"a",amount:25,currency:"USD",paid_on:null,due_date:"2026-10-26"},
  {lease_id:"a",amount:500,currency:"USD",paid_on:"2026-10-23",due_date:"2026-10-25"},
 ];
 const totals=rentSummaries(rows,"2026-10-26");
 assert.equal(totals.length,3);
 assert.deepEqual(totals.find(row=>row.leaseId==="a"&&row.currency==="USD"),{leaseId:"a",currency:"USD",overdue:100,due:25,upcoming:0,unscheduled:0});
 assert.equal(totals.find(row=>row.leaseId==="b")?.upcoming,50);
});

test("pending invitation survives sign-in but expires and rejects poisoned storage",async()=>{
 const {createAuthDestinationStore}=await import("../lib/authDestinationStore");
 const values=new Map<string,string>();let now=100000;
 const store=createAuthDestinationStore({async getItem(k){return values.get(k)??null;},async setItem(k,v){values.set(k,v);},async removeItem(k){values.delete(k);}},()=>now);
 await store.remember("/claim?code=ABCD1234");assert.equal(await store.pending(),"/claim?code=ABCD1234");
 now+=24*60*60*1000+1;assert.equal(await store.pending(),"/");assert.equal(values.size,0);
 await store.remember("/claim?code=EFGH5678");await store.clear();assert.equal(await store.pending(),"/");
 values.set("rentview.auth.destination.v1",JSON.stringify({path:"//evil.example",at:now}));assert.equal(await store.pending(),"/");assert.equal(values.size,0);
 values.set("rentview.auth.destination.v1",JSON.stringify({path:"/tenant",at:now+1000}));assert.equal(await store.pending(),"/");
 values.set("rentview.auth.destination.v1","{broken");assert.equal(await store.pending(),"/");
 await store.remember("https://evil.example");assert.equal(await store.pending(),"/");
});

test("pending invitation storage rejects non-finite timestamps, oversized or corrupt values", async () => {
 const {createAuthDestinationStore}=await import("../lib/authDestinationStore");
 const values = new Map<string,string>();
 const store=createAuthDestinationStore({async getItem(k){return values.get(k)??null;},async setItem(k,v){values.set(k,v);},async removeItem(k){values.delete(k);}},()=>100000);
 for (const raw of ['{"path":"/tenant","at":1e999}', 'null', '[]', '{broken', ' '.repeat(4097)]) {
  values.set("rentview.auth.destination.v1", raw);
  assert.equal(await store.pending(), "/");
  assert.equal(values.size, 0);
 }
});

test("clearing an invitation waits for an in-flight remember instead of resurrecting it", async () => {
 const {createAuthDestinationStore}=await import("../lib/authDestinationStore");
 const values = new Map<string,string>();
 let releaseWrite: (() => void) | undefined;
 const gate = new Promise<void>(resolve => { releaseWrite=resolve; });
 const store=createAuthDestinationStore({async getItem(k){return values.get(k)??null;},async setItem(k,v){await gate;values.set(k,v);},async removeItem(k){values.delete(k);}},()=>100000);
 const remember=store.remember("/claim?code=ABCD1234");
 const clear=store.clear();
 releaseWrite!();
 await Promise.all([remember,clear]);
 assert.equal(await store.pending(), "/");
});
