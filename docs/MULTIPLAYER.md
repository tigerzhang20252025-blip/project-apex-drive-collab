# Apex Drive multiplayer pilot

[Play the pilot](https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/) in a WebGL 2 browser. It runs on the dedicated Workers Free relay while a Netlify-ready static build is available separately. The existing Netlify site keeps its own release lifecycle.

## Play with a friend

1. Open the same pilot URL on both computers. In the garage, select **Multiplayer**.
2. Enter an optional driver name. One driver selects **Create Room** and shares the private code. The other enters it and selects **Join Room**. Either driver can choose a Ferrari F40 or Nissan GT-R R35.
3. The host selects **Free Drive** or **Best Lap Challenge**. Each player presses **Ready** after both models load. The host selects **Start Session**.
4. Wait for the shared lights to go out. The engine starts automatically. Use **WASD** or the arrow keys to drive and **C** or the camera buttons to change views. The cyan minimap marker tracks the other driver. Vehicle collisions with the circuit remain active. The other player is an exterior model in your scene.
5. In Free Drive, **R** resets just your car to its own grid lane. The host can select **End session** to bring both players back to the room. In Best Lap Challenge, forward-cross the start line to begin a lap. Complete as many valid laps as you can in ten minutes. The results rank the best valid laps and show splits, independent sector bests and theoretical bests. Either driver can select **Return to Lobby** when the results appear.
6. Use **Leave Room** when done. If the connection drops, keep the tab open for the automatic reconnection. The server reserves the seat for 45 seconds after detecting the drop. After that, join again with a valid invite if the host has returned to the lobby.

Timing and HUD use the existing checkpoint and sector rules. Online times are client-validated and kept in the room. The challenge clock follows the room schedule while the car is in a menu, reconnecting or in a suspended tab. An interrupted timed lap is invalidated. Rooms expire after 75 minutes.

## Independent-network checks

- Use two devices and independent networks, such as home broadband and another carrier’s cellular connection. For mainland China, repeat on each intended carrier pair and in both directions.
- Resolve `apex-drive-network-poc.tigerzhang0215.workers.dev` with `nslookup`. Request `/api/health` over HTTPS and open `/play/` on both networks. Confirm the models finish loading, the invite works and both drivers see moving opponents.
- Play for at least 30 minutes and note the RTT shown on both screens, any stale opponent, disconnections, jitter and whether a brief connection interruption recovers the same seat. Test at least one short challenge as well as Free Drive. Run ten create/join attempts per required network pair when evaluating reliability. Useful starting targets are nine successes in ten attempts, p95 RTT below 250 ms and under 1% stale receipt time.
- The [relay diagnostic page](https://apex-drive-network-poc.tigerzhang0215.workers.dev/) still supports 10, 15 and 20 Hz and exports RTT and interval statistics. Diagnostic invite codes are separate from game invite codes.

## Netlify-ready build

For an isolated Netlify pilot, use a separate Free project with the hostname `apex-drive-multiplayer-pilot.netlify.app`. Build from the multiplayer worktree and upload only `dist/` to the separate project. This Worker already allows that exact origin. If the name is unavailable, build the Worker with `APEX_FRONTEND_ORIGIN=https://<new-site>.netlify.app` before updating the dedicated pilot. Netlify’s current credit-based Free plan has a hard credit cap. [Netlify Free pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)

```sh
npm ci
npm run assets:fetch
VITE_MULTIPLAYER_URL=https://apex-drive-network-poc.tigerzhang0215.workers.dev npm run build
```

The separate same-origin Worker pilot can be built and updated from `multiplayer-poc/` with the existing authorized Cloudflare account. The account stays on Workers Free. The build stages the game under `/play/` and preserves the diagnostic page.

```sh
npm ci
npm run build:pilot
./node_modules/.bin/cf deploy --prebuilt --dry-run
./node_modules/.bin/cf deploy --prebuilt --no-provision
```

## Local verification

Run the app from the worktree root and the Worker from `multiplayer-poc/`. The frontend accepts the loopback relay at port 8788 by default. The accelerated challenge is a local-only Worker mode. Normal Cloudflare builds use the ten-minute deadline.

```sh
# Worktree root
npm run dev
# In a second terminal, from multiplayer-poc/
npm run dev -- --mode local-game-test
# In a third terminal, from the root after both servers are listening
node scripts/multiplayer-browser.mjs http://127.0.0.1:4177/
```

The browser checks use the repository’s isolated headless launcher. The local game test exercises all four model pairings, rendering and reconnects. Its challenge uses deterministic checkpoint paths to verify valid and invalid laps, ranking and results without driving a full circuit manually. The public smoke test exercises real input and WSS against the deployed build.

```sh
node scripts/multiplayer-pilot.mjs https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/
```

## Limits

Remote snapshots are visual state at 15 Hz. A bounded interpolation buffer uses limited extrapolation and suppresses stale cars. Each browser keeps one simulated car at 120 Hz. The remote exterior loader reuses the existing model preparation, without driver animation or a second live mirror pass. Exterior instances are retained across sessions in one room and disposed when leaving it. Mutable model resources are owned by their instance.

The backend limits the pilot to two occupants per room, three concurrent rooms, 120 room creations per rolling day and nine reserved room-hours per rolling day. A room owns WebSocket admission and game state. It uses no SQLite writes for pose or progress packets. The directory reclaims elapsed room time when players explicitly leave. WebSockets use one-time tickets and bounded message rates. The maximum session lifetime is the room lease. Results are appropriate for a casual challenge and use locally checked, client-reported times.
