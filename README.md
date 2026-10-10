# Game Exchanger

One folder, three parts. Nothing here has changed since the last version; this is only the final packaging.

```
game-exchanger/
  README.md                 this file
  frontend/
    index.html              the app on its own (preview mode, no server needed): just double-click it
  backend/
    server.js               API, SQLite double-entry ledger, webhooks, scheduler, price feed
    providers.js            the 6 places YOU plug in real partners (payments, payouts, KYC, blockchain, addresses)
    feeds.js                market-data adapters (CoinGecko + FX)
    test.js                 108 tests
    package.json  .env.example
    public/index.html       the same app, already connected to the backend (CONFIG.MOCK=false, API_BASE=/api)
```

## Quick start
```
# 1. Just look at the app (preview mode, fake data, nothing is saved or sent):
open frontend/index.html

# 2. Run the real backend with the connected app (needs Node 22.5 or newer):
cd backend
node server.js            # then open http://127.0.0.1:8787
node test.js              # run the 108 tests
```
`frontend/index.html` and `backend/public/index.html` are the same app. They differ only in two values at the top of the script:
`CONFIG.MOCK` (true = preview, false = talk to the server) and `CONFIG.API_BASE` ("" or "/api").
All paths below are inside `backend/`.

No npm packages. **Needs Node 22.5 or newer** (it uses the built-in `node:sqlite`).

```
node server.js          # then open http://127.0.0.1:8787
node test.js            # 108 tests (ledger, webhooks, scheduler, price feed, allowlist, limits, concurrency, restart)
```

The server serves the frontend (`public/index.html`) and the API (`/api/...`) from the **same origin**:
no CORS, no third-party requests, and it works unchanged behind a Tor onion service.

## Storage: SQLite with an append-only double-entry ledger
- Every money movement is one **transaction** made of **entries** that must sum to zero per asset. An unbalanced transaction is refused.
- `entries` and `transactions` are **append-only**: database triggers block UPDATE and DELETE. Corrections are new reversing transactions.
- User balances can never go negative (CHECK constraint **and** a check inside the transaction). Parallel requests cannot overspend (tested).
- System accounts: `market` (counterparty for buys, sells, swaps), `fees`, `external` (outside the platform), `hold` (reserved funds), `grant`/`sink` (sandbox only).
- Sends and sells use **reserve, provider call, finalize (or reverse)**, so funds are never lost if a provider fails mid-way.
- Large sends (above $1,000) sit in `hold` for 24 hours, can be cancelled, and are released automatically (on a timer and at startup).
- `GET /api/admin/ledger-check` (needs `ADMIN_KEY`) re-proves the books: every transaction balanced, every account balance equals the sum of its entries, every asset's trial balance is zero.
  The server runs this at startup and **refuses to start** if it fails.
- `Idempotency-Key` header on POSTs: a retried request returns the original result and never double-charges.
- Fiat is recorded in transaction metadata only. When you add a payment provider, add fiat settlement accounts to the ledger.

## What is connected
| Frontend action | Endpoint | Server-side checks |
|---|---|---|
| Open the app | `POST /session` | Anonymous token (stored hashed). No email, phone or password. |
| Buy | `POST /orders` | Currency/mode rules, $10 minimum, tier limit, gift-code length, price-moved check (409 if more than 1.5% off) |
| Swap | `POST /swaps` | Balance, tier limit, price-moved check, 0.5% fee to `fees` |
| Send | `POST /sends` | Per-coin address format, balance + fee, tier limit, 24h hold above $1,000 |
| Cancel a held send | `POST /sends/cancel` | Refund only inside the hold window |
| Sell to INR | `POST /sells` | UPI/IMPS/RTGS limits and formats. **Payout details go to the provider and are never stored.** |
| Recurring buy | `POST /plans` | Validation, 20-plan cap (plans are saved, not executed: add a scheduler) |
| Verification | `POST /kyc` | Calls `providers.kyc()` |
| Prices | `GET /prices` | Sandbox random walk. Replace with a real feed. |
| Tor check | `GET /tor/status` | `true` only if the request came in on `TOR_PORT` |
| Received alerts | `GET /state` (polled) | Frontend alerts when a balance rises that the user did not cause |
| Test deposit | `POST /admin/deposit` | Needs `ADMIN_KEY` |
| Deposit address | `POST /deposit-address` | One address per coin until `{fresh:true}`; 20 new per day. Calls `providers.newAddress()` |
| Saved addresses | `POST /addresses`, `POST /addresses/delete`, `POST /settings` | **Enforced on `/sends` by the server.** See "Saved-address rule" |
| Cancel a plan | `POST /plans/cancel` | Own plans only |
| Payment confirmation | `POST /webhooks/payment` | Signed. See "Webhooks" |
| Deposit confirmation | `POST /webhooks/deposit` | Signed. See "Webhooks" |
| Run the scheduler now | `POST /admin/run-scheduler` | Needs `ADMIN_KEY` (for tests and ops) |
| Mix | `POST /mixes` | **Sandbox only.** Moves test balances and mixes nothing. 403 in live mode. |

Frontend switch: `CONFIG.MOCK=false` and `CONFIG.API_BASE="/api"` at the top of the script (already set in `public/index.html`).

## Webhooks (payment and deposit confirmations)
Set `WEBHOOK_SECRET`. Your provider (or a small adapter in front of it) must send `POST /api/webhooks/payment` or `/api/webhooks/deposit` with:
```
X-Timestamp: <ms since epoch>
X-Signature: hex( HMAC-SHA256( WEBHOOK_SECRET, timestamp + "." + rawBody ) )
body: {"id":"evt_123","type":"payment.captured","data":{"order_id":"ORD-...","amount":2000,"currency":"INR"}}
```
- `payment.captured` credits the coins locked at order time, only if amount and currency match. `payment.failed` closes the order. A failed order can never be credited later.
- `deposit.confirmed` with `{coin,address,amount,txid,confirmations}` credits once at `DEPOSIT_CONFIRMATIONS` or more. Fewer returns `{pending:true}` and records nothing, so the provider can resend.
- Signatures are compared in constant time. Events older than 5 minutes are refused (replay protection). Event ids and `(txid,address)` pairs are unique, so duplicates are harmless.
- Real gateways have their own signature formats (Razorpay and others). Put an adapter in front that verifies theirs and re-signs for this endpoint, or edit `webhook()`.
- Pending orders expire after 1 hour.

## Recurring buys
A scheduler (every 60 s, and at startup) runs due plans. The ledger entry, the "already ran" marker and the next-due date commit in **one database transaction**, so a crash or restart cannot double-buy or skip.
Missed periods are skipped, not bought in bulk. A failing plan retries after 1 hour and is **paused after 3 failures** with the reason shown (`status:"paused"`).
It calls `providers.chargeRecurring()` (use `plan` + `due` as the provider idempotency key). Gift cards cannot fund recurring buys.

## Market data
`PRICE_FEED=coingecko` polls CoinGecko (USD prices) and an FX source (inverted to USD per unit). Safeguards: first load accepted, later moves over 25% in one tick are **rejected as bad data**, stablecoins outside $0.90 to $1.10 are rejected, and if no valid update arrives within `STALE_MS` every price-dependent money step returns **503** instead of trading on old prices. Live mode refuses to start on the sandbox feed.
The adapters were tested against local mock servers that copy the response shapes. They have not been run against the real services from this build environment, so check them once with your own key. CoinGecko's free tier has rate limits and terms for commercial use, so use a paid plan in production.

## Saved-address rule (server-side)
`/sends` refuses any address that is not in the session's saved list while the rule is on (default on). With `ADDR_COOLDOWN_MS` set, a new address cannot be used until the cooldown ends, and turning the rule off also waits that long, which blunts an attacker who gets a session token. Deleting an address is immediate.

## Sandbox vs live
- `MODE=sandbox` (default): test balances, simulated payments and transfers. The page shows a "Sandbox mode" banner.
- `MODE=live`: **refuses every money step with 501** until you implement `providers.js`:
  `charge()` (payment gateway), `broadcast()` (signing service or node), `payout()` (INR payout partner), `kyc()` (identity provider).
  Check each provider's terms first: many payment processors do not allow crypto-exchange businesses.
  Nothing in this package moves real money, and it should not until those pieces are real, audited and licensed.

## Tor onion service
```
HiddenServiceDir /var/lib/tor/gx/
HiddenServicePort 80 127.0.0.1:8788      # TOR_PORT
```
Run with `TOR_PORT=8788`, then put the `.onion` address in `CONFIG.ONION`.

## Security done
Tokens hashed at rest, per-session and per-IP rate limits, 20 KB body cap, strict whitelisted validation, CSP + nosniff + no-referrer + frame denial,
path-traversal protection, constant-time admin key check, no payout data stored, generic 500 errors, append-only ledger, idempotency.

## Gaps you still own
- Real provider integrations (`providers.js`: charge, chargeRecurring, broadcast, payout, newAddress, kyc). This is **your part 1**.
- Real QR codes for deposit addresses (the page draws a placeholder pattern; add a QR library served from your own origin).
- Back up `gx.db` (WAL mode: copy with SQLite's backup tools, not just the `.db` file). Consider Postgres if you need multiple servers.
- Monitoring and alerting, HTTPS (or onion only), and a second price source for cross-checking.
- Anonymous sessions: losing the token means losing access to the server-side balance. Decide what custody model you really want.
- Licensing, KYC/AML and sanctions screening, tax reporting (e.g. India TDS), and lawyer-reviewed policies. Mixing services are restricted or banned in some countries, which is why `/mixes` is off in live mode.
