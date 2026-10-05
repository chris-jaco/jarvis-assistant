import type { PendingConfirmation } from '../provider/tools.js';
// Presentation only. The bridge and backend own eligibility, frozen inputs,
// decisions and execution. Never build action parameters from the dialog.
export class ConfirmationDialog {
  private pending: PendingConfirmation | null = null;
  private submitting?: string;
  private expiry?: ReturnType<typeof setTimeout>;
  private restore?: HTMLElement;
  constructor(private readonly dialog: HTMLDialogElement, private readonly summary: HTMLElement, private readonly status: HTMLElement, private approve: HTMLButtonElement, private reject: HTMLButtonElement, private readonly decide: (approved: boolean, id: string) => void) {
    approve.addEventListener('click', this.confirm); reject.addEventListener('click', this.cancel);
    dialog.addEventListener('cancel', this.escape);
  }
  private confirm = () => this.submit(true);
  private cancel = () => this.submit(false);
  private escape = (event: Event) => { event.preventDefault(); this.submit(false); };
  private submit(approved: boolean): void {
    const pending = this.pending;
    if (!pending || this.submitting || pending.expiresAt <= Date.now()) return;
    this.submitting = pending.confirmationId; this.approve.disabled = this.reject.disabled = true;
    this.status.textContent = 'Esperando el resultado…'; this.decide(approved, pending.confirmationId);
  }
  private freshControls(): void {
    // A button belonging to an old dialog must not approve a later action, even
    // if a queued/programmatic click still holds its old DOM reference.
    const replace = (old: HTMLButtonElement, listener: () => void): HTMLButtonElement => {
      old.removeEventListener('click', listener); old.disabled = true;
      const fresh = old.cloneNode(true) as HTMLButtonElement; old.replaceWith(fresh); fresh.addEventListener('click', listener); return fresh;
    };
    this.approve = replace(this.approve, this.confirm); this.reject = replace(this.reject, this.cancel);
  }
  update(pending: PendingConfirmation | null): void {
    clearTimeout(this.expiry); this.expiry = undefined;
    if (!pending) {
      this.pending = null; this.submitting = undefined; this.approve.disabled = this.reject.disabled = true;
      if (this.dialog.open) { this.dialog.close(); if (this.restore?.isConnected) this.restore.focus(); }
      this.summary.textContent = this.status.textContent = ''; return;
    }
    const changed = this.pending?.confirmationId !== pending.confirmationId;
    if (changed) { this.submitting = undefined; this.freshControls(); }
    this.pending = { confirmationId: pending.confirmationId, summary: pending.summary, expiresAt: pending.expiresAt };
    this.summary.textContent = pending.summary; // Frozen backend summary, text only.
    const disabled = Boolean(this.submitting) || pending.expiresAt <= Date.now();
    this.approve.disabled = this.reject.disabled = disabled;
    this.status.textContent = this.submitting ? 'Esperando el resultado…' : disabled ? 'Esta confirmación caducó.' : 'Podés responder por voz o elegir aquí.';
    if (!this.dialog.open) {
      this.restore = this.dialog.ownerDocument.activeElement as HTMLElement | undefined;
      this.dialog.showModal(); this.reject.focus();
    } else if (changed) this.reject.focus();
    this.expiry = setTimeout(() => { if (this.pending?.confirmationId === pending.confirmationId) { this.approve.disabled = this.reject.disabled = true; this.status.textContent = 'Esta confirmación caducó.'; } }, Math.max(0, pending.expiresAt - Date.now()));
  }
  dispose(): void { this.update(null); this.approve.removeEventListener('click', this.confirm); this.reject.removeEventListener('click', this.cancel); this.dialog.removeEventListener('cancel', this.escape); }
}
