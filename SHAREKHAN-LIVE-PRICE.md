# Sharekhan live limit prices

Live Sharekhan orders now obtain their limit price from the backend WebSocket LTP
feed, including when a webhook or API request supplies a price. Historical candles
are no longer used for order pricing. An explicit price is still supported for a
dry-run preview; a preview with no price requests a live tick.

Open **Admin > Sharekhan Prices** (`/admin/sharekhan`), enter the admin API Key and
Secure Key, then select **Login with Sharekhan**. Register the callback address
displayed on this page in the admin Sharekhan API configuration. The existing
`/sharekhan/callback` route sends admin login states to the admin page before any
user login handler runs. If the registered callback uses another address, paste
the full returned URL into the admin page's manual completion form.

Credentials are saved in the dedicated `admin_sharekhan_market_data` collection.
Admin login does not modify user or strategy credentials. The price lookup accepts
only exchange and scrip code; order HTTP requests continue using the ordering
user's API key, access token, customer ID and channel user. Admin token expiry is
reported as a market-data failure and does not expire the user's trading session.

One shared connection starts immediately after admin login and is restored from
MongoDB on backend startup. It stays active without orders or an open admin page,
reconnects on network failures, and restores subscriptions. Token rotation closes
the previous connection first. An expired/rejected session requires admin login
again. Disconnect disables automatic startup until reconnect or a new login.

Instruments subscribe on first request. Subsequent orders read the latest fresh
quote from backend memory immediately. A missing/stale quote waits for a fresh
matching tick, then fails on timeout. Disconnect clears the price cache. There is
no fallback to user WebSockets, historical candles or incoming prices for live
orders. A limit order at LTP may remain pending if the market moves.

The singleton and price cache are per backend process. Deploy one backend process
for one shared WebSocket. Multiple workers/replicas would require a separate feed
owner and shared quote transport. A connection supports up to 1000 subscribed
instruments; new subscriptions above that limit fail explicitly. A process restart
starts with no instrument subscriptions and adds them as orders request prices.

Optional environment settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `SHAREKHAN_WS_PRICE_TIMEOUT_MS` | `10000` | Maximum wait for a usable tick, including connection setup |
| `SHAREKHAN_WS_MAX_TICK_AGE_MS` | `5000` | Maximum age of the broker's quote update time |

Both values must be positive and are capped at 60000 ms. Keep the server clock
synchronized. Outside market hours, or without fresh ticks, orders fail without
falling back to historical or incoming prices.

Install dependencies with `npm install` and restart the backend to load the change.
Build/restart the frontend to expose the new admin page. Run offline verification
with `node --test scripts/sharekhan-stream.test.js scripts/sharekhan-admin-feed.test.js`.
These tests mock sockets and order HTTP calls and never submit real trades.

Protocol reference: [Sharekhan WebSocket documentation](https://www.sharekhan.com/trading-api/documentation/web-socket-api).
