# hanaworlds-local-runtime

Cordis plugin for the local Luanti engine source. Card `local-runtime-01` supplies **C-engine-runtime**, using the published `hanaworlds-contracts v2.3.0` Git release. It contains the migrated native process controller, graphical client, verified game/mod supply and Go native helper.

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

Engine profiles are owned by the Luanti world source. The adapter associates the selected worldRef with the canonical local directories in this opaque profile; hosts carry it unchanged. The runtime does not interpret worldRef as a path, accepts no supplied connection identifiers, checks exact native process/world/endpoint identity and mints fresh references after native verification. Replaying an identical start request rechecks that same live child. Changed inputs or expired incarnations are refused; restart uses a new requestId. A stopped handle is rechecked under its world lock until reacquisition or plugin unload.

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

Tests use isolated directories under `~/.cache/hana-world-runs/local-runtime-01`; `HANAWORLDS_TEST_ROOT` overrides the test root. Native OS tests use a synthetic Node executable, not Luanti. The imported `tests/native-control-runtime/main.go` is a fixture SRP generator/native protocol probe, not a server simulator; `npm run test:probe` checks its Fixture mode without network/account access.

The module's eventual host-facing interface is C-world-lifecycle. Full template/list/create/delete/launch/stop/play wiring and consuming C-local-worlds belong to subsequent lifecycle work; this engine card does not publish them. Graphical process spawn is not ENTERED evidence. No full product acceptance is claimed.

[Source provenance](docs/PROVENANCE.json) records `git log --follow` for every migrated file. [NOTICE](NOTICE) records versions, licenses, origins and purposes.
