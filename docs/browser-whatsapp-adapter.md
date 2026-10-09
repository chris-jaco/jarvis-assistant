# V0.5.3.3 — WhatsApp semantic adapter, READ-only / partial evidence

Based on `9e16c7a46b808928ab108149e5127f11b2adec02`. This is a development checkpoint, not a release. Existing package/extension/host versions and permissions remain unchanged. Build and reload the extension to receive the optional new observation metadata; no Native Host reinstall is needed.

## Real evidence and intentional limits

The Windows probes demonstrated a visible conversation panel, header and enabled composer, plus a manually selected contact panel/phone leaf. They did NOT prove individual-chat identity, contact-panel association, or durable document/epoch validity. The retained hints are:

- `#main[data-testid="conversation-panel-wrapper"]`
- `[data-testid="conversation-header"]`
- `[data-testid="conversation-compose-box-input"]`
- Specific contact hints from `[data-testid*="contact-info"]`. Generic `[data-testid*="drawer"]` and `[role="dialog"]` are structural containers only, never sufficient contact evidence (V0.5.3.4).

No exact contact-panel or phone selector was retained. Consequently this implementation does **not read any phone value**, infer identity from a name, or label a phone PRESENT merely because an earlier manual probe saw one. Specific hints and demonstrated containment produce candidate counts/handles, never association or identity proof. Coexistence, matching names and short-lived stability do not demonstrate association.

Conversation hints require uniqueness, visible nodes and header/composer containment. The composer must have supported editable semantics and be enabled. A group-info accessible label is a negative, untrusted signal only; its absence never proves an individual conversation. All current identity, phone-match and contact-association results remain NOT_VERIFIED. Recognizing a conversation-pane candidate is not recognizing a verified individual recipient.

## Architecture and contracts

The extension's `SemanticAdapterRegistry` selects `WhatsAppSemanticAdapter` only for exact `https://web.whatsapp.com`. All product selectors stay in the isolated evidence layer. BrowserProvider's interface remains generic; the backend handles the normalized optional `conversationEvidence`, without hostname or product selectors.

The strict `conversationEvidenceSchema` records adapter/version, structural flags, reason/state, bounded contact candidates, backend-independent node handles and binding `{tabId,scopeId,documentId,epoch}`. It contains **no names, numbers, message text, field values or opaque WhatsApp identifiers**. Source is UNTRUSTED_PAGE_EVIDENCE. Current schema rejects identity=VERIFIED: the missing proof mechanism cannot be asserted by page/model input. States distinguish unavailable structure, insufficient evidence and invalidated evidence; observed flags identify what was actually found, without claiming a verified identity.

ContentEngine integrates this metadata in its existing authorized READ observation. Chrome permission, Atlas exact-origin policy, operational grant, document and short snapshot lifetime remain the surrounding authority. The adapter cannot grant any of these layers. Normalized backend assessment returns INSUFFICIENT_EVIDENCE. A partial site-specific result cannot fall back to generic name/ARIA matching to obtain a draft. Existing generic drafts and the simulation foundation are unchanged; reviewing a prior draft with this unverified evidence invalidates/rejects it.

No new tool, bridge command or execution channel is introduced. Confirmation Engine, frozen intent, one-use ledger, journal and EXECUTION_UNKNOWN/no-retry behavior are untouched. No composer write, Send/Enter, conversation switching or automatic panel opening is enabled by the adapter. Ordinary stable Browser Control tools retain their existing policy; this module itself has no action methods.

## Freshness and privacy

Handles use actual node identity. Header, composer, pane or candidate contact replacement changes handles; document/epoch changes alter the binding. Two samples during the existing explicit READ window compare evidence. A short MutationObserver guard watches relevant header/composer/panel candidates only while that READ is pending; it records merely that a mutation occurred, never old values or message content. It is disconnected in finally, including failed observations. No background reader/listener is installed. Changed evidence becomes INVALIDATED with no usable handles.

Evidence is a snapshot, not a permanent identity cache. A conversation change outside the READ window requires another authorized observation; previous snapshots expire/invalidate under existing document/ref rules. It is never usable to authorize an effect meanwhile because identity remains unverified. A short stable window does not establish future identity. Adapter scans cap at 64 raw matches per selector; all inspected visible nodes are filtered/grouped before the bounded contact count is reported (saturated at three). Exceeding the raw scan bound explicitly marks truncation and clears handles; truncation never asserts uniqueness. There is no whole-page text scan, network/storage access or diagnostic logging of private content. Existing diagnostics reject extra/private fields.

## What is still missing

Before identity can ever become verified, a reviewed implementation needs:

1. Positive, reliable evidence of an individual chat (not merely absence of group wording).
2. An exact safe contact-panel and visible phone-field locator established from real UI evidence.
3. A demonstrable binding from that panel/phone source to the same active conversation/header/composer. Neither coexistence nor matching display name suffices.
4. Full visible international phone, narrowly read within that proven context, normalized by an explicit reviewed rule and matched to the user identifier captured by current admission.
5. Fresh authoritative tab/document/epoch/scope checks and material-change invalidation for that proof.

No fixtures fabricate those missing relationships. Tests with a visible number in an unassociated panel deliberately remain insufficient, including requests matching or differing from that number. No real WhatsApp identification or send acceptance is claimed.

## Safe Windows acceptance

1. Pull this branch, run `npm run build`, then reload the unpacked extension from `dist/extension`. Keep its current permissions/Native Host installation.
2. Manually open an individual test conversation with empty composer. Do not ask Atlas to send, write, press Enter, select contacts or open information panels.
3. Ask Atlas only to observe the already authorized tab. Inspect the optional `conversationEvidence` in the tool response. Expected: candidate flags/handles, adapter version 1, identity/contactAssociation/phoneMatch NOT_VERIFIED and INSUFFICIENT_EVIDENCE (or UNAVAILABLE/INVALIDATED if structure changes).
4. Manually open contact information for that same test conversation and observe again. A candidate may appear; phoneEvidence remains NOT_VERIFIED because the exact locator and binding are missing. Do not share full ordinary browser.observe output, which can contain the existing visible page labels; share only the sanitized conversationEvidence object.
5. Manually change conversation or replace/reload context, then observe fresh. Handles/binding must change or evidence must invalidate. It must never upgrade identity. Challenge/revoked access retains existing handoff/rejection behavior.
6. A request to prepare a private message from this partial evidence must return INSUFFICIENT_EVIDENCE; external composer stays empty. No executable confirmation or send authorization is created.

Tests cover structural hints, absent/ambiguous/outside controls, group indication, missing/unassociated contact/phone, backend rejection for matching/different requested phones, replacement/document/epoch changes, READ-window mutation, truncation, origin selection, no field/message reads or effects, privacy, and existing BrowserProvider/confirmation regressions. Actual Windows acceptance of this adapter remains pending.


## V0.5.3.4 — Specific contact-panel detection

Real Windows STATE_A had generic drawers and no contact-info match. STATE_B had
visible nested drawers/dialog and four specific contact-info matches. The former
broad selector and early three-visible limit caused false candidates or discarded
useful evidence. This checkpoint changes only structural detection, not identity.

Visibility and conversation ancestry exclusion precede grouping. Each specific
visible contact-info hint is attached to its nearest eligible visible generic
container if one exists, otherwise to itself. Duplicate/nested resulting roots
collapse by actual DOM containment; disjoint roots are never merged through
body or an arbitrary common application parent. A generic container without a
specific hint contributes no candidate. These clusters are possible contact
containers, not proof that they are information for the active conversation.

Expected stable outcomes:

- Closed panel with only generic drawers: contactCandidates=0,
  contactPanel=NOT_VERIFIED, reason=STRUCTURE_ONLY.
- Open specific hints in one nested container: contactCandidates=1,
  contactPanel=CANDIDATE, reason=CONTACT_BINDING_UNPROVEN.
- Disjoint surviving candidates: contactPanel=NOT_VERIFIED,
  reason=AMBIGUOUS_STRUCTURE.
- Relevant change during READ: state=INVALIDATED, reason=CONTEXT_CHANGED.
- All outcomes retain identity/contactAssociation/phoneMatch=NOT_VERIFIED.

Markers remain untrusted: an unrelated or malicious panel can imitate
contact-info. This version does not prove panel identity, extract phone values,
prepare external drafts, enable SEND_MESSAGE or authorize any effect. Actual
Windows acceptance is required; fixtures do not guarantee current WhatsApp DOM.

Manual acceptance: build the committed code, restart Atlas and reload the unpacked
extension. In one Chrome window, open the test conversation manually with empty
composer. Observe with contact information closed, then open it manually and
observe again. Use the existing sanitized conversationEvidence logpoint; compare
only the allowed booleans/enums above. Multiple disjoint panels must remain
ambiguous; conversation/document changes require new authorized observations.
Do not share full snapshots, names, phone values, messages, HTML or handles.
No Native Host reinstall or permission change is needed.
