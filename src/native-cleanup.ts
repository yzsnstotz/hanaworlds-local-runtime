/** Internal marker: preserve a failed native cleanup's cause instead of claiming NONE. */
export class NativeCleanupFailure extends Error {
 constructor(readonly failure: unknown) { super('NATIVE_CLEANUP_UNPROVEN', {cause:failure}) }
}
