import type { PendingConfirmation } from '../provider/tools.js';
// Presentation only. The bridge and backend own eligibility, frozen inputs,
// decisions and execution. Never build action parameters from the dialog.
export class ConfirmationDialog {
  private pending: PendingConfirmation | null = null;
  private submitting?: string;
  private expiry?: ReturnType<typeof setTimeout>;
  private restore?: HTMLElement;
  constructor(private readonly dialog: HTMLDialogElement, private readonly summary: HTMLElement, private readonly status: HTMLElement, private readonly editor:HTMLTextAreaElement, private approve: HTMLButtonElement, private reject: HTMLButtonElement, private readonly decide: (approved: boolean, id: string,editedContent?:string) => void,private readonly presented:(id:string,visible:boolean)=>void=()=>{}) {
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
    this.status.textContent = 'Esperando el resultado…'; this.decide(approved, pending.confirmationId,approved&&pending.review?this.editor.value:undefined);
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
      this.summary.textContent = this.status.textContent = '';this.editor.value='';this.editor.hidden=true; return;
    }
    const changed = this.pending?.confirmationId !== pending.confirmationId;
    if (changed) { this.submitting = undefined; this.freshControls(); }
    this.pending = structuredClone(pending);
    this.summary.textContent = pending.summary; // Frozen backend summary, text only.
    this.editor.hidden=!pending.review;if(pending.review){this.editor.value=pending.review.content;this.editor.maxLength=pending.review.maxLength;this.editor.setAttribute('aria-label',pending.review.label);}
    const disabled = Boolean(this.submitting) || pending.expiresAt <= Date.now();
    this.approve.disabled = this.reject.disabled = disabled;
    this.status.textContent = this.submitting ? 'Esperando el resultado…' : disabled ? 'Esta confirmación caducó.' : pending.review ? 'Revisá el texto y elegí confirmar o cancelar aquí.' : 'Podés responder por voz o elegir aquí.';
    if (!this.dialog.open) {
      this.restore = this.dialog.ownerDocument.activeElement as HTMLElement | undefined;
      try{this.dialog.showModal();this.reject.focus();}catch{this.approve.disabled=this.reject.disabled=true;this.status.textContent='No se pudo abrir esta confirmación.';this.presented(pending.confirmationId,false);return;}
    } else if (changed) this.reject.focus();
    // Creation/delivery is not presentation. Acknowledge only after the exact
    // pending confirmation owns an actually open dialog.
    if(changed&&this.dialog.open&&this.pending?.confirmationId===pending.confirmationId)this.presented(pending.confirmationId,true);
    this.expiry = setTimeout(() => { if (this.pending?.confirmationId === pending.confirmationId) { this.approve.disabled = this.reject.disabled = true; this.status.textContent = 'Esta confirmación caducó.'; } }, Math.max(0, pending.expiresAt - Date.now()));
  }
  dispose(): void { this.update(null); this.approve.removeEventListener('click', this.confirm); this.reject.removeEventListener('click', this.cancel); this.dialog.removeEventListener('cancel', this.escape); }
}
