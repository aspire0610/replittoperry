# LINE stock notifications

## Production components

- The dashboard and signed-in account API remain on Vercel.
- `/api/line/webhook` handles LINE account-link messages and must be configured as the webhook URL in the LINE Messaging API channel.
- Run the LINE/Fugle worker on a separate always-on Node.js host; do not publish this Repl as a Reserved VM. Vercel remains the dashboard/API host.
- The worker host must expose a public HTTPS endpoint so Vercel can call the relay. The relay endpoint itself requires an HMAC bearer token derived from the shared Fugle API key.

## Secrets

The worker host needs `FUGLE_API_KEY`, `CLERK_SECRET_KEY`, and `LINE_CHANNEL_ACCESS_TOKEN`. The account API/webhook on Vercel needs `CLERK_SECRET_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`, and `LINE_CHANNEL_SECRET`. Keep the same Fugle API key configured in both environments: the Vercel API derives a separate relay token from it to authenticate with the worker.

Secrets in Replit do not automatically populate either Vercel or the worker host. Vercel Production needs `CLERK_SECRET_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, and the same `FUGLE_API_KEY` for webhook verification and relay authentication. Set `LINE_WORKER_URL` in Vercel to the worker's HTTPS base URL with no trailing path, then redeploy the dashboard/API. When configured, the Vercel API relays TAIEX index requests through the worker rather than opening another Fugle WebSocket.

## Worker run command

Use this command as the worker host's build/start command:

```sh
pnpm --filter @workspace/api-server run line-worker
```

It builds the API package and starts only the notification worker. The relay is available at `/internal/realtime` (and `/api/internal/realtime` for hosts that route through the artifact prefix). Do not run the worker beside the ordinary API server; doing so would create unstable or duplicated WebSocket connections.

## LINE setup and account linking

1. Set the webhook URL to `https://<production-domain>/api/line/webhook` and enable webhook delivery in the LINE Messaging API channel.
2. In the signed-in dashboard, open **系統設定 → LINE 價格通知** and generate a link code.
3. Add the Official Account as a friend and send `LINK <code>` to it within ten minutes. The code is signed, expires, and can be used once.
4. Configure `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` in Vercel Production and redeploy.

## Market-data constraints

The worker subscribes to Fugle's `aggregates` WebSocket channel for symbols in the user's watchlist and enabled alerts, and to `indices/IX0001` for the market overview. It ignores trial/stale messages and requires a source timestamp. The worker must be live and `LINE_WORKER_URL` must be configured in Vercel before production traffic relies on the relay; otherwise the Vercel API may open its own Fugle WebSocket.

Opening notices use each symbol's first observed verified trade during the first ten minutes of the session. Closing summaries use the final verified stream ticks received before 13:31 Taiwan time; they are not represented as an official daily-close feed. The worker skips symbols for which it has no verified tick.
