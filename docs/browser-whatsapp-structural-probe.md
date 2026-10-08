# V0.5.3.2d — Manual WhatsApp structural probe

Standalone diagnostic. No Atlas runtime, extension, provider, foundation, permissions or confirmation changes. No build/reload/host reinstall is needed in Windows to use this script after pulling. No adapter or Send/Enter/composer write is implemented.

## Windows instructions

Keep Atlas browser automation idle. Use ONE individual test conversation, opened manually, with an empty composer. Do not navigate, type or send during either sample. Open DevTools on that WhatsApp tab (not the extension Service Worker).

Read the script in PowerShell:

```powershell
Get-Content -Raw .\scripts\whatsapp-structural-probe.js
```

Review it before pasting. Edit only the `configuration` line in the copied script. `$0`, `$1`, `$2` are DevTools' most recently inspected Elements, not selectors or Atlas refs. Confirm the selections in Elements before running. Never paste a name, phone, URL, DOM dump or private value into configuration.

### STATE_A

In Elements, select the **conversation pane container** holding its visible header and composition area. Do not select body/html, a message, or the entire application including other chats. Use the unchanged configuration:

```javascript
const configuration = { state: 'A', conversationRoot: $0, contactPanel: null, phoneField: null };
```

Execute the complete script once. After two structural samples, it prints `ATLAS_WHATSAPP_STRUCTURE_A`. Share only that JSON; ignore the Console's Promise display.

### STATE_B

Manually open information for the SAME test contact. No automated panel opening is provided.

If a full phone is visibly displayed, select these elements in this exact order in Elements:

1. Conversation pane container (excluding the contact panel).
2. Contact-information panel container.
3. The **smallest display leaf containing only the visible phone**, not its heading, parent panel, link, input or a message. Supported diagnostic leaf tags: span, p, div, with one text node and no child elements.

Then replace configuration in the copied script with:

```javascript
const configuration = { state: 'B', conversationRoot: $2, contactPanel: $1, phoneField: $0 };
```

If there is no phone field, do not search messages or open other conversations. Select conversation container and then contact panel; use:

```javascript
const configuration = { state: 'B', conversationRoot: $1, contactPanel: $0, phoneField: null };
```

Execute once and return only `ATLAS_WHATSAPP_STRUCTURE_B`. The phone value is never printed or retained. No composer value is read. A display leaf must match a conservative international `+` phone format, maximum 64 characters; other formats produce NOT_VERIFIED, not proof of absence.

The contact and conversation scopes must be separate, non-overlapping containers in the same document. If the current layout cannot provide those manual scopes safely, the probe returns NOT_VERIFIED for phone evidence. Do not broaden scope or substitute a message node to bypass this guard. A manually selected panel is not independently proven to belong to the selected conversation.

## What is inspected

Only manually scoped structural descendants: conversation-region candidates, headers, textarea/contenteditable textbox candidates, buttons and explicit Send/Enviar aria-label matches. Send label values are inspected only on buttons in a direct composer-parent container that excludes headers/logs; history-button label values are never read. Nearby controls expose only sanitized shape and SVG presence, never icon attributes. A different layout leaves Send unverified. Labels are represented only by presence/type (LABELLEDBY / ARIA_LABEL / TITLE / NONE), never values. Unknown tags/roles become `other`. Ancestor shapes are limited to four levels. Output counts cap at 40, detailed arrays at four entries; each selector inspects at most 200 matches. Truncation prevents stability claims for that category.

Two READ samples, scheduled 200 ms apart, compare actual node identity, sanitized functional shape, enabled state and ancestor identity. The report measures local elapsed time. If scheduling exceeds one second, sampled stability is not accepted. There is no polling loop or retained listener. This proves only sampled local continuity, never durable DOM identity, document/epoch stability, trusted recipient identity or correct task binding.

Phone inspection occurs only in STATE_B, on the explicitly selected visible leaf within the selected contact panel, outside the conversation and any editable field/log. No whole-page text scan, history/message extraction, names, titles, values, hrefs, private attributes, cookies, storage, network or app APIs are used. The only text read is that selected display leaf's bounded single text node. Its output is PRESENT or NOT_VERIFIED.

Visibility here is CSS/layout visibility, not ContentEngine's additional viewport hit test. Matching Send is best-effort structural evidence: empty composer, localization and icon-only controls can produce zero. Do not type into WhatsApp just to expose a Send button.

## Interpretation

- `adapterDesignEvidence: PARTIAL` indicates a manually scoped pane has one composer candidate and header evidence. It is a clue for designing fixtures, **not sufficient authority to prepare or send**.
- Missing or ambiguous evidence → NOT_VERIFIED. Absence of markers does not demonstrate that WhatsApp lacks the capability.
- `phoneEvidence: PRESENT` means a phone-shaped value exists in the explicitly scoped display leaf. It does not establish identity ownership or the contact-panel/conversation association.
- `contactPanel.association`, `activeConversationBinding`, `documentEpoch` remain NOT_VERIFIED; `identityVerified` is always false.
- Shared ancestry / parent relationships are structural facts, not semantic authorization.
- Labels, icons, page DOM and manual selections can be misleading. Do not treat the report as approval.

The next step is reviewing both sanitized reports and resolving structural ambiguities before approving an isolated semantic adapter. No product selectors are generated by this probe, no references are remapped and no consequential actions are enabled.
