# ATLAS V0.5.3.1 — Consequential Action Foundation

Branch `v0.5.3-consequential-actions`, based on released V0.5.2. This phase provides server-side infrastructure and simulation tests only. It does not enable WhatsApp Send or any external browser effect. Package/extension/host versions remain unchanged: this is not a release.

## Boundary and contracts

`src/browser/consequential/contracts.ts` defines strict SEND_MESSAGE candidates, recursively frozen intentions, recipient evidence, exact text, origin/session/task/admission/scope/tab/document/epoch/preparation bindings, expiry, backend-generated intent/confirmation/execution IDs and result evidence. Model-facing simulation input only accepts recipientHint and text; unknown fields, approval flags and execution IDs are rejected. A trusted simulated context must match the requested recipient and text exactly and prove uniqueness. This is NOT a real DOM identity resolver: V0.5.3.2 now adds conservative observable evidence and private drafts, described in [browser-safe-draft.md](browser-safe-draft.md).

The foundation verifies three independent conditions before freezing, before reservation and again after journal I/O immediately before possible dispatch: Chrome permission, site authorization, and current task grant. Any material change in recipient/content/binding invalidates the frozen action. No similarity matching, stale-ref transfer, extended ref TTL or implicit cross-origin approval is introduced. A future adapter must supply these facts from authoritative browser/extension state, never model inputs.

States: RESOLVING → FROZEN → WAITING_CONFIRMATION → REVALIDATING → DISPATCH_RESERVED → EXECUTING → VERIFYING → SUCCESS / FAILURE / UNKNOWN. Other terminal states are CANCELLED, REJECTED, EXPIRED and INVALIDATED. The current sole executor is explicitly SIMULATED; its successful evidence is SIMULATED_MESSAGE_ACCEPTED, never a statement that a real message was sent or delivered.

## Existing confirmation authority

`ToolDefinition.confirmationLifecycle` provides optional, synchronous trusted notifications for pending creation, decision and invalidation. `ToolExecutor` remains the only pending/approval authority: one pending per session, consumed before awaiting execution, unchanged voice playback eligibility and 60-second confirmation window. The frozen intent may expire sooner (grant expiry); it is always rechecked. Summaries clearly identify SIMULATION and show recipient and exact text. The foundation cannot grant execution until the executor's approved-decision notification arrives.

The HTTP decision endpoint now runs inside `browser.inSession(session.browserSessionId, ...)`, exactly as invoke already does. No global current browser session is used. Optional invalidation callbacks must cancel only the matching executor confirmation; tests exercise revoke/cancel through that binding. Existing tools without lifecycle notifications retain their behavior. The foundation fixes its owning session explicitly at construction.

`simulationTool()` is instantiated and registered only by tests. It is not registered in `createToolRuntime`, exposed in the production HTTP descriptors, or added to Native Messaging/extension commands. V0.5.3.2 reuses the class in a separate non-executable draft mode in AttachedChromeProvider. Current Send clicks, composer typing and Enter remain blocked. There is no browser.send tool, new permission, hostname logic, selector, Search/Media, audio or personality change.

## Ledger, privacy and restart

The in-memory ledger reserves synchronously and memoizes execution per intent; duplicate decisions are consumed by the existing executor and duplicate execution returns its recorded result. Execution IDs are generated only after approval. Pending intentions/content remain in RAM, are frozen deeply and are not restored.

`PrivateExecutionJournal` defaults to `.local/browser-consequential/journal.json` (already Git-ignored and blocked from HTTP). No production startup initializes it in this phase. It records only opaque intentId/executionId, RESERVED/SUCCESS/FAILURE/UNKNOWN and timestamp. No plaintext recipient, text, origin, payload digest, confirmation, approval or credentials is persisted.

Before invoking the simulated executor, RESERVED is written to a validated private temporary file, fsynced and atomically renamed. POSIX also syncs the parent directory. Existing TokenFileSecurity enforces owner/private permissions on POSIX and native ACL validation on Windows; symlinks, hard links, unsafe directories and malformed files fail closed. A private exclusive lock serializes writers; lock contention, stale locks, corruption or security failure disables that journal instance rather than retrying blindly. Limits: 100 live intents per foundation, 10,000 journal rows, 2 MB input. There is no automatic pruning that could erase replay protection.

On initialization, RESERVED becomes UNKNOWN. No approval, executable payload or continuation is restored. Any unresolved UNKNOWN blocks creation of new simulated send intentions using that journal, including after restart; there is deliberately no automatic resend/unlock or operator-resolution interface yet. Recovered final state can be inspected without granting execution. This provides at-most-once dispatch for an intent, not distributed exactly-once delivery. A new ID does not bypass unresolved uncertainty.

Known pre-dispatch failure produces CONFIRMED_FAILURE / NOT_EXECUTED. Lost result, cancellation after reservation/possible dispatch or unprovable effect produces EXECUTION_UNKNOWN and never retries. CONFIRMED_SUCCESS requires the simulated evidence; timeouts cannot manufacture success. Once that verified effect is recorded, late cancellation or final journal I/O cannot erase it; a still-RESERVED journal remains conservative on restart if final persistence fails. The intent expiry and an internal 15-second execution bound constrain work; a late callback cannot replace a terminal unknown result. Signals and caller cancellation remain active.

## Validation and remaining decisions

Tests cover the existing executor/voice bridge, approval/rejection/expiry, concurrent decisions, replay, changed content/recipient/bindings, all three authorization layers, session isolation and HTTP context, revocation/cancellation, pre/post-dispatch abort, private journal/security/restart and sanitized persisted data. The complete V0.5.2 suite must also pass.

Real Windows ACL tests and Native Host tests remain platform/prerequisite-dependent; simulation does not establish WhatsApp compatibility. Future work needs real recipient/composer evidence, per-document preparation handles, approval-bound extension dispatch, actual result verification, journal maintenance/operator resolution and an explicit protocol compatibility plan. V0.5.3.2 is documented separately; external sending remains disabled.
