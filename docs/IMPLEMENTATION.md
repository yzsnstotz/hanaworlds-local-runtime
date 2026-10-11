# local-runtime-01 · approved card implementation

Goal: move the native Luanti process, client, content and helper implementation from desktop `bd964cdf` into an independent Cordis plugin and provide the published C-engine-runtime port.

Architecture: preserve the requested native implementations and Go helper, with one documented startup cleanup marker in native-engine-session.ts; wrap NativeEngineControl with the published engine-runtime/v2 request/response validation. The world source supplies an opaque luanti-native/v1 engine profile. Only the runtime interprets its canonical worldPath and userPath. Native verification precedes reference creation; exact child exit precedes STOPPED. Cordis unload closes owned sessions. Bridge session selection and product deletion logic remain outside this card.

Execution and verification:

- Import existing source tests first and record the absent implementation failures; migrate native files with per-file follow history and SHA256 in PROVENANCE.json.
- Add engine port tests for validated input, native failure, directory mismatch, missing world, fresh status, exact start replay and old connection expiry; observe red then implement the wrapper.
- Add Cordis loading and fixture-only consumer mock tests. Compile against published v2.3.0 interfaces.
- Run an actual synthetic executable with a UDP endpoint to exercise the unchanged native driver, then verify native child exit and restart.
- Run the card's contract, TypeScript and Go commands; build the native helper and supplied Go fixture probe.
- Review concurrency and cleanup failure regressions, then commit on the task branch, push, fast-forward module main, push and read back origin/main. Write the run-directory receipt and cleanup manifest.

Scope: no full C-world-lifecycle implementation or C-local-worlds adapter integration is claimed here. This card's contract list and goal name C-engine-runtime. Game/client/content code is migrated and tested in isolation; real Luanti, graphical ENTERED and whole world-source composition require their own evidence.
