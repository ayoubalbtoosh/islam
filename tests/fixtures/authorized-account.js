/** TEST ONLY: inserted into a Playwright response before startApplication().
 * This synthetic account bypasses authentication to isolate the existing game,
 * IndexedDB and lifecycle regressions. It never ships in the production bundle
 * and does not prove email delivery, account registration, RLS or real cloud sync.
 */
(()=>{
 const identity={mode:'account',configured:true,user:{id:'00000000-0000-4000-8000-000000000042',email:'learner@fixture.test',name:'حساب اختبار محاكى'},isAdmin:false,cloudStatus:'local',error:''};
 const fixture={synthetic:true,identity,remoteRecords:null,syncCount:0,resetCount:0};
 globalThis.__authorizedAccountFixture=fixture;
 Auth.init=async()=>structuredClone(identity);
 Auth.current=()=>structuredClone(identity);
 Auth.prepareStorage=async()=>{await db.useAccount(identity.user.id);};
 Auth.syncNow=async()=>{fixture.remoteRecords=await db.all();fixture.syncCount++;identity.cloudStatus='synced';};
 Auth.flush=async()=>{await db.flush();await Auth.syncNow();};
 Auth.resetProgress=async()=>{fixture.remoteRecords={};fixture.resetCount++;await db.clear();await db.flush();};
 Auth.signOut=async()=>{await Auth.flush();identity.mode='signed-out';identity.user=null;await db.useGuest();location.reload();};
 Auth.signInEmail=async()=>{throw Error('The game fixture must not exercise real sign-in.');};
 Auth.signUpEmail=async()=>{throw Error('The game fixture must not exercise account creation.');};
})();
