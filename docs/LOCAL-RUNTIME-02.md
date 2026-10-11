# local-runtime-02 · approved card implementation

Contracts are pinned to the Adapter's formal Q-24 handoff: `v2.5.0`, peeled
`f0c6751e984bb15081ea70c351ccbb484c91226c`. The paired Adapter's published main is
`2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63` (0.16.0). Its
[`docs/source-locator.md`](https://github.com/yzsnstotz/hanaworlds-adapter-luanti/blob/2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63/docs/source-locator.md)
defines the world-source-internal locator consumed here; no Adapter dependency is added.

The six-operation lifecycle port wraps the published C-local-worlds and
C-engine-runtime ports. It owns no Session selection or binding. describeDelete/delete
remain in local-runtime-03, with canDelete=false. canPlay=false and play refuses
CAPABILITY_UNAVAILABLE until a graphical client can prove bound world entry;
the migrated client process API only proves spawn.

World identity is worldRef, with a source-owned deterministic runtime worldId.
Each metadata observation rechecks the locator's canonical direct-child path,
configured root, device/inode, game and user path. Metadata file handles refuse
symlinks and detect replaced/changed files. A second fresh provider observation
checks payload identity without guessing its disk representation. Missing capability,
unknown user path, disappearance and identity disagreement explicitly reject.
Locators and engine settings remain inside the paired world source.

Lifecycle launch's `luanti-native/v1` opaque profile carries optional
`expectedDirectory: {device, inode}` as decimal strings. This is private source
profile evolution, not a C-engine-runtime shape change. Lifecycle launch always
supplies it. NativeEngineRuntime uses a private operation map to pass it to its
driver's second parameter; NativeControlInput is unchanged. Native startup checks
the expected identity before acquiring a child, after world locking and before
spawn. Native process readback/stop continue to check the same directory. Existing
engine callers without this new source-owned field retain their baseline behavior.

Unknown creation failures after possible writes report UNKNOWN, not NONE. Known
provider refusals retain the provider's admitted mutation facts. Invalid peer
receipts after a possible mutation throw LIFECYCLE_MUTATION_UNPROVEN with the
original admission cause. Native launch/stop cleanup failures preserve their
original exception and cannot become successful receipts.

Game/client supply manifests and preparation scripts are copied byte-for-byte from
desktop bd964cdf; PROVENANCE.json records source hashes and follow history. Existing
game-client.ts and luanti-content.ts remain byte-for-byte from local-runtime-01.
Only the native session's expected-directory checks supplement its prior cleanup
marker; its new delivered hash and rationale are recorded in provenance.

Validation separates fixture ports, actual OS child tests with a synthetic executable,
and a separately installed published Adapter readback against constructed filesystem
worlds. The latter uses its actual Cordis service and no sibling checkout imports.
No real Luanti engine, real graphical UI or owner acceptance is claimed.
