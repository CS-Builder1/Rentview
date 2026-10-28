import assert from "node:assert/strict";
import test from "node:test";
import { completeDeviceSignOut, type SignOutDependencies } from "../lib/sessionActions";
function fixture(){
 let account:string|null="account-a";const removed:string[]=[];let calls=0,destinations=0;
 const deps:SignOutDependencies={account:()=>account,unregisterDevice:async()=>{},signOutSession:async()=>{calls++;return {error:null};},acceptSignedOut:()=>{account=null;},clearReadCache:async id=>{removed.push(id);},clearDestination:async()=>{destinations++;}};
 return {deps,removed,setAccount:(value:string|null)=>{account=value;},get account(){return account;},get calls(){return calls;},get destinations(){return destinations;}};
}
test("successful signout clears this session and its read cache/destination, preserving saved work",async()=>{
 const f=fixture();await completeDeviceSignOut(f.deps);assert.equal(f.account,null);assert.equal(f.calls,1);assert.deepEqual(f.removed,["account-a"]);assert.equal(f.destinations,1);
});
test("confirmed deletion cleanup refuses a different signed-in account",async()=>{
 const f=fixture();await assert.rejects(completeDeviceSignOut(f.deps,"account-b"),/account changed/);assert.equal(f.calls,0);assert.equal(f.account,"account-a");assert.equal(f.removed.length,0);
});
test("account switching while device unregister is pending never signs out the newer account",async()=>{
 const f=fixture();let finish!:()=>void;f.deps.unregisterDevice=()=>new Promise<void>(resolve=>{finish=resolve;});const pending=completeDeviceSignOut(f.deps,"account-a");f.setAccount("account-b");finish();await assert.rejects(pending,/account changed/);assert.equal(f.calls,0);assert.equal(f.account,"account-b");assert.equal(f.destinations,0);
});
test("session errors reject to the caller and do not claim signout or clear account state",async()=>{
 const f=fixture();f.deps.signOutSession=async()=>({error:new Error("network unavailable")});await assert.rejects(completeDeviceSignOut(f.deps),/network unavailable/);assert.equal(f.account,"account-a");assert.equal(f.removed.length,0);assert.equal(f.destinations,0);
});
test("device unregister is best effort; it does not prevent confirmed session cleanup",async()=>{
 const f=fixture();f.deps.unregisterDevice=async()=>{throw new Error("push unavailable");};await completeDeviceSignOut(f.deps,"account-a");assert.equal(f.account,null);assert.equal(f.calls,1);
});
test("delayed cache cleanup cannot clear a newer account's onboarding destination",async()=>{
 const f=fixture();f.deps.clearReadCache=async id=>{f.removed.push(id);f.setAccount("account-b");};await assert.rejects(completeDeviceSignOut(f.deps,"account-a"),/account changed/);assert.equal(f.account,"account-b");assert.deepEqual(f.removed,["account-a"]);assert.equal(f.destinations,0);
});
test("a storage cleanup failure does not turn a completed signout into a false session failure",async()=>{
 const f=fixture();f.deps.clearReadCache=async()=>{throw new Error("quota failure");};f.deps.clearDestination=async()=>{throw new Error("storage unavailable");};await completeDeviceSignOut(f.deps);assert.equal(f.account,null);
});
