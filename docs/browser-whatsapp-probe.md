# V0.5.3.2b — WhatsApp Web compatibility checkpoint (READ only)

## Current verdict

No live Windows/WhatsApp DOM result is available in this cloud checkout. All **WhatsApp-specific** capabilities below remain **NOT_VERIFIED**. Generic fixture success in V0.5.3.2 is not evidence of WhatsApp compatibility, and an absent marker is not proof that the application lacks the capability.

| Capability | WhatsApp status now | Evidence required by the current generic contract |
| --- | --- | --- |
| Recipient identity beyond name | NOT_VERIFIED | Visible recipient label with one itemprop=name plus email/telephone; exact identifier also present in the current user admission; exactly one matching candidate |
| Active conversation | NOT_VERIFIED | Visible role=log with unique ID and one aria-labelledby pointing to a visible label outside the log, not containing message history; associated composer; no ambiguity |
| Associated composer | NOT_VERIFIED | Exactly one visible enabled textarea or contenteditable role=textbox, with exact single aria-controls matching that log; outside search/form |
| Associated Send control | NOT_VERIFIED | Visible button/role=button with aria-label exactly Send/Enviar and aria-controls matching the log; this is evidence only, not execution capability |
| Stable handles / revalidation | NOT_VERIFIED | Same actual conversation/composer/control nodes across fresh observations; replacement invalidates binding, not remapping |
| Document / epoch / scope validity | NOT_VERIFIED | Existing authorized extension observation binding plus current backend session, task/admission, tab/scope/document, connection epoch and unexpired snapshot/grant |

Static review confirms that `ConversationObserver` uses generic ARIA/schema.org relationships, never product selectors or tab title identity. `semantic.ts` separates candidates, AMBIGUOUS, IDENTITY_REQUIRED, INSUFFICIENT_EVIDENCE and VERIFIED. VERIFIED only establishes agreement with visible evidence and an explicit requested identifier; it is not authentication of a real person or a trustworthy site. Hidden labels, duplicate IDs, truncated discovery and missing composer associations fail closed. Names alone do not prove uniqueness.

ContentEngine samples semantic metadata before/after its settling period, omitting unstable semantic evidence. Its existing access, document/ref and TTL checks remain. AttachedChromeProvider binds successful extension observation to its owning task/admission and checks connection/epoch, authorization and expiry before a private draft. The manual probe below cannot inspect those isolated-world/backend bindings and deliberately reports them as unverified.

## One safe manual probe in Windows

1. Pull this branch. No build, extension reload or Native Host reinstall is needed for this standalone diagnostic; no runtime files changed.
2. In your usual Chrome, **manually** open a conversation with a test contact in WhatsApp Web. Do not type a draft or ask Atlas to open/select conversations. Keep unrelated browser automation idle. Use an empty composer; a Send button may be absent when it is empty, which is not proof of incompatibility.
3. Open DevTools **on that WhatsApp tab**, Console, top-frame context. This is the page console, not the extension Service Worker console.
4. From PowerShell in the repository, display the reviewed script:

   ```powershell
   Get-Content -Raw .\scripts\browser-semantic-probe.js
   ```

   Copy the script and execute it once in that page Console. Follow your browser's console security guidance; do not execute unknown pasted code. The script is a one-shot inspection, not an installed listener.
5. Return only the JSON starting with `probe: ATLAS_SEMANTIC_STRUCTURE`. Do not send screenshots, DOM dumps, names, phone numbers, messages, URLs or unrelated console output. Optionally state whether the test conversation was visible and the composer empty, without identifying the contact.

Visibility in this probe means CSS/layout visibility only; it does not prove viewport hit-testing or absence of occlusion, which ContentEngine additionally checks. Counts are therefore structural clues, not admission to a draft.

The script has no writes, event dispatch, clicks, focus, navigation, polling, history access, network, storage or credentials. It reads visibility, generic element types and limited relationship attributes, and prints only booleans/bounded counts. It never reads textContent/innerText or field values. The output contains no actual DOM IDs, labels, origin, title or identifier values. It is not an Atlas tool and cannot authorize, prepare or dispatch any action.

## Interpreting the result

- `visibleLogs=0`: current role=log evidence was not observed. The application might use another semantic representation, a different frame, or a different state; keep actual support NOT_VERIFIED.
- `explicitVisibleRecipientLabel=true` and `visibleNameMarkers=1`: a structural candidate exists, not verified recipient identity.
- `visibleEmailMarkers` / `visiblePhoneMarkers`: only presence of visible markers. Format, exact value, identity ownership and user-request matching are **not inspected**. Presence alone is PARTIAL evidence.
- `associatedComposers=1`: the current generic structural association is present. Active-recipient correctness and node stability still require separate validation. More than one is ambiguous.
- `associatedSendControls>0`: explicit association is present. Empty composer, localization or a custom icon might produce zero; do not type into the composer just to make a Send button appear during this checkpoint. No Send capability is enabled.
- `documentReady=true` only describes the page readyState. It proves neither epoch/scope nor semantic stability. `truncated=true` prevents a uniqueness claim.
- Repeating the manual inspection later can show structural changes but cannot prove node identity; the probe deliberately retains no page state or listener. Existing extension handles and document/epoch revalidation remain a separate layer.

## Adapter decision and open risks

An adapter is **not yet proven necessary**, and none is implemented. If a live probe shows that WhatsApp does not expose the relationships required by this extractor, the next step is an approved, narrowly scoped structural probe of alternative visible conversation/composer evidence, not a weaker identity rule or an automatic send.

Proposed boundary if needed:

- An isolated WhatsApp semantic adapter in the **extension evidence layer**, emitting the same strict semantic context from visible page evidence.
- BrowserProvider stays generic and accepts no product selectors.
- Confirmation Engine and frozen intent remain backend authorities.
- Consequential dispatch remains separate and disabled until approved in a later phase.

Remaining risks: homonyms; absent phone/email evidence; group versus individual chat; deceptive DOM; translated/custom controls; contenteditable association; rerendered nodes; frame boundaries; epoch changes; and proving actual Send effects. A visible phone is not cryptographic identity. The current label itself has no dedicated frozen node handle: future executable revalidation must assess whether its identity/binding also needs strengthening. This checkpoint makes no such change.

Tests execute the actual probe against generic fixtures while writes, message/field text, cookies, document location, network, Chrome/storage APIs and unapproved document methods throw. They verify unchanged DOM and sanitized bounded output, plus absence/deception cases. Full regression validation must pass. No audio, Search/Media, permissions, foundation, confirmation or runtime behavior changes are included.
