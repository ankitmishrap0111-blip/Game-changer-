"use strict";
// Provider adapters. In sandbox mode they simulate success. In live mode they refuse until you
// replace each one with a real, licensed integration (payment gateway, blockchain node, bank payout, KYC).
class NotConfigured extends Error{constructor(what){super(what+" is not configured. Live mode needs a licensed partner for this step.");this.status=501}}
const live=()=>process.env.MODE==="live";
const R=(a,n)=>{let s="";for(let i=0;i<n;i++)s+=a[crypto.randomInt(a.length)];return s},crypto=require("crypto");
const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",BEC="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const fake=c=>({BTC:"bc1q"+R(BEC,38),LTC:"ltc1q"+R(BEC,38),XMR:"8"+R(B58,94),SOL:R(B58,44),XRP:"r"+R(B58,33),DOGE:"D"+R(B58,33),TRX:"T"+R(B58,33),ADA:"addr1"+R("0123456789abcdefghjklmnpqrstuvwxyz",98),DOT:"1"+R(B58,47),BCH:"bitcoincash:q"+R(BEC,41),ZEC:"t1"+R(B58,33)}[c]||"0x"+R("0123456789abcdef",40));
const ref=p=>p+"_"+require("crypto").randomBytes(5).toString("hex");
module.exports={
  // Collect money from the customer (e.g. Razorpay order + webhook). Return {ref}.
  // Start a payment. Return {ref, status:"captured"} if paid instantly, or {ref, status:"pending", checkout:url}
  // and confirm later through POST /api/webhooks/payment (signed with WEBHOOK_SECRET).
  charge(o){if(live())throw new NotConfigured("The payment gateway");const a=process.env.PAYMENT_ASYNC==="1";return{ref:ref("pay"),status:a?"pending":"captured",checkout:a?"https://pay.example.invalid/checkout/"+o.order:null}},
  // Charge a saved mandate (UPI AutoPay, card-on-file) for a recurring buy. Use o.plan+o.due as the provider idempotency key.
  chargeRecurring(o){if(live())throw new NotConfigured("The recurring-payment (autopay) mandate");return{ref:ref("rec"),status:"captured"}},
  // Issue a fresh deposit address for a customer. Report deposits via POST /api/webhooks/deposit.
  newAddress(o){if(live())throw new NotConfigured("The deposit-address service (wallet or node)");return{address:fake(o.coin)}},
  // Broadcast an on-chain transaction from your hot wallet or signing service. Return {txid}.
  broadcast(o){if(live())throw new NotConfigured("The blockchain signing service");return{txid:ref("tx")}},
  // Pay out INR to a UPI ID or bank account (e.g. RazorpayX). Return {ref}.
  payout(o){if(live())throw new NotConfigured("The INR payout partner");return{ref:ref("out")}},
  // Identity verification (e.g. a KYC provider). Return {tier}.
  kyc(o){if(live())throw new NotConfigured("The identity verification provider");return{tier:o.tier}},
  NotConfigured
};
