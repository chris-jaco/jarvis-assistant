# ATLAS V0.5.3.2 — Semantic Conversation & Safe Draft

This development phase is based on V0.5.3.1. Package, Chrome extension and Native Host versions do not change; this is not a release or host migration. Reload the rebuilt extension for the optional observation metadata. Existing observations without that metadata remain compatible but cannot prepare drafts.

## Evidence and identity criterion

The generic isolated-world `ConversationObserver` reads at most eight visible ARIA `role=log` conversation roots. Each must have unique DOM IDs and exactly one `aria-labelledby` relationship to a visible recipient label outside the log. That label must contain exactly one visible schema.org `itemprop=name`, with optional visible `itemprop=email` / `itemprop=telephone` text. Identifier formats are bounded and conservative. No tab title, message history, composer value, hidden attributes, storage, passwords, cookies, network or auth headers are used for identity.

A composer is associated only by an exact single `aria-controls` relationship to the conversation root. It must be a visible enabled textarea or contenteditable textbox outside search/form contexts. Send-control evidence uses the same explicit relationship and a visible Send/Enviar button label, but provides **no executable capability**. These constraints intentionally reject many custom applications. No hostname, product or arbitrary model selector is involved.

`conversationContext` supplies exact origin, optional visibly labelled application, candidate recipients, identifiers, opaque conversation/composer/control handles, truncation and `trust=UNTRUSTED_PAGE_EVIDENCE`. It is optional bounded metadata in the existing observation, never instructions or approval. Handles are generated per DOM node, not CSS selectors. Replaced nodes receive new handles. A second sample after the existing observation settling period omits semantic context if it changed; ordinary Search/Media observation remains unchanged. Metadata that would exceed the existing total observation size limit is omitted, rather than failing the prior observation contract.

Resolution is explicit and testable:

1. Names match exactly. A name alone is only a candidate, never verified identity.
2. The exact email/phone identifier must also have been captured in the current user-turn admission. Model tool input alone cannot invent that authority. Missing/late admission evidence requires clarification in a new explicit user turn.
3. Exactly one candidate must match both name and identifier, and have exactly one associated composer. Duplicate identifiers, truncated discovery, missing associations and insufficient evidence fail closed.
4. `VERIFIED` means agreement with that explicit requested identifier and observable binding. It does **not** establish real-world ownership, authenticate a person, or prove that a malicious website is honest. Future sending needs additional approved dispatch and result evidence.

Exact comparison intentionally does not normalize ambiguous name, email or phone variants. Phone formatting and transcript recognition may require the user to restate the exact visible identifier. Normal READ observation remains available when this conservative resolver cannot prepare a draft.

## Private preparation and lifecycle

Attached-only model tools:

- `browser.prepareDraft({recipientHint, recipientIdentity?, text})`: obtains a fresh authorized READ observation, resolves evidence, then returns `FROZEN` or `AMBIGUOUS` / `IDENTITY_REQUIRED` / `INSUFFICIENT_EVIDENCE`. Clarify ambiguity/identity; stop preparation when unsupported. Successful preparation says only that a **private Atlas draft** exists.
- `browser.reviewDraft({intentId})`: obtains fresh READ evidence and revalidates an existing private preparation. The ID identifies a record, never grants approval or execution.

Both use the V0.5.3.1 `ConsequentialFoundation` ledger, common freezing function, original SEND_MESSAGE intent contract and RESOLVING → FROZEN / INVALIDATED / EXPIRED states. They do not introduce another confirmation/preparation engine. RAM-only draft mode rejects simulation-tool registration, pending-confirmation creation and `execute` unconditionally. No approval/execution ID is allocated and no execution journal I/O occurs because no effect can begin. The V0.5.3.1 simulation/journal and Confirmation Engine remain unchanged in behavior.

The intent freezes exact content, recipient/identity evidence, origin, backend session, task/admission, epoch, grant scope, tab/document, backend preparation ID and expiry. The same entry freezes conversation/composer/send-control evidence and the source snapshot ID. Expiry is bounded by the original snapshot TTL (15 seconds), the grant and the existing 60-second maximum. Fresh observations do not extend it. A changed text creates a new preparation and invalidates the old one; no in-place edit or confirmation follows.

Material binding/evidence changes invalidate drafts during fresh observation/review. Grant/document notifications, explicit revocation, a new admission, reconnect, task close and session close invalidate existing drafts conservatively. A replaced composer cannot silently inherit a handle. No background page observation is added: changes without a browser event are detected on the next requested READ; the original expiry still bounds validity. No draft can be consumed for execution even before that detection. Restart discards RAM drafts; they are not written to memory, telemetry or the journal. Normal model tool results include requested draft content for the current voice session, as any other conversation data; do not treat RAM as persistent encrypted storage.

## Preserved boundary

Chrome technical permission → exact-origin Atlas policy → live operational task grant remain enforced by the existing extension observation path. The backend binds that successful evidence to its own session/admission/tab/scope/epoch and checks expiry. None of these layers is bypassed by a draft or recipient identifier.

No Native Messaging operation, MV3 permission or site policy is added. No composer write, Send click, chat Enter, generic consequential submit or browser.send tool is enabled. Existing challenge/manual-intervention and EXECUTION_UNKNOWN/no-retry guarantees remain. Audio/personality/Search/Media/confirmation logic is untouched. Safe draft READs cannot dispatch external actions or change their permissions.

## WhatsApp and acceptance limitations

Generic fixtures demonstrate explicit semantic relationships, **not WhatsApp compatibility**. WhatsApp may omit schema.org recipient identifiers, use proprietary conversation structure or expose only a display name. In that case the correct result is insufficient evidence, not weaker identity verification.

If real observation cannot bind its recipient and composer, propose a separately reviewed `ConversationSemanticAdapter` in the extension evidence layer. It would emit this same strict contract from visible, explicit application evidence, remain read-only and retain exact user-identifier matching and material-change invalidation. It must not live in BrowserProvider, use profile/network/storage data, or unlock sending. No such adapter is implemented in V0.5.3.2. A real Windows probe is required before claiming product compatibility.

Minimum local acceptance after build/reload:

1. Open and authorize a generic fixture with visible name + email, labelled log and associated composer. Request a private draft with that exact identifier in the user turn. Inspect `FROZEN`, exact content and `executionEnabled=false`; external composer stays empty.
2. Two homonymous conversations without a requested identifier: expect clarification, no draft. An exact unique identifier may resolve one; duplicate identifiers may not.
3. Change conversation, recipient, composer node or document, then review: expect INVALIDATED. Revoke permission: no valid draft can be returned. Wait past the initial snapshot expiry: EXPIRED.
4. Modify draft text: old preparation invalidated, new exact content frozen. Ask to send/press Enter: existing blocks remain, no approval or external effect.
5. On WhatsApp Web, observe only authorized visible content. If the required semantics are absent, expect refusal to prepare. Do not interpret generic fixture tests as this acceptance passing.

Automated fixtures cover identity, homonyms, insufficient/unassociated/hidden/duplicate/deceptive elements, prompt injection, node replacement, document/context/revocation/expiry, exact text edits, session isolation, strict schema rejection, runtime READ-only dispatch and existing Send/Enter/composer blocking. The full V0.5.2/V0.5.3.1 regression suite must also pass.
