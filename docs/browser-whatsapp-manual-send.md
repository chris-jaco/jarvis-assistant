# WhatsApp Web manual selection and controlled drafts (V0.5.3.6A/B.2)

This development checkpoint is READ-only for WhatsApp. It has not passed real Windows/Chrome acceptance. No backend configuration, model parameter or page message enables sending in this build.

1. Atlas obtains the existing Chrome permission, site authorization and task grant for the exact tab.
2. The user opens a conversation and clicks **Confirmo que esta conversación es el destinatario** in the extension popup. This creates a temporary `USER_SELECTED` binding for tab, document, scope and connection epoch. It does not establish verified contact identity.
3. `browser.prepareDraft` keeps private-draft mode RAM-only. For an explicit composer-writing goal it creates an editable visual content review. Approval freezes exactly the reviewed text; it does not authorize writing.
4. The backend deterministically creates a separate WRITE confirmation. Only that one-use approval may invoke `browser.writeDraft`; the extension writes the frozen text without Enter, submit, or Send and verifies the composer locally.

`browser.sendMessage` is absent from the Tool Registry. The extension controller rejects direct `sendSelectedMessage` requests, and the content script independently rejects that operation before any click. The command's presence in the versioned protocol grants no capability. Generic click, type and Enter remain blocked for chat sending. `contactAssociation` and `identity` remain `NOT_VERIFIED`.

Selection, reviews, capabilities and drafts expire or invalidate on material context change, grant revocation, navigation, admission/task change or connection epoch change. The private execution journal reserves before the possible composer write; an uncertain result is `UNKNOWN` and is never retried. No Send reservation or dispatch exists.

Real Windows/Chrome acceptance is still required for controlled composer writing. Sending remains a separate NO-GO checkpoint requiring its own reviewed identity/confirmation/verification boundary; no setting activates it in this build.
