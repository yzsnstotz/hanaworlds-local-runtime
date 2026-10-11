# hanaworlds-local-runtime

Cordis plugin for the paired Luanti world source. `local-runtime-01` supplies **C-engine-runtime**; `local-runtime-02`/`-03` supply **C-world-lifecycle** describe/list/create/describeDelete/delete/launch/stop/play, consuming **C-local-worlds** through the published `hanaworlds-contracts v2.5.0` Git release. It preserves the native process controller, graphical client, verified game/mod installer and Go helper from `039839f`.

Configure `worldRoots`, `userPath` and `contentBundle` alongside `runtimeRoot`/`stateRoot`. The paired Adapter's roots, user path, creation root and game must describe the same source. Bridge and shell consume `ctx.get('hanaworldsWorldLifecycle')` with `world-lifecycle/v2` envelopes. Cordis resolves `hanaworldsLuantiLocalWorlds` dynamically; this plugin has no Adapter dependency or sibling-module import.

`describe` publishes the source's `flat` template and explicit manifest/engine/entry prerequisites. `list` resolves each exact worldRef with read-only `describeSourceWorld`, checks the published locator's canonical root/path, device/inode, connection identity, user path and game, reads regular `world.mt`/`map_meta.txt` without following symlinks, then asks the provider again to confirm the same payload identity. Same-name worlds remain distinct. Runtime worldIds are stable hashes of worldRef; locators never enter lifecycle replies.

`create` verifies/installs the configured game/mod supply, prepares Luanti's `worlds/`, and calls `createWorld(templateId, displayName)`. It carries creationFacts unchanged, including null, and never interprets them to find a world. `launch` obtains a fresh source observation and carries its expected device/inode through the source-owned opaque engine profile to private native startup checks (after locking, before spawn and during readback). The engine provider's actual connection/incarnation readback supplies the reply. Missing locator capability is an explicit `ADAPTER_UNAVAILABLE` refusal with `causeCode: CAPABILITY_UNAVAILABLE`; missing/changed worlds and unknown user paths are refused. No list/create/launch path calls pair or selects a Session. Bridge owns connect, noLiveBinding, name confirmation and localContext.

`stop` awaits the exact native exit proof. Unknown exceptions after possible creation writes report `mutationState: UNKNOWN`; native launch/stop cleanup exceptions preserve their original failure. `canDelete` is true when the source exposes `deleteWorld` and the engine provider can hold a directory out of use (`retireWorld`/`worldInUse`). `describeDelete(worldId)` re-observes the exact source world and returns the source's own current name (its discover `displayName`, not the `world_name` title) as `confirmationName`, plus impacts, including a running local engine. `delete(worldId, confirmationName)` refuses a different name with `TRANSACTION_CONFLICT` before calling the source, refuses while a native session runs/starts on that directory, blocks new starts on it during deletion, calls `deleteWorld(worldRef, confirmationName)` (source refusals pass through unchanged), then reads back that the source's fresh discovery no longer lists the world and its directory is gone; otherwise `mutationState: UNKNOWN`. Undeclared causes map to the operation's declared code (`WORLD_NOT_FOUND` / `TRANSACTION_CONFLICT`) with `causeCode` preserved. The bridge still owns the no-session-selects-this-world check. `canPlay=false`: the preserved graphical client can spawn but cannot supply a bound ENTERED receipt. `play` returns `CAPABILITY_UNAVAILABLE` and starts no process.

```ts
import { Context } from '@deepseek-ai/cordis'
import * as localRuntime from 'hanaworlds-local-runtime'
const ctx = new Context()
const fork = ctx.plugin(localRuntime, {
  runtimeRoot: '/absolute/installed-engine-runtime',
  stateRoot: '/absolute/private-runtime-state',
})
await fork
const runtime = ctx.get('hanaworldsEngineRuntime')
const started = await runtime.StartWorldRuntime({
  contractVersion: 'engine-runtime/v2', requestId: 'launch-1', worldRef: 'source-world-ref',
  engineProfile: {
    profileId: 'luanti-native/v1',
    worldPath: '/absolute/source-selected/world',
    userPath: '/absolute/source-selected/luanti-user',
  },
})
// StopWorldRuntime and ReadRuntimeStatus take contractVersion, requestId and connectionRef.
// Always check response.error before using response.result.
await fork.dispose()
```

Engine profiles are owned by the Luanti world source. The paired source associates worldRef with canonical directories. Lifecycle launch additionally carries optional expectedDirectory {device,inode}; only the world source interprets this profile. The runtime does not interpret worldRef as a path, accepts no supplied connection identifiers, checks exact native process/world/endpoint identity and mints fresh references after native verification. Replaying an identical start request rechecks that same live child. Changed inputs or expired incarnations are refused; restart uses a new requestId. A stopped handle is rechecked under its world lock until reacquisition or plugin unload.

Start returns WORLD_NOT_FOUND for an absent selected world, ADAPTER_UNAVAILABLE for unavailable platform/artifact or refused profile. Unknown/expired connections return CONNECTION_NOT_FOUND. Native stop/cleanup failures reject with their original failure: they never become a successful STOPPED response. Admission errors also reject. Read/Stop and exact Start replay serialize per connection. A failed cleanup retains its own original cause, blocks new starts and prevents a successful unload claim; it is not automatically retried. No added retries or timers mask failures; the unchanged imported native driver retains its original finite startup/exit limits. Only darwin-arm64 native startup is currently supported.

Build with Node >=24 and Go >=1.25:

```sh
npm install
npm run verify:contracts
npm test
(cd engine-control && go test ./...)
npm run build:helper
node scripts/build-engine-control-runtime.mjs <official-http-engine-runtime> <new-output>
```

The runtime assembly script preserves its baseline's exact Luanti 5.17.0 artifact hash and source revision. It requires that artifact as input and creates a new output directory. The plugin does not install an engine automatically.

`hanaworlds-local-runtime/mock` exports `createEngineRuntimeMock()`, a **stateless fixture-only** EngineRuntimePort backed by published examples. Optional refusal keys are `engine-runtime/v2:<operation>`. `examples/engine-runtime.json` lists all three successful responses and four declared refusals. A fixture stop does not change fixture status or prove any real process fact.

Tests use isolated directories under `~/.cache/hana-world-runs/local-runtime-02`; `HANAWORLDS_TEST_ROOT` overrides the test root. Native OS tests use a synthetic Node executable, not Luanti. The imported `tests/native-control-runtime/main.go` is a fixture SRP generator/native protocol probe, not a server simulator; `npm run test:probe` checks its Fixture mode without network/account access.

`hanaworlds-local-runtime/mock` also exports `createLocalWorldLifecycleMock()` for all eight operations, with `canPlay=false` and fixture refusals. `examples/world-lifecycle.json` admits success/error fields for all eight; no mock play invents ENTERED.

The unchanged pinned game/client supply manifests and preparation scripts now live in `scripts/hanaworlds-{game-client,luanti-content}.json` and `scripts/prepare-hanaworlds-{game-client,luanti-content}.mjs`. These require provided upstream archives; they never download or change versions. No whole-product or owner acceptance is claimed.

For independent real-provider source readback, install Adapter main `2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63` into a separate directory, then run `node scripts/test-source-provider.mjs <independent-install> <card-run-directory>`. This uses the published plugin through Cordis, constructed filesystem worlds and a fixture status-route registry; no real Luanti/UI acceptance is implied.

[Source provenance](docs/PROVENANCE.json) records `git log --follow` for every migrated file. [NOTICE](NOTICE) records versions, licenses, origins and purposes.

For real-provider deletion readback, run `node scripts/test-source-delete.mjs <independent-install> <card-run-directory>` with the same Adapter install. It creates one world through the source's own `createWorld` (setup only), constructs one foreign world, and supplies peer fixtures: a temporary DSH home for the source's journal and a Canvas selection inventory where no session selects any world. It checks describeDelete, wrong-name and foreign-world refusals, real deletion, and that `list` no longer shows the world. No real Luanti/UI acceptance is implied.
