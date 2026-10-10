"use strict";
// Run: node test.js   (starts its own server on test ports; needs Node 18+)
const {spawn}=require("child_process"),path=require("path"),os=require("os"),fs=require("fs");
const P=18787,T=18788,BASE="http://127.0.0.1:"+P,TB="http://127.0.0.1:"+T,KEY="test-admin-key";
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log("FAIL:",m)}};
async function call(base,method,p,body,tok,hdr){const h=Object.assign({"Content-Type":"application/json"},hdr||{});if(tok)h.Authorization="Bearer "+tok;
 const r=await fetch(base+"/api"+p,{method,headers:h,body:body?JSON.stringify(body):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}}
const rm=f=>{for(const x of ["","-wal","-shm"])try{fs.unlinkSync(f+x)}catch(e){}};
async function run(mode,fn,dbf,keep,env){const data=dbf||path.join(os.tmpdir(),"gx-"+Date.now()+Math.random()+".db");
 const c=spawn(process.execPath,[path.join(__dirname,"server.js")],{env:Object.assign({},process.env,{PORT:P,TOR_PORT:T,MODE:mode,DB_FILE:data,ADMIN_KEY:KEY},env||{}),stdio:"ignore"});
 for(let i=0;i<50;i++){try{await fetch(BASE+"/api/health");break}catch(e){await new Promise(r=>setTimeout(r,100))}}
 try{await fn()}finally{c.kill();await new Promise(r=>setTimeout(r,300));if(!keep)rm(data)}}
const BTC="bc1q"+"qpzry9x8gf2tvdw0s3jn54khce6mua7l".slice(0,38),ETH="0x"+"a".repeat(40),XMR="8"+"A".repeat(94);
const http=require("http"),crypto=require("crypto");const MOCKURL="http://127.0.0.1:18795";let mockBTC=70000;
function startMock(){return new Promise(res=>{const s=http.createServer((q,r)=>{r.setHeader("Content-Type","application/json");
 if(q.url.startsWith("/fx"))return r.end(JSON.stringify({result:"success",rates:{INR:80,USD:1,EUR:.9}}));
 r.end(JSON.stringify({bitcoin:{usd:mockBTC},ethereum:{usd:3500},monero:{usd:170},tether:{usd:1},"usd-coin":{usd:1},litecoin:{usd:80},solana:{usd:150}}))}).listen(18795,"127.0.0.1",()=>res(s))})}
const sign=(sec,body,ts)=>crypto.createHmac("sha256",sec).update(ts+"."+body).digest("hex");
async function hook(route,ev,o){o=o||{};const body=JSON.stringify(ev),ts=o.ts||Date.now(),sig=o.sig||sign("whsec",body,ts);
 const r=await fetch(BASE+"/api/webhooks/"+route,{method:"POST",headers:{"X-Timestamp":String(ts),"X-Signature":sig,"Content-Type":"application/json"},body});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}}
(async()=>{
await run("sandbox",async()=>{
 let r=await call(BASE,"GET","/health");ok(r.s===200&&r.j.mode==="sandbox","health");
 r=await call(BASE,"GET","/tor/status");ok(r.j.tor===false,"tor false on main port");
 r=await call(TB,"GET","/tor/status");ok(r.j.tor===true,"tor true on tor port");
 r=await call(BASE,"GET","/prices");ok(r.j.prices.BTC>0&&r.j.fx.INR>0,"prices");
 r=await call(BASE,"GET","/state");ok(r.s===401,"state needs session");
 r=await call(BASE,"GET","/state",null,"x".repeat(30));ok(r.s===401,"bad token rejected");
 r=await call(BASE,"POST","/session",{});ok(r.s===200&&r.j.token&&r.j.bal.XMR===2.5,"session");const t=r.j.token;
 r=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"XMR",mode:"UPI"},t);ok(r.s===200&&r.j.coins>0&&r.j.bal.XMR>2.5,"buy ok");
 r=await call(BASE,"POST","/orders",{currency:"INR",amount:50000,coin:"XMR",mode:"UPI"},t);ok(r.s===403,"tier limit blocks $600 order: "+r.s);
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"BTC",mode:"UPI"},t);ok(r.s===400,"UPI rejected for USD");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:5,coin:"BTC",mode:"Card"},t);ok(r.s===400,"min order");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"NOPE",mode:"Card"},t);ok(r.s===400,"bad coin");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"BTC",mode:"Gift card",gift:"abc"},t);ok(r.s===400,"short gift code");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"BTC",mode:"Card",expectCoins:1},t);ok(r.s===409,"price moved -> 409");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:-5,coin:"BTC",mode:"Card"},t);ok(r.s===400,"negative amount");
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:"1e999",coin:"BTC",mode:"Card"},t);ok(r.s===400,"huge amount");
 r=await call(BASE,"POST","/swaps",{from:"XMR",to:"BTC",amount:1},t);ok(r.s===200&&r.j.out>0,"swap");
 r=await call(BASE,"POST","/swaps",{from:"XMR",to:"XMR",amount:1},t);ok(r.s===400,"swap same coin");
 r=await call(BASE,"POST","/swaps",{from:"XMR",to:"BTC",amount:9999},t);ok(r.s===400||r.s===403,"swap more than balance");
 r=await call(BASE,"POST","/sends",{coin:"BTC",amount:.001,fee:"Standard",address:BTC},t);ok(r.s===403&&/saved addresses/.test(r.j.error),"unsaved address is blocked server-side");
 r=await call(BASE,"POST","/addresses",{coin:"BTC",address:"nope",label:"x"},t);ok(r.s===400,"cannot save an invalid address");
 r=await call(BASE,"POST","/addresses",{id:"adr-btc-1",coin:"BTC",address:BTC,label:"My BTC"},t);ok(r.s===200,"save BTC address");
 r=await call(BASE,"POST","/addresses",{coin:"BTC",address:BTC,label:"dup"},t);ok(r.s===409,"duplicate address rejected");
 r=await call(BASE,"POST","/addresses",{coin:"ETH",address:ETH,label:"My ETH"},t);ok(r.s===200,"save ETH address");
 r=await call(BASE,"POST","/sends",{coin:"BTC",amount:.001,fee:"Standard",address:"hello"},t);ok(r.s===400,"bad address");
 r=await call(BASE,"POST","/sends",{coin:"BTC",amount:.001,fee:"Standard",address:BTC},t);ok(r.s===200&&!r.j.held,"send small");
 r=await call(BASE,"POST","/sends",{coin:"ETH",amount:.5,fee:"Economy",address:ETH},t);ok(r.s===403,"send $1,600 over Unverified limit");
 r=await call(BASE,"POST","/kyc",{tier:2},t);ok(r.s===200&&r.j.kyc===2,"kyc tier 2");
 r=await call(BASE,"POST","/sends",{coin:"ETH",amount:.5,fee:"Economy",address:ETH},t);ok(r.s===200&&r.j.held===true,"large send held 24h");const hid=r.j.id;
 let st=await call(BASE,"GET","/state",null,t);const before=st.j.bal.ETH;
 r=await call(BASE,"POST","/sends/cancel",{id:hid},t);ok(r.s===200&&r.j.bal.ETH>before,"cancel refunds");
 r=await call(BASE,"POST","/sells",{coin:"XMR",amount:1,mode:"UPI",payout:{upi:"bad"}},t);ok(r.s===400,"bad UPI");
 r=await call(BASE,"POST","/sells",{coin:"XMR",amount:1,mode:"UPI",payout:{upi:"name@okbank"}},t);ok(r.s===200&&r.j.net>0,"sell UPI");
 r=await call(BASE,"POST","/sells",{coin:"XMR",amount:.5,mode:"IMPS",payout:{name:"A B",account:"12345678901",ifsc:"HDFC0001234"}},t);ok(r.s===200,"sell IMPS");
 r=await call(BASE,"POST","/sells",{coin:"XMR",amount:.1,mode:"RTGS",payout:{name:"A B",account:"12345678901",ifsc:"HDFC0001234"}},t);ok(r.s===400,"RTGS below minimum");
 r=await call(BASE,"POST","/plans",{c:"BTC",a:2000,cur:"INR",f:"Weekly",next:"1/1/2027"},t);ok(r.s===200,"plan");
 r=await call(BASE,"POST","/plans",{c:"BTC",a:2000,cur:"INR",f:"Daily"},t);ok(r.s===400,"bad frequency");
 r=await call(BASE,"POST","/mixes",{coin:"BTC",amount:.001,rounds:3,dest:BTC},t);ok(r.s===200,"sandbox mix");
 r=await call(BASE,"POST","/mixes",{coin:"BTC",amount:.001,rounds:9,dest:BTC},t);ok(r.s===400,"bad rounds");
 r=await call(BASE,"POST","/admin/deposit",{token:t,coin:"XMR",amount:1},null,{"x-admin-key":"wrong"});ok(r.s===403,"admin wrong key");
 r=await call(BASE,"POST","/admin/deposit",{token:t,coin:"XMR",amount:1},null,{"x-admin-key":KEY});ok(r.s===200,"admin deposit");
 st=await call(BASE,"GET","/state",null,t);ok(st.j.hist.length>3&&st.j.plans.length===1,"state history and plans");
 ok(!JSON.stringify(st.j).includes("name@okbank")&&!JSON.stringify(st.j).includes("12345678901"),"payout details are not stored");
 r=await fetch(BASE+"/api/orders",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+t},body:"{bad"});ok(r.status===400,"invalid json");
 r=await fetch(BASE+"/api/orders",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+t},body:JSON.stringify({x:"y".repeat(30000)})});ok(r.status===413,"body too large: "+r.status);
 r=await fetch(BASE+"/");ok(r.status===200&&(await r.text()).includes("Game Exchanger")&&r.headers.get("content-security-policy"),"serves frontend with CSP");
 r=await fetch(BASE+"/..%2fserver.js");ok(r.status===403||r.status===404,"path traversal blocked: "+r.status);
 r=await fetch(BASE+"/%2e%2e/server.js");ok(r.status===403||r.status===404,"path traversal 2: "+r.status);
 r=await fetch(BASE+"/api/nope");ok(r.status===404,"unknown route 404");

 // ---- ledger, idempotency, concurrency ----
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":KEY});ok(r.j.ok===true,"ledger balanced after all operations: "+JSON.stringify(r.j));
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":"nope"});ok(r.s===403,"ledger-check needs admin key");
 const ik="idem-key-12345678";let a1=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"BTC",mode:"UPI"},t,{"Idempotency-Key":ik});
 let a2=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"BTC",mode:"UPI"},t,{"Idempotency-Key":ik});ok(a1.j.id&&a1.j.id===a2.j.id,"idempotent replay returns the same order");
 let a3=await call(BASE,"POST","/swaps",{from:"BTC",to:"ETH",amount:.0001},t,{"Idempotency-Key":ik});ok(a3.s===422,"idempotency key reuse on another route is rejected");
 st=await call(BASE,"GET","/state",null,t);const btcNow=st.j.bal.BTC;a2=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"BTC",mode:"UPI"},t,{"Idempotency-Key":ik});
 st=await call(BASE,"GET","/state",null,t);ok(st.j.bal.BTC===btcNow,"replay did not credit twice");
 const s2=await call(BASE,"POST","/session",{});const t2=s2.j.token;await call(BASE,"POST","/admin/deposit",{token:t2,coin:"XMR",amount:1},null,{"x-admin-key":KEY});
 await call(BASE,"POST","/kyc",{tier:1},t2);const par=await Promise.all([1,2,3,4,5].map(()=>call(BASE,"POST","/swaps",{from:"XMR",to:"BTC",amount:2},t2)));
 ok(par.filter(x=>x.s===200).length===1,"parallel requests cannot overspend: "+par.map(x=>x.s).join(","));
 st=await call(BASE,"GET","/state",null,t2);ok(!Object.values(st.j.bal).some(v=>v<0),"no negative balances");
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":KEY});ok(r.j.ok===true,"ledger still balanced after parallel load");
 const {DatabaseSync}=require("node:sqlite");
});
// ---- persistence across restart + append-only + hold release ----
const DBF=require("path").join(os.tmpdir(),"gx-persist-"+Date.now()+".db");let tok,xmr;
await run("sandbox",async()=>{let r=await call(BASE,"POST","/session",{});tok=r.j.token;await call(BASE,"POST","/kyc",{tier:2},tok);await call(BASE,"POST","/addresses",{coin:"ETH",address:ETH,label:"e"},tok);
 await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"XMR",mode:"UPI"},tok);r=await call(BASE,"GET","/state",null,tok);xmr=r.j.bal.XMR;
 r=await call(BASE,"POST","/sends",{coin:"ETH",amount:.5,fee:"Economy",address:ETH},tok);ok(r.j.held===true,"held send created for release test")},DBF,true);
{const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(DBF);
 let blocked=false;try{d.exec("UPDATE entries SET amount=amount+1 WHERE id=1")}catch(e){blocked=/append-only/.test(e.message)}ok(blocked,"ledger entries cannot be edited");
 blocked=false;try{d.exec("DELETE FROM transactions WHERE id=1")}catch(e){blocked=/append-only/.test(e.message)}ok(blocked,"ledger transactions cannot be deleted");
 d.exec("UPDATE holds SET until=1");d.close()}
await run("sandbox",async()=>{let r=await call(BASE,"GET","/state",null,tok);ok(r.s===200&&Math.abs(r.j.bal.XMR-xmr)<1e-9,"balance survives a server restart");
 ok(r.j.holds.length===0,"expired hold was released on restart");
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":KEY});ok(r.j.ok===true,"ledger balanced after hold release")},DBF,false);

// ---- async payments, deposit addresses and webhooks ----
const mock2=await startMock();
await run("sandbox",async()=>{await new Promise(x=>setTimeout(x,700));
 let r=await call(BASE,"POST","/session",{});const t=r.j.token;await call(BASE,"POST","/kyc",{tier:1},t);
 let st=await call(BASE,"GET","/state",null,t);const x0=st.j.bal.XMR;
 r=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"XMR",mode:"UPI"},t);ok(r.s===200&&r.j.status==="pending"&&r.j.checkout,"async order is pending");const oid=r.j.id;
 st=await call(BASE,"GET","/state",null,t);ok(st.j.bal.XMR===x0,"no coins before the payment is confirmed");
 const ev={id:"evt_1",type:"payment.captured",data:{order_id:oid,amount:2000,currency:"INR"}};
 r=await hook("payment",ev,{sig:"0".repeat(64)});ok(r.s===401,"bad webhook signature rejected");
 r=await hook("payment",ev,{ts:Date.now()-6e5});ok(r.s===400,"stale webhook rejected (replay protection)");
 r=await hook("payment",{...ev,data:{order_id:oid,amount:1,currency:"INR"}});ok(r.s===422,"wrong amount rejected");
 r=await hook("payment",ev);ok(r.s===200&&!r.j.duplicate,"valid webhook accepted");
 st=await call(BASE,"GET","/state",null,t);ok(st.j.bal.XMR>x0,"coins credited after the webhook");const x1=st.j.bal.XMR;
 r=await hook("payment",ev);ok(r.s===200&&r.j.duplicate===true,"replayed webhook is a no-op");
 r=await hook("payment",{...ev,id:"evt_other"});ok(r.j.duplicate===true,"same order, new event id: still credited once");
 st=await call(BASE,"GET","/state",null,t);ok(st.j.bal.XMR===x1,"never credited twice");
 r=await call(BASE,"POST","/orders",{currency:"INR",amount:2000,coin:"XMR",mode:"UPI"},t);const o2=r.j.id;
 r=await hook("payment",{id:"evt_fail",type:"payment.failed",data:{order_id:o2}});ok(r.s===200,"payment.failed handled");
 r=await hook("payment",{id:"evt_late",type:"payment.captured",data:{order_id:o2,amount:2000,currency:"INR"}});ok(r.j.duplicate===true,"a failed order cannot be credited later");
 r=await call(BASE,"POST","/deposit-address",{coin:"BTC"},t);ok(r.s===200&&/^bc1/.test(r.j.address),"deposit address issued");const addr=r.j.address;
 let r2=await call(BASE,"POST","/deposit-address",{coin:"BTC"},t);ok(r2.j.address===addr,"same address returned until a fresh one is asked for");
 r2=await call(BASE,"POST","/deposit-address",{coin:"BTC",fresh:true},t);ok(r2.j.address!==addr,"fresh address on request");
 r=await hook("deposit",{id:"d1",type:"deposit.confirmed",data:{coin:"BTC",address:addr,amount:.01,txid:"tx1",confirmations:1}});ok(r.j.pending===true,"deposit waits for confirmations");
 st=await call(BASE,"GET","/state",null,t);const b0=st.j.bal.BTC||0;
 r=await hook("deposit",{id:"d2",type:"deposit.confirmed",data:{coin:"BTC",address:addr,amount:.01,txid:"tx1",confirmations:3}});ok(r.s===200&&!r.j.duplicate,"confirmed deposit accepted");
 r=await hook("deposit",{id:"d3",type:"deposit.confirmed",data:{coin:"BTC",address:addr,amount:.01,txid:"tx1",confirmations:4}});ok(r.j.duplicate===true,"same txid cannot be credited twice");
 st=await call(BASE,"GET","/state",null,t);ok(Math.abs(st.j.bal.BTC-b0-.01)<1e-9,"deposit credited exactly once");
 r=await hook("deposit",{id:"d4",type:"deposit.confirmed",data:{coin:"BTC",address:"bc1qunknown"+"q".repeat(30),amount:1,txid:"tx9",confirmations:9}});ok(r.s===404,"unknown deposit address rejected");
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":KEY});ok(r.j.ok===true,"ledger balanced after webhooks");
},null,false,{WEBHOOK_SECRET:"whsec",PAYMENT_ASYNC:"1",PRICE_FEED:"coingecko",COINGECKO_URL:MOCKURL,FX_URL:MOCKURL+"/fx",FEED_INTERVAL_MS:"300"});
// ---- recurring buys: exactly-once scheduler ----
const SDB=require("path").join(os.tmpdir(),"gx-sched-"+Date.now()+".db");
await run("sandbox",async()=>{const {DatabaseSync}=require("node:sqlite");let r=await call(BASE,"POST","/session",{});const t=r.j.token;await call(BASE,"POST","/kyc",{tier:1},t);
 r=await call(BASE,"POST","/plans",{c:"BTC",a:2000,cur:"INR",f:"Weekly"},t);ok(r.s===200&&r.j.id,"plan created");const pid=r.j.id;
 r=await call(BASE,"POST","/plans",{c:"BTC",a:2000,cur:"INR",f:"Weekly",mode:"Gift card"},t);ok(r.s===400,"gift cards cannot fund recurring buys");
 let st=await call(BASE,"GET","/state",null,t);ok(st.j.plans.length===1&&st.j.plans[0].status==="active"&&st.j.plans[0].next,"plan listed with its next date");const b0=st.j.bal.BTC;
 r=await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY});ok(r.j.ran===0,"nothing runs before it is due");
 const d=new DatabaseSync(SDB);d.exec("UPDATE plans SET next_run=1000");
 r=await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY});ok(r.j.ran===1,"due plan runs");
 st=await call(BASE,"GET","/state",null,t);ok(st.j.bal.BTC>b0,"recurring buy credited coins");
 r=await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY});ok(r.j.ran===0,"does not run twice for the same period");
 d.exec("DELETE FROM plan_runs");d.exec("UPDATE plans SET next_run=1000");const b1=(await call(BASE,"GET","/state",null,t)).j.bal.BTC;
 r=await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY});ok(r.j.ran===1,"a later period runs");
 await call(BASE,"POST","/plans/cancel",{id:pid},t);d.exec("UPDATE plans SET next_run=1000, status='cancelled'");r=await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY});ok(r.j.ran===0,"cancelled plans never run");
 r=await call(BASE,"POST","/plans",{c:"BTC",a:500000,cur:"INR",f:"Monthly"},t);const big=r.j.id;
 for(let i=0;i<3;i++){d.exec("UPDATE plans SET next_run=1000 WHERE id='"+big+"'");await call(BASE,"POST","/admin/run-scheduler",{},null,{"x-admin-key":KEY})}
 st=await call(BASE,"GET","/state",null,t);const pl=st.j.plans.find(x=>x.id===big);ok(pl&&pl.status==="paused"&&pl.error,"plan pauses after 3 failures and says why: "+JSON.stringify(pl));
 r=await call(BASE,"GET","/admin/ledger-check",null,null,{"x-admin-key":KEY});ok(r.j.ok===true,"ledger balanced after recurring buys");d.close()},SDB,false);
// ---- real price feed: sanity checks and staleness ----
await run("sandbox",async()=>{await new Promise(x=>setTimeout(x,900));
 let r=await call(BASE,"GET","/prices");ok(r.j.prices.BTC===70000&&r.j.source==="coingecko"&&!r.j.stale,"prices come from the feed");ok(Math.abs(r.j.fx.INR-.0125)<1e-9,"fx is inverted correctly (80 INR per USD = 0.0125)");
 mockBTC=140000;await new Promise(x=>setTimeout(x,800));r=await call(BASE,"GET","/prices");ok(r.j.prices.BTC===70000,"a 100% price jump is rejected as a bad tick");
 mockBTC=71000;await new Promise(x=>setTimeout(x,800));r=await call(BASE,"GET","/prices");ok(r.j.prices.BTC===71000,"a normal move is accepted");
 mock2.close();await new Promise(x=>setTimeout(x,2400));r=await call(BASE,"GET","/prices");ok(r.j.stale===true,"prices are reported stale when the feed dies");
 const s=await call(BASE,"POST","/session",{});r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"BTC",mode:"Card"},s.j.token);ok(r.s===503,"no trading on stale prices: "+r.s)
},null,false,{PRICE_FEED:"coingecko",COINGECKO_URL:MOCKURL,FX_URL:MOCKURL+"/fx",FEED_INTERVAL_MS:"300",STALE_MS:"1500"});
// ---- allowlist cooldown ----
await run("sandbox",async()=>{let r=await call(BASE,"POST","/session",{});const t=r.j.token;await call(BASE,"POST","/kyc",{tier:1},t);
 await call(BASE,"POST","/addresses",{coin:"BTC",address:BTC,label:"new"},t);
 r=await call(BASE,"POST","/sends",{coin:"BTC",amount:.001,fee:"Economy",address:BTC},t);ok(r.s===403&&/recently/.test(r.j.error),"new address is locked during the cooldown");
 await call(BASE,"POST","/settings",{allowlistOnly:false},t);let st=await call(BASE,"GET","/state",null,t);ok(st.j.settings.allowlistOnly===true,"turning the rule off also waits for the cooldown");
 r=await call(BASE,"POST","/sends",{coin:"BTC",amount:.001,fee:"Economy",address:"bc1q"+"p".repeat(38)},t);ok(r.s===403,"unsaved address still blocked while the rule is pending off");
 await call(BASE,"POST","/addresses/delete",{id:st.j.addrs[0].id},t);st=await call(BASE,"GET","/state",null,t);ok(st.j.addrs.length===0,"deleting an address is immediate")
},null,false,{ADDR_COOLDOWN_MS:"3600000"});
const mock=await startMock();
await run("live",async()=>{
 let r=await call(BASE,"POST","/session",{});ok(r.j.mode==="live"&&Object.keys(r.j.bal).length===0,"live session starts empty");const t=r.j.token;
 await new Promise(x=>setTimeout(x,900));
 r=await call(BASE,"POST","/orders",{currency:"USD",amount:50,coin:"BTC",mode:"Card"},t);ok(r.s===501,"live refuses to take payment: "+r.s);
 r=await call(BASE,"POST","/mixes",{coin:"BTC",amount:.001,rounds:3,dest:BTC},t);ok(r.s===403,"live refuses mixing");
 r=await call(BASE,"POST","/kyc",{tier:1},t);ok(r.s===501,"live kyc needs provider");
},null,false,{PRICE_FEED:"coingecko",COINGECKO_URL:MOCKURL,FX_URL:MOCKURL+"/fx",FEED_INTERVAL_MS:"300"});mock.close();
console.log(fail?"\n"+fail+" FAILED, "+pass+" passed":"All "+pass+" tests passed");process.exit(fail?1:0)})();
