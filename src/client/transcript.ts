import type { TranscriptEntry } from '../core/provider.js';
export class Transcript {
  private turns = new Map<string, { row: HTMLElement; text: HTMLElement }>();
  constructor(private readonly list: HTMLElement, private readonly scroller: HTMLElement) {}
  update(entries: TranscriptEntry[]): void {
    const pinned = this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop < 48;
    const keep = new Set(entries.map(entry => entry.id));
    for (const [id, turn] of this.turns) if (!keep.has(id)) { turn.row.remove(); this.turns.delete(id); }
    for (const entry of entries) {
      let turn = this.turns.get(entry.id);
      if (!turn) {
        const doc = this.list.ownerDocument; const row = doc.createElement('li'); const speaker = doc.createElement('span'); const text = doc.createElement('p');
        row.dataset.speaker = entry.role; speaker.className = 'speaker'; speaker.textContent = entry.role === 'user' ? 'Tú' : 'Atlas'; row.append(speaker, text);
        turn = { row, text }; this.turns.set(entry.id, turn); this.list.append(row);
      }
      if (turn.text.textContent !== entry.text) turn.text.textContent = entry.text;
    }
    if (pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.list.toggleAttribute('data-empty', entries.length === 0);
  }
}
