# WhatsApp Web manual selection and private drafts (V0.5.3.6A)

This development checkpoint is READ-only for WhatsApp. It has not passed real Windows/Chrome acceptance. No backend configuration, model parameter or page message enables sending in this build.

1. Atlas obtains the existing Chrome permission, site authorization and task grant for the exact tab.
2. The user opens a conversation and clicks **Confirmo que esta conversación es el destinatario** in the extension popup. This creates a temporary `USER_SELECTED` binding for tab, document, scope and connection epoch. It does not establish verified contact identity.
3. `browser.prepareDraft` freezes the recipient hint and exact text in Atlas private memory. `browser.reviewDraft` rechecks the binding. Neither tool writes in WhatsApp.

`browser.sendMessage` is absent from the Tool Registry and the attached provider has no dispatch path. The extension controller rejects direct `sendSelectedMessage` requests, and the content script independently rejects that operation before any editing or click. The command's presence in the versioned protocol grants no capability. Generic click, type and Enter remain blocked for chat sending. `contactAssociation` and `identity` remain `NOT_VERIFIED`.

Selection and drafts expire or invalidate on material context change, grant revocation, navigation, task end or connection change. The private execution journal retains its existing `UNKNOWN` semantics; this checkpoint makes no new reservations because no send can execute.

Before any V0.5.3.6B rollout, a separately reviewed trusted capability boundary, identity binding, Chrome acceptance and post-send verification are required. An absent, false, invalid or even purportedly true setting does not activate sending in this build.
