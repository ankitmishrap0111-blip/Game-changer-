"use strict";
// Market-data adapters. Both use only built-in fetch, with a timeout. Replace or add sources as you like.
const CG={BTC:"bitcoin",ETH:"ethereum",XMR:"monero",USDT:"tether",USDC:"usd-coin",LTC:"litecoin",BNB:"binancecoin",SOL:"solana",XRP:"ripple",DOGE:"dogecoin",ADA:"cardano",TRX:"tron",DOT:"polkadot",AVAX:"avalanche-2",BCH:"bitcoin-cash",ZEC:"zcash"};
async function get(url,headers){const c=new AbortController(),t=setTimeout(()=>c.abort(),8000);
 try{const r=await fetch(url,{headers,signal:c.signal});if(!r.ok)throw new Error("HTTP "+r.status+" from "+new URL(url).host);return await r.json()}finally{clearTimeout(t)}}
// USD price per coin. Free tier: https://api.coingecko.com . Paid: set COINGECKO_URL=https://pro-api.coingecko.com and COINGECKO_KEY.
async function coingecko(){const base=process.env.COINGECKO_URL||"https://api.coingecko.com",key=process.env.COINGECKO_KEY;
 const j=await get(base+"/api/v3/simple/price?ids="+Object.values(CG).join(",")+"&vs_currencies=usd",key?{"x-cg-pro-api-key":key}:{}),out={};
 for(const k in CG){const v=j&&j[CG[k]]&&j[CG[k]].usd;if(typeof v==="number"&&v>0)out[k]=v}
 if(!Object.keys(out).length)throw new Error("price feed returned no usable prices");return out}
// USD value of one unit of each currency. The default source returns "units per 1 USD", so we invert it.
async function fx(list){const j=await get(process.env.FX_URL||"https://open.er-api.com/v6/latest/USD"),out={};
 if(j.result&&j.result!=="success")throw new Error("fx feed error");
 for(const c of list){const r=j.rates&&j.rates[c];if(typeof r==="number"&&r>0)out[c]=1/r}return out}
module.exports={coingecko,fx,CG};
