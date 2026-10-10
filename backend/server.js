"use strict";
/* Game Exchanger backend. No npm packages. Needs Node 22.5+ (built-in node:sqlite).
   Storage: SQLite with an append-only double-entry ledger.
   MODE=sandbox (default): test ledger, simulated providers.  MODE=live: refuses until providers.js is implemented. */
const _ew=process.emitWarning;process.emitWarning=(w,...a)=>String(w).includes("SQLite")?undefined:_ew.call(process,w,...a);
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto"),{DatabaseSync}=require("node:sqlite"),providers=require("./providers");
const PORT=+process.env.PORT||8787,TOR_PORT=+process.env.TOR_PORT||0,MODE=process.env.MODE==="live"?"live":"sandbox";
const DB_FILE=process.env.DB_FILE||path.join(__dirname,"gx.db"),PUB=path.join(__dirname,"public"),ORIGIN=process.env.ALLOWED_ORIGIN||"",ADMIN=process.env.ADMIN_KEY||"";
const FIAT={INR:.012,USD:1,EUR:1.08,GBP:1.27,AED:.272,JPY:.0067,AUD:.66,CAD:.73,SGD:.75,CNY:.138,BRL:.18,CHF:1.13,RUB:.011,ZAR:.054};
const px={BTC:65000,ETH:3200,XMR:160,USDT:1,USDC:1,LTC:80,BNB:580,SOL:150,XRP:.6,DOGE:.15,ADA:.45,TRX:.12,DOT:7,AVAX:35,BCH:420,ZEC:28};
const MODES={"Card":{fee:2.5,cur:null},"UPI":{fee:.5,cur:"INR"},"RTGS":{fee:.8,cur:"INR"},"Net banking":{fee:1,cur:"INR"},"Gift card":{fee:4,cur:null}};
const TIERS=[200,2000,25000],FEES={Economy:.5,Standard:1.5,Priority:4},HOLD_USD=1000,HOLD_MS=864e5,MAXC=1e7,SEED={XMR:2.5,BTC:.05,ETH:1};
const WEBHOOK_SECRET=process.env.WEBHOOK_SECRET||"",COOLDOWN=+process.env.ADDR_COOLDOWN_MS||0,CONFS=+process.env.DEPOSIT_CONFIRMATIONS||3,FEED=process.env.PRICE_FEED||(MODE==="live"?"coingecko":"sandbox"),FEED_MS=+process.env.FEED_INTERVAL_MS||30000,STALE_MS=+process.env.STALE_MS||120000,feeds=require("./feeds");
const A="[1-9A-HJ-NP-Za-km-z]";
const RE={BTC:/^(bc1[a-z0-9]{25,60}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,LTC:/^(ltc1[a-z0-9]{25,60}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/,XMR:new RegExp("^[48]"+A+"{94}$"),SOL:new RegExp("^"+A+"{32,44}$"),XRP:new RegExp("^r"+A+"{24,34}$"),DOGE:new RegExp("^D"+A+"{33}$"),TRX:new RegExp("^T"+A+"{33}$"),ADA:/^addr1[a-z0-9]{50,110}$/,DOT:new RegExp("^1"+A+"{46,47}$"),BCH:/^(bitcoincash:)?[qp][a-z0-9]{41}$/,ZEC:new RegExp("^t1"+A+"{33}$")},EVM=/^0x[0-9a-fA-F]{40}$/;
class HttpError extends Error{constructor(s,m){super(m);this.status=s}}
const bad=(m,s)=>{throw new HttpError(s||400,m)};
const U=x=>Math.round(x*1e8),sha=t=>crypto.createHash("sha256").update(t).digest("hex");
// ================= database: append-only double-entry ledger =================
const db=new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,kyc INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,last INTEGER NOT NULL,allow_off_at INTEGER);
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,session TEXT NOT NULL,asset TEXT NOT NULL,kind TEXT NOT NULL,balance INTEGER NOT NULL DEFAULT 0,UNIQUE(session,asset,kind),CHECK(kind<>'user' OR balance>=0));
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY,session TEXT NOT NULL,type TEXT NOT NULL,memo TEXT NOT NULL,meta TEXT,ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY,tx INTEGER NOT NULL REFERENCES transactions(id),account INTEGER NOT NULL REFERENCES accounts(id),asset TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount<>0));
CREATE TABLE IF NOT EXISTS holds(id TEXT PRIMARY KEY,session TEXT NOT NULL,asset TEXT NOT NULL,amount INTEGER NOT NULL,fee INTEGER NOT NULL,dest TEXT NOT NULL,until INTEGER NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,session TEXT NOT NULL,data TEXT NOT NULL,next_run INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',fails INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plan_runs(plan TEXT NOT NULL,due INTEGER NOT NULL,PRIMARY KEY(plan,due));
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,session TEXT NOT NULL,coin TEXT NOT NULL,cu INTEGER NOT NULL,cur TEXT NOT NULL,amount REAL NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,ref TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deposit_addresses(address TEXT PRIMARY KEY,session TEXT NOT NULL,coin TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deposits(txid TEXT NOT NULL,address TEXT NOT NULL,PRIMARY KEY(txid,address));
CREATE TABLE IF NOT EXISTS allowlist(id TEXT NOT NULL,session TEXT NOT NULL,coin TEXT NOT NULL,address TEXT NOT NULL,label TEXT NOT NULL,active_after INTEGER NOT NULL,PRIMARY KEY(session,id),UNIQUE(session,coin,address));
CREATE TABLE IF NOT EXISTS idem(session TEXT NOT NULL,key TEXT NOT NULL,route TEXT NOT NULL,response TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(session,key));
CREATE INDEX IF NOT EXISTS ix_entries_tx ON entries(tx);CREATE INDEX IF NOT EXISTS ix_entries_acct ON entries(account);CREATE INDEX IF NOT EXISTS ix_tx_session ON transactions(session,id);
CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS tx_no_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS tx_no_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;`);
{const have=n=>db.prepare("PRAGMA table_info("+n+")").all().map(c=>c.name);   // migrate databases made by the previous version
 for(const[n,d]of[["next_run","INTEGER NOT NULL DEFAULT 0"],["status","TEXT NOT NULL DEFAULT 'active'"],["fails","INTEGER NOT NULL DEFAULT 0"]])if(!have("plans").includes(n))db.exec("ALTER TABLE plans ADD COLUMN "+n+" "+d);
 if(!have("sessions").includes("allow_off_at"))db.exec("ALTER TABLE sessions ADD COLUMN allow_off_at INTEGER")}
const q={
 sess:db.prepare("SELECT id,kyc,allow_off_at FROM sessions WHERE id=?"),newSess:db.prepare("INSERT INTO sessions(id,created,last) VALUES(?,?,?)"),touch:db.prepare("UPDATE sessions SET last=? WHERE id=?"),setKyc:db.prepare("UPDATE sessions SET kyc=? WHERE id=?"),
 newAcct:db.prepare("INSERT OR IGNORE INTO accounts(session,asset,kind) VALUES(?,?,?)"),getAcct:db.prepare("SELECT id,balance FROM accounts WHERE session=? AND asset=? AND kind=?"),
 tx:db.prepare("INSERT INTO transactions(session,type,memo,meta,ts) VALUES(?,?,?,?,?)"),entry:db.prepare("INSERT INTO entries(tx,account,asset,amount) VALUES(?,?,?,?)"),upd:db.prepare("UPDATE accounts SET balance=balance+? WHERE id=?"),
 bals:db.prepare("SELECT asset,balance FROM accounts WHERE session=? AND kind='user' AND balance>0"),
 hist:db.prepare("SELECT memo,ts FROM transactions WHERE session=? AND type IN ('buy','swap','send','sell','deposit','mix','cancel') ORDER BY id DESC LIMIT 50"),
 holdNew:db.prepare("INSERT INTO holds(id,session,asset,amount,fee,dest,until,status) VALUES(?,?,?,?,?,?,?,'held')"),holdGet:db.prepare("SELECT * FROM holds WHERE id=? AND session=? AND status='held'"),holdSet:db.prepare("UPDATE holds SET status=? WHERE id=?"),
 holdList:db.prepare("SELECT id,asset coin,amount,fee,dest `to`,until FROM holds WHERE session=? AND status='held'"),holdDue:db.prepare("SELECT * FROM holds WHERE status='held' AND until<=?"),
 planNew:db.prepare("INSERT INTO plans(id,session,data,next_run,status,fails) VALUES(?,?,?,?,'active',0)"),planList:db.prepare("SELECT id,data,next_run,status FROM plans WHERE session=? AND status IN ('active','paused')"),planCount:db.prepare("SELECT COUNT(*) n FROM plans WHERE session=? AND status IN ('active','paused')"),
 planDue:db.prepare("SELECT * FROM plans WHERE status='active' AND next_run>0 AND next_run<=?"),planAdv:db.prepare("UPDATE plans SET next_run=?,fails=0 WHERE id=?"),planFail:db.prepare("UPDATE plans SET fails=?,status=?,next_run=?,data=? WHERE id=?"),planCancel:db.prepare("UPDATE plans SET status='cancelled' WHERE id=? AND session=?"),
 runGet:db.prepare("SELECT 1 x FROM plan_runs WHERE plan=? AND due=?"),runNew:db.prepare("INSERT INTO plan_runs(plan,due) VALUES(?,?)"),
 orderNew:db.prepare("INSERT INTO orders(id,session,coin,cu,cur,amount,mode,status,ref,created) VALUES(?,?,?,?,?,?,?,?,?,?)"),orderGet:db.prepare("SELECT * FROM orders WHERE id=?"),orderSet:db.prepare("UPDATE orders SET status=? WHERE id=?"),orderExpire:db.prepare("UPDATE orders SET status='expired' WHERE status='pending' AND created<?"),
 evNew:db.prepare("INSERT INTO webhook_events(id,type,ts) VALUES(?,?,?)"),depNew:db.prepare("INSERT INTO deposits(txid,address) VALUES(?,?)"),
 daNew:db.prepare("INSERT INTO deposit_addresses(address,session,coin,created) VALUES(?,?,?,?)"),daGet:db.prepare("SELECT session FROM deposit_addresses WHERE address=? AND coin=?"),daLatest:db.prepare("SELECT address FROM deposit_addresses WHERE session=? AND coin=? ORDER BY created DESC,rowid DESC LIMIT 1"),
 alNew:db.prepare("INSERT INTO allowlist(id,session,coin,address,label,active_after) VALUES(?,?,?,?,?,?)"),alGet:db.prepare("SELECT active_after FROM allowlist WHERE session=? AND coin=? AND address=?"),alList:db.prepare("SELECT id,coin,address addr,label,active_after activeAfter FROM allowlist WHERE session=? ORDER BY rowid"),alDel:db.prepare("DELETE FROM allowlist WHERE id=? AND session=?"),alCount:db.prepare("SELECT COUNT(*) n FROM allowlist WHERE session=?"),setOff:db.prepare("UPDATE sessions SET allow_off_at=? WHERE id=?"),
 idemGet:db.prepare("SELECT route,response FROM idem WHERE session=? AND key=?"),idemSet:db.prepare("INSERT OR IGNORE INTO idem(session,key,route,response,ts) VALUES(?,?,?,?,?)"),
 idle:db.prepare(`SELECT id FROM sessions WHERE last<? AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.session=sessions.id AND a.kind IN ('user','hold') AND a.balance>0) AND NOT EXISTS(SELECT 1 FROM holds h WHERE h.session=sessions.id AND h.status='held') AND NOT EXISTS(SELECT 1 FROM plans p WHERE p.session=sessions.id AND p.status='active')`),
 delSess:db.prepare("DELETE FROM sessions WHERE id=?"),delPlans:db.prepare("DELETE FROM plans WHERE session=?"),delIdem:db.prepare("DELETE FROM idem WHERE session=?")};
const acct=(s,asset,kind)=>{q.newAcct.run(s,asset,kind);return q.getAcct.get(s,asset,kind)};
/* Post one balanced transaction. legs = [[session,kind,asset,integerAmount]]. System accounts use session "".
   Every leg set must sum to zero per asset. `inTx` runs inside the same database transaction. */
function post(session,type,memo,legs,meta,inTx){legs=legs.filter(l=>l[3]!==0);const sums={};
 for(const l of legs){if(!Number.isSafeInteger(l[3]))bad("Amount is not valid.");sums[l[2]]=(sums[l[2]]||0)+l[3]}
 for(const a in sums)if(sums[a]!==0)throw new Error("unbalanced transaction");
 db.exec("BEGIN IMMEDIATE");
 try{const t=q.tx.run(session,type,memo,meta?JSON.stringify(meta):null,Date.now()).lastInsertRowid;
  for(const[s,k,asset,amt]of legs){const a=acct(s,asset,k);if(k==="user"&&a.balance+amt<0)bad("You do not have enough "+asset+".");q.entry.run(t,a.id,asset,amt);q.upd.run(amt,a.id)}
  if(inTx)inTx(t);db.exec("COMMIT");return t}
 catch(e){try{db.exec("ROLLBACK")}catch(_){}throw e}}
function ledgerCheck(){const un=db.prepare("SELECT tx,asset,SUM(amount) s FROM entries GROUP BY tx,asset HAVING s<>0").all().length,
 dr=db.prepare("SELECT a.id FROM accounts a WHERE a.balance<>COALESCE((SELECT SUM(amount) FROM entries e WHERE e.account=a.id),0)").all().length,
 tb=db.prepare("SELECT asset,SUM(amount) s FROM entries GROUP BY asset HAVING s<>0").all().length;return{ok:!un&&!dr&&!tb,unbalancedTransactions:un,balanceDrift:dr,trialBalanceErrors:tb}}
const balOf=s=>{const o={};for(const r of q.bals.all(s))o[r.asset]=r.balance/1e8;return o};
// ================= market data (sandbox random walk: replace with a real feed) =================
if(FEED==="sandbox")setInterval(()=>{for(const k in px)if(k!=="USDT"&&k!=="USDC")px[k]*=1+(Math.random()-.5)*.006;priceTs=Date.now()},2500).unref();
// ================= helpers =================
const rl=new Map();function limit(key,max,ms){const n=Date.now(),e=rl.get(key);if(!e||e.r<n){rl.set(key,{c:1,r:n+ms});return}if(++e.c>max)bad("Too many requests. Slow down.",429)}
setInterval(()=>{const n=Date.now();for(const[k,e]of rl)if(e.r<n)rl.delete(k)},6e4).unref();
const num=(v,min,max,name)=>{const x=typeof v==="string"?+v:v;if(typeof x!=="number"||!isFinite(x)||x<min||x>max)bad((name||"Amount")+" is not valid.");return x};
const need=(v,set,name)=>{if(typeof v!=="string"||!Object.prototype.hasOwnProperty.call(set,v))bad((name||"Value")+" is not supported.");return v};
const okAddr=(c,a)=>typeof a==="string"&&(RE[c]||EVM).test(a.trim());
const short=a=>a.slice(0,8)+"…"+a.slice(-6),id=p=>p+"-"+crypto.randomBytes(4).toString("hex").toUpperCase();
const limitUsd=(s,usd)=>{if(usd>TIERS[s.kyc])bad("Your verification tier allows up to $"+TIERS[s.kyc]+" per order. Verify to raise it.",403)};
const isAdmin=c=>{if(!ADMIN)bad("Not found.",404);const k=Buffer.from(String(c.hdr["x-admin-key"]||"")),e=Buffer.from(ADMIN);if(k.length!==e.length||!crypto.timingSafeEqual(k,e))bad("Forbidden.",403)};
// reserve -> provider -> finalize (or reverse). Funds are never lost between steps.
function reserve(s,coin,total,type,memo,meta,inTx){post(s.id,type,memo,[[s.id,"user",coin,-total],["","hold",coin,total]],meta,inTx)}
function reverse(s,coin,total){post(s.id,"reverse","Reversed a failed transfer",[["","hold",coin,-total],[s.id,"user",coin,total]])}
// ================= routes =================
const R={};
R["GET /health"]=()=>({ok:true,mode:MODE});
R["GET /prices"]=()=>({prices:px,fx:FIAT,ts:priceTs,source:FEED,stale:isStale(),mode:MODE});
R["GET /tor/status"]=c=>({tor:c.tor});
R["POST /session"]=c=>{limit("sess:"+c.ip,30,36e5);const token=crypto.randomBytes(24).toString("base64url"),h=sha(token),n=Date.now();q.newSess.run(h,n,n);
 if(MODE==="sandbox")for(const k in SEED)post(h,"grant","Sandbox starting balance",[["","grant",k,-U(SEED[k])],[h,"user",k,U(SEED[k])]]);
 return{token,bal:balOf(h),kyc:0,mode:MODE,tor:c.tor}};
R["GET /state"]=(c,b,s)=>({bal:balOf(s.id),hist:q.hist.all(s.id).map(r=>({t:r.memo,d:new Date(r.ts).toISOString()})),kyc:s.kyc,
 plans:q.planList.all(s.id).map(r=>{const d=JSON.parse(r.data);return{id:r.id,c:d.c,a:d.a,cur:d.cur,f:d.f,mode:d.mode,next:new Date(r.next_run).toLocaleDateString("en-IN"),status:r.status,error:d.last_error||null}}),
 holds:q.holdList.all(s.id).map(h=>({id:h.id,coin:h.coin,amount:h.amount/1e8,fee:h.fee/1e8,to:h.to,until:h.until})),addrs:q.alList.all(s.id),settings:{allowlistOnly:s.allow_off_at==null||s.allow_off_at>Date.now(),offAt:s.allow_off_at},mode:MODE});
R["POST /kyc"]=(c,b,s)=>{const t=num(b.tier,1,2,"Tier");providers.kyc({tier:t});const k=Math.max(s.kyc,t);q.setKyc.run(k,s.id);return{kyc:k}};
R["POST /orders"]=(c,b,s)=>{fresh();const cur=need(b.currency,FIAT,"Currency"),coin=need(b.coin,px,"Coin"),amount=num(b.amount,1,1e8),m=MODES[b.mode];
 if(!m||(m.cur&&m.cur!==cur))bad("That payment mode is not available for "+cur+".");
 const usd=amount*FIAT[cur];if(usd<10)bad("The minimum order is about $10.");limitUsd(s,usd);
 if(b.mode==="Gift card"&&String(b.gift||"").replace(/\W/g,"").length<8)bad("Enter a valid gift card code.");
 const fee=amount*m.fee/100,cu=U((amount-fee)*FIAT[cur]/px[coin]);
 if(b.expectCoins!=null){const e=+b.expectCoins;if(!(e>0)||Math.abs(cu/1e8/e-1)>.015)bad("The price changed. Review the new price and try again.",409)}
 const oid=id("ORD"),pay=providers.charge({order:oid,mode:b.mode,amount,cur,gift:b.gift});
 if(pay.status==="pending"){q.orderNew.run(oid,s.id,coin,cu,cur,amount,b.mode,"pending",pay.ref,Date.now());return{id:oid,status:"pending",checkout:pay.checkout||null,bal:balOf(s.id)}}   // coins arrive when the payment webhook confirms
 post(s.id,"buy","Bought "+cu/1e8+" "+coin,[["","market",coin,-cu],[s.id,"user",coin,cu]],{oid,currency:cur,amount,mode:b.mode,fee,pay:pay.ref},()=>q.orderNew.run(oid,s.id,coin,cu,cur,amount,b.mode,"captured",pay.ref,Date.now()));
 return{id:oid,status:"captured",coins:cu/1e8,pay:pay.ref,bal:balOf(s.id)}};
R["POST /swaps"]=(c,b,s)=>{fresh();const f=need(b.from,px,"Coin"),t=need(b.to,px,"Coin"),a=num(b.amount,1e-8,MAXC);if(f===t)bad("Pick two different coins.");limitUsd(s,a*px[f]);
 const au=U(a),gross=U(a*px[f]/px[t]),out=Math.floor(gross*.995),fee=gross-out;if(out<=0)bad("Amount is too small.");
 if(b.expectOut!=null){const e=+b.expectOut;if(!(e>0)||Math.abs(out/1e8/e-1)>.015)bad("The price changed. Review the new price and try again.",409)}
 const sid=id("SWP");post(s.id,"swap","Swapped "+a+" "+f+" to "+out/1e8+" "+t,[[s.id,"user",f,-au],["","market",f,au],["","market",t,-(out+fee)],[s.id,"user",t,out],["","fees",t,fee]],{sid});
 return{id:sid,out:out/1e8,bal:balOf(s.id)}};
R["POST /sends"]=(c,b,s)=>{fresh();const coin=need(b.coin,px,"Coin"),a=num(b.amount,1e-8,MAXC),tier=need(b.fee||"Standard",FEES,"Fee"),addr=b.address;
 if(!okAddr(coin,addr))bad("That is not a valid "+coin+" address.");const usd=a*px[coin];limitUsd(s,usd);
 if(s.allow_off_at==null||s.allow_off_at>Date.now()){const al=q.alGet.get(s.id,coin,addr.trim());if(!al)bad("Your safety setting only allows saved addresses. Save this address first.",403);
  if(al.active_after>Date.now())bad("This address was added recently. You can send to it after "+new Date(al.active_after).toISOString()+".",403)}
 const au=U(a),fu=U(FEES[tier]/px[coin]),total=au+fu,to=short(addr.trim()),sid=id("SND"),held=usd>HOLD_USD,until=Date.now()+HOLD_MS;
 if(held){reserve(s,coin,total,"send","Sent "+a+" "+coin+" to "+to+" (24-hour hold)",{sid},()=>q.holdNew.run(sid,s.id,coin,au,fu,addr.trim(),until));return{id:sid,held:true,until,bal:balOf(s.id)}}
 reserve(s,coin,total,"reserve","Reserved for a transfer",{sid});
 let tx;try{tx=providers.broadcast({coin,a,addr:addr.trim()})}catch(e){reverse(s,coin,total);throw e}
 post(s.id,"send","Sent "+a+" "+coin+" to "+to,[["","hold",coin,-total],["","external",coin,au],["","fees",coin,fu]],{sid,txid:tx.txid});return{id:sid,held:false,bal:balOf(s.id)}};
R["POST /sends/cancel"]=(c,b,s)=>{const h=q.holdGet.get(String(b.id||""),s.id);if(!h)bad("No such held transfer.",404);if(Date.now()>h.until)bad("The hold period has ended.",409);
 post(s.id,"cancel","Cancelled held transfer "+h.id,[["","hold",h.asset,-(h.amount+h.fee)],[s.id,"user",h.asset,h.amount+h.fee]],null,()=>q.holdSet.run("cancelled",h.id));return{bal:balOf(s.id)}};
R["POST /sells"]=(c,b,s)=>{fresh();const coin=need(b.coin,px,"Coin"),a=num(b.amount,1e-8,MAXC),m=b.mode,p=b.payout||{};
 const net=a*px[coin]/FIAT.INR*.99;limitUsd(s,a*px[coin]);if(net<100)bad("The minimum payout is ₹100.");
 if(m==="UPI"){if(net>1e5)bad("UPI payouts are limited to ₹1,00,000.");if(!/^[\w.\-]{2,256}@[A-Za-z]{2,64}$/.test(String(p.upi||"").trim()))bad("Enter a valid UPI ID.")}
 else if(m==="IMPS"||m==="RTGS"){if(m==="IMPS"&&net>5e5)bad("IMPS payouts are limited to ₹5,00,000.");if(m==="RTGS"&&net<2e5)bad("RTGS needs at least ₹2,00,000.");
  if(String(p.name||"").trim().length<2)bad("Enter the account holder name.");if(!/^\d{9,18}$/.test(String(p.account||"")))bad("Account numbers have 9 to 18 digits.");if(!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(String(p.ifsc||"").trim()))bad("Enter a valid IFSC code.")}
 else bad("That payout method is not supported.");
 const au=U(a),sid=id("OUT");reserve(s,coin,au,"reserve","Reserved for a sale",{sid});
 let o;try{o=providers.payout({mode:m,net,payout:p})}catch(e){reverse(s,coin,au);throw e}   // payout details are passed to the provider and never stored
 const n2=Math.round(net*100)/100;post(s.id,"sell","Sold "+a+" "+coin+" for ₹"+Math.round(net)+" via "+m,[["","hold",coin,-au],["","market",coin,au]],{sid,net:n2,mode:m,ref:o.ref});
 return{id:sid,net:n2,ref:o.ref,bal:balOf(s.id)}};
R["POST /mixes"]=(c,b,s)=>{if(MODE==="live")bad("Mixing is not offered on this service.",403);   // sandbox only: moves test balances and mixes nothing
 const coin=need(b.coin,px,"Coin"),a=num(b.amount,1e-8,MAXC),n=num(b.rounds,1,5,"Rounds");if(!okAddr(coin,b.dest))bad("That is not a valid "+coin+" address.");
 const au=U(a),mid=id("MIX");post(s.id,"mix","Sandbox mix of "+a+" "+coin+" ("+n+" rounds)",[[s.id,"user",coin,-au],["","sink",coin,au]],{mid});return{id:mid,bal:balOf(s.id)}};
R["POST /admin/deposit"]=(c,b)=>{isAdmin(c);const h=sha(String(b.token||""));if(!q.sess.get(h))bad("No such session.",404);const coin=need(b.coin,px,"Coin"),a=num(b.amount,1e-8,MAXC),au=U(a);
 post(h,"deposit","Deposit of "+a+" "+coin,[["","external",coin,-au],[h,"user",coin,au]]);return{bal:balOf(h)}};
R["GET /admin/ledger-check"]=c=>{isAdmin(c);return ledgerCheck()};
// ================= price feed (real market data, with sanity checks and staleness guard) =================
let priceTs=FEED==="sandbox"?Date.now():0,seeded=FEED==="sandbox";
const isStale=()=>FEED!=="sandbox"&&Date.now()-priceTs>STALE_MS;
function fresh(){if(isStale())bad("Prices are temporarily unavailable. Try again in a minute.",503)}
function applyFeed(p,f){let n=0;const take=(tbl,k,v,lo,hi)=>{if(!(v>0))return;if(lo&&(v<lo||v>hi))return;if(seeded&&Math.abs(v/tbl[k]-1)>.25){console.warn("feed: rejected a jump for",k,tbl[k],"->",v);return}tbl[k]=v;n++};
 for(const k in p)if(k in px)take(px,k,p[k],k==="USDT"||k==="USDC"?.9:0,1.1);for(const k in f)if(k in FIAT&&k!=="USD")take(FIAT,k,f[k]);
 if(n){seeded=true;priceTs=Date.now()}return n}
async function pollFeed(){try{const p=await feeds.coingecko();let f={};try{f=await feeds.fx(Object.keys(FIAT))}catch(e){console.warn("fx feed:",e.message)}applyFeed(p,f)}catch(e){console.error("price feed:",e.message)}}
// ================= address book allowlist, deposit addresses, recurring buys =================
R["POST /deposit-address"]=(c,b,s)=>{const coin=need(b.coin,px,"Coin");let row=q.daLatest.get(s.id,coin);
 if(!row||b.fresh===true){limit("addr:"+s.id,20,864e5);const a=providers.newAddress({coin,session:s.id});if(!okAddr(coin,a.address))throw new Error("provider returned an invalid address");q.daNew.run(a.address,s.id,coin,Date.now());row={address:a.address}}
 return{coin,address:row.address}};
R["POST /addresses"]=(c,b,s)=>{const coin=need(b.coin,px,"Coin"),addr=String(b.address||"").trim(),label=String(b.label||"").trim();
 if(!okAddr(coin,addr))bad("That is not a valid "+coin+" address.");if(label.length<1||label.length>24)bad("Give the address a name (up to 24 characters).");
 if(q.alCount.get(s.id).n>=100)bad("You have too many saved addresses.");const aid=/^[\w-]{6,40}$/.test(String(b.id||""))?String(b.id):id("ADR"),after=Date.now()+COOLDOWN;
 try{q.alNew.run(aid,s.id,coin,addr,label,after)}catch(e){if(/UNIQUE/.test(e.message))bad("That address is already saved.",409);throw e}return{id:aid,activeAfter:after}};
R["POST /addresses/delete"]=(c,b,s)=>{q.alDel.run(String(b.id||""),s.id);return{ok:true}};
R["POST /settings"]=(c,b,s)=>{if(typeof b.allowlistOnly!=="boolean")bad("Invalid setting.");const at=b.allowlistOnly?null:Date.now()+COOLDOWN;q.setOff.run(at,s.id);return{allowlistOnly:b.allowlistOnly,effectiveAt:at||Date.now()}};   // turning the rule OFF waits ADDR_COOLDOWN_MS
const nextDue=(t,f)=>{if(f==="Monthly"){const d=new Date(t);d.setUTCMonth(d.getUTCMonth()+1);return d.getTime()}return t+(f==="Weekly"?7:14)*864e5};
R["POST /plans"]=(c,b,s)=>{const coin=need(b.c,px,"Coin"),cur=need(b.cur,FIAT,"Currency"),amt=num(b.a,1,1e8),f=need(b.f,{Weekly:1,"Every 2 weeks":1,Monthly:1},"Frequency"),m=b.mode||(cur==="INR"?"UPI":"Card"),mm=MODES[m];
 if(!mm||(mm.cur&&mm.cur!==cur)||m==="Gift card")bad("That payment mode cannot be used for recurring buys.");if(amt*FIAT[cur]<10)bad("The minimum is about $10 per buy.");if(q.planCount.get(s.id).n>=20)bad("You have too many plans.");
 const pid=id("PLN"),nx=nextDue(Date.now(),f);q.planNew.run(pid,s.id,JSON.stringify({id:pid,c:coin,a:amt,cur,f,mode:m}),nx);return{id:pid,next:nx}};
R["POST /plans/cancel"]=(c,b,s)=>{q.planCancel.run(String(b.id||""),s.id);return{ok:true}};
// Exactly-once recurring buys: the ledger entry, the run marker and the schedule advance commit in ONE database transaction.
function runPlans(now){now=now||Date.now();let ran=0;
 for(const p of q.planDue.all(now)){let d;try{d=JSON.parse(p.data)}catch(e){continue}const s=q.sess.get(p.session);if(!s)continue;
  let nx=nextDue(p.next_run,d.f);while(nx<=now)nx=nextDue(nx,d.f);          // missed periods are skipped, never bought in bulk
  if(q.runGet.get(p.id,p.next_run)){q.planAdv.run(nx,p.id);continue}
  try{fresh();const m=d.mode||(d.cur==="INR"?"UPI":"Card"),mm=MODES[m],usd=d.a*FIAT[d.cur];limitUsd(s,usd);
   const fee=d.a*mm.fee/100,cu=U((d.a-fee)*FIAT[d.cur]/px[d.c]),oid=id("REC"),pay=providers.chargeRecurring({plan:p.id,due:p.next_run,order:oid,amount:d.a,cur:d.cur,mode:m});
   const mark=st=>{q.runNew.run(p.id,p.next_run);q.orderNew.run(oid,s.id,d.c,cu,d.cur,d.a,m,st,pay.ref,now);q.planAdv.run(nx,p.id)};
   if(pay.status==="pending"){db.exec("BEGIN IMMEDIATE");try{mark("pending");db.exec("COMMIT")}catch(e){try{db.exec("ROLLBACK")}catch(_){}throw e}}
   else post(s.id,"buy","Recurring buy: "+cu/1e8+" "+d.c,[["","market",d.c,-cu],[s.id,"user",d.c,cu]],{oid,plan:p.id,mode:m},()=>mark("captured"));ran++}
  catch(e){const fails=p.fails+1,pause=fails>=3;d.last_error=String(e.message).slice(0,120);q.planFail.run(fails,pause?"paused":"active",pause?p.next_run:now+36e5,JSON.stringify(d),p.id);console.error("recurring buy failed:",p.id,e.message)}}
 return ran}
R["POST /admin/run-scheduler"]=c=>{isAdmin(c);return{ran:runPlans()}};
// ================= webhooks (HMAC-signed, replay-protected, idempotent) =================
function rawBody(req){return new Promise((ok,no)=>{let n=0,c=[];req.on("data",d=>{n+=d.length;if(n>65536){no(new HttpError(413,"Request too large."));req.destroy();return}c.push(d)});req.on("end",()=>ok(Buffer.concat(c).toString()));req.on("error",no)})}
function handleEvent(route,ev){const d=ev.data||{},evIns=()=>q.evNew.run(ev.id,ev.type,Date.now());
 try{
  if(route==="payment"){const o=q.orderGet.get(String(d.order_id||""));if(!o)bad("Unknown order.",404);
   if(ev.type==="payment.captured"){if(o.status!=="pending")return{ok:true,duplicate:true};if(+d.amount!==o.amount||d.currency!==o.cur)bad("Amount or currency does not match the order.",422);
    post(o.session,"buy","Bought "+o.cu/1e8+" "+o.coin,[["","market",o.coin,-o.cu],[o.session,"user",o.coin,o.cu]],{oid:o.id,ref:o.ref,webhook:ev.id},()=>{evIns();q.orderSet.run("captured",o.id)});return{ok:true}}
   if(ev.type==="payment.failed"){if(o.status!=="pending")return{ok:true,duplicate:true};db.exec("BEGIN IMMEDIATE");try{evIns();q.orderSet.run("failed",o.id);db.exec("COMMIT")}catch(e){try{db.exec("ROLLBACK")}catch(_){}throw e}return{ok:true}}
   return{ok:true,ignored:true}}
  if(route==="deposit"){if(ev.type!=="deposit.confirmed")return{ok:true,ignored:true};const coin=need(d.coin,px,"Coin"),a=num(d.amount,1e-8,MAXC),addr=String(d.address||""),tx=String(d.txid||"");
   if(!tx||tx.length>100)bad("Missing txid.");if(!(+d.confirmations>=CONFS))return{ok:true,pending:true};const row=q.daGet.get(addr,coin);if(!row)bad("Unknown deposit address.",404);
   const au=U(a);post(row.session,"deposit","Deposit of "+a+" "+coin,[["","external",coin,-au],[row.session,"user",coin,au]],{txid:tx,webhook:ev.id},()=>{evIns();q.depNew.run(tx,addr)});return{ok:true}}
  bad("Not found.",404)}
 catch(e){if(/UNIQUE constraint failed: (webhook_events|deposits)/.test(e.message||""))return{ok:true,duplicate:true};throw e}}
async function webhook(req,res,route){try{if(req.method!=="POST"||!WEBHOOK_SECRET)bad("Not found.",404);limit("wh:"+(req.socket.remoteAddress||"?"),600,6e4);
 const raw=await rawBody(req),ts=+req.headers["x-timestamp"];if(!isFinite(ts)||Math.abs(Date.now()-ts)>3e5)bad("Missing or stale timestamp.");
 const A1=Buffer.from(String(req.headers["x-signature"]||"")),B1=Buffer.from(crypto.createHmac("sha256",WEBHOOK_SECRET).update(ts+"."+raw).digest("hex"));
 if(A1.length!==B1.length||!crypto.timingSafeEqual(A1,B1))bad("Bad signature.",401);
 let ev;try{ev=JSON.parse(raw)}catch(e){bad("Invalid JSON.")}if(!ev||typeof ev.id!=="string"||ev.id.length>80||typeof ev.type!=="string")bad("Invalid event.");
 send(res,200,handleEvent(route,ev))}
 catch(e){const st=e.status||500;if(st===500)console.error(e);send(res,st,{error:st===500?"Something went wrong on the server.":e.message})}}
const OPEN=new Set(["GET /health","GET /prices","GET /tor/status","POST /session","POST /admin/deposit","GET /admin/ledger-check","POST /admin/run-scheduler"]);
// release held transfers whose 24h window ended
function releaseHolds(){for(const h of q.holdDue.all(Date.now())){try{const tx=providers.broadcast({coin:h.asset,a:h.amount/1e8,addr:h.dest});
 post(h.session,"release","Released held transfer "+h.id,[["","hold",h.asset,-(h.amount+h.fee)],["","external",h.asset,h.amount],["","fees",h.asset,h.fee]],{txid:tx.txid},()=>q.holdSet.run("released",h.id))}catch(e){console.error("release failed for",h.id,e.message)}}}
function prune(){q.orderExpire.run(Date.now()-36e5);const cut=Date.now()-30*864e5;for(const r of q.idle.all(cut)){q.delPlans.run(r.id);q.delIdem.run(r.id);q.delSess.run(r.id)}}   // the ledger itself is never pruned
// ================= http plumbing =================
function send(res,code,obj,h){const body=JSON.stringify(obj);res.writeHead(code,Object.assign({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(body)},h));res.end(body)}
const SEC={"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
function body(req){return new Promise((ok,no)=>{let n=0,c=[],big=false;req.on("data",d=>{n+=d.length;if(n>1e6)return req.destroy();if(n>2e4){big=true;c=[]}else if(!big)c.push(d)});req.on("end",()=>{if(big)return no(new HttpError(413,"Request too large."));if(!c.length)return ok({});try{const j=JSON.parse(Buffer.concat(c).toString());ok(j&&typeof j==="object"?j:{})}catch(e){no(new HttpError(400,"Invalid JSON."))}})})}
async function api(req,res,route,tor){const ip=req.socket.remoteAddress||"?",hdr=req.headers,h={};
 if(ORIGIN){h["Access-Control-Allow-Origin"]=ORIGIN;h["Vary"]="Origin";h["Access-Control-Allow-Headers"]="Authorization, Content-Type, Idempotency-Key";h["Access-Control-Allow-Methods"]="GET, POST, OPTIONS"}
 if(req.method==="OPTIONS")return send(res,204,{},h);
 try{const key=req.method+" "+route,fn=R[key];if(!fn)bad("Not found.",404);
  let s=null;if(!OPEN.has(key)){const m=/^Bearer ([\w-]{20,64})$/.exec(hdr.authorization||"");if(!m)bad("Missing or invalid session.",401);s=q.sess.get(sha(m[1]));if(!s)bad("Session expired. Reload the page.",401);q.touch.run(Date.now(),s.id);limit("tok:"+m[1],120,6e4)}
  else limit("ip:"+ip,300,6e4);
  const b=req.method==="POST"?await body(req):{},ik=s&&req.method==="POST"&&/^[\w-]{8,64}$/.test(hdr["idempotency-key"]||"")?hdr["idempotency-key"]:null;
  if(ik){const prev=q.idemGet.get(s.id,ik);if(prev){if(prev.route!==key)bad("That Idempotency-Key was used for a different request.",422);return send(res,200,JSON.parse(prev.response),Object.assign({"Idempotent-Replay":"true"},h))}}
  const out=fn({ip,tor,hdr},b,s);if(ik)q.idemSet.run(s.id,ik,key,JSON.stringify(out),Date.now());send(res,200,out,h)}
 catch(e){let st=e.status||500,m=e.message;if(/CHECK constraint failed: kind/.test(m||"")){st=400;m="You do not have enough funds."}if(st===500)console.error(e);send(res,st,{error:st===500?"Something went wrong on the server.":m},h)}}
const TYPES={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".json":"application/json",".txt":"text/plain"};
function stat(req,res,p){if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,SEC);return res.end()}
 let f;try{f=path.normalize(path.join(PUB,decodeURIComponent(p==="/"?"/index.html":p)))}catch(e){res.writeHead(400,SEC);return res.end()}
 if(!f.startsWith(PUB+path.sep)){res.writeHead(403,SEC);return res.end()}
 fs.readFile(f,(e,d)=>{if(e){res.writeHead(404,Object.assign({"Content-Type":"text/plain"},SEC));return res.end("Not found")}
  res.writeHead(200,Object.assign({"Content-Type":TYPES[path.extname(f)]||"application/octet-stream","Cache-Control":"no-cache"},SEC));res.end(req.method==="HEAD"?undefined:d)})}
const mk=tor=>http.createServer((req,res)=>{const p=new URL(req.url,"http://x").pathname;if(p.startsWith("/api/webhooks/"))return webhook(req,res,p.slice(14));if(p.startsWith("/api/"))return api(req,res,p.slice(4),tor);stat(req,res,p)});
if(require.main===module){
 const c=ledgerCheck();if(!c.ok){console.error("Ledger integrity check FAILED. Refusing to start.",c);process.exit(1)}
 if(MODE==="live"&&FEED==="sandbox"){console.error("MODE=live cannot use the sandbox price feed. Set PRICE_FEED=coingecko.");process.exit(1)}
 releaseHolds();prune();runPlans();setInterval(releaseHolds,6e4).unref();setInterval(prune,36e5).unref();setInterval(runPlans,6e4).unref();
 if(FEED==="coingecko"){pollFeed();setInterval(pollFeed,FEED_MS).unref()}
 if(MODE==="live"&&!WEBHOOK_SECRET)console.warn("Note: WEBHOOK_SECRET is not set, so payment and deposit webhooks are disabled.");
 if(MODE==="live"&&!ADMIN)console.warn("Note: ADMIN_KEY is not set, so admin endpoints are disabled.");
 mk(false).listen(PORT,process.env.HOST||"127.0.0.1",()=>console.log("Game Exchanger API on http://127.0.0.1:"+PORT+"  mode="+MODE+"  db="+DB_FILE+"  ledger=ok"));
 if(TOR_PORT)mk(true).listen(TOR_PORT,"127.0.0.1",()=>console.log("Tor-only listener on 127.0.0.1:"+TOR_PORT+" (point your onion service here)"));
}
module.exports={mk,ledgerCheck};
