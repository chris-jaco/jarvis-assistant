import type { BrowserExecutionState } from '../browser/execution-state.js';
interface ResponseAdmission {
  allowed: boolean;
  accepted: boolean;
  tools: boolean;
  message?: string;
  generation: number;
}
// Presentation only: no capture-track changes, response cancellation or tool
// scheduling. One initial response may acknowledge; subsequent work is silent.
export class PresentationGate {
  private generation = 0;
  private state?: BrowserExecutionState;
  private accepted = false;
  private ordinaryPermit = false;
  private active?: string;
  private responses = new Map<string, ResponseAdmission>();
  private items = new Map<string, { allowed: boolean }>();
  private internalItems = new Set<string>();
  constructor(private readonly muteOutput: (muted: boolean) => void) { muteOutput(true); }
  internal(id: string): void {
    this.internalItems.add(id);
    while (this.internalItems.size > 1000) this.internalItems.delete(this.internalItems.values().next().value!);
  }
  userVisible(id: string): boolean { return !this.internalItems.has(id); }
  turn(confirmationActive = false): void {
    if (confirmationActive || ['WAITING_ACCESS','WAITING_MANUAL'].includes(this.state ?? '')) return;
    if (this.state === 'RUNNING' || this.state === 'RECOVERING_CONTEXT') { ++this.generation; this.active=undefined; this.muteOutput(true); return; }
    ++this.generation; this.active = undefined; this.state = 'TASK_ACCEPTED'; this.accepted = false; this.ordinaryPermit = false; this.muteOutput(true);
  }
  update(state: BrowserExecutionState): void { this.state = state; if(state==='RUNNING'||state==='RECOVERING_CONTEXT')this.ordinaryPermit=false; }
  beginBrowser(): void {
    this.update('RUNNING');
    const response = this.active ? this.responses.get(this.active) : undefined;
    // An acknowledgement already created belongs to the accepted response.
    // A tool-first response cannot acquire acknowledgement eligibility later.
    if (response && !response.message) response.allowed = false;
    if (!response?.allowed) this.muteOutput(true);
  }
  tool(id = this.active): void {
    const response = id ? this.responses.get(id) : undefined;
    if (response) { response.tools = true; if (response.accepted && !response.message) response.allowed = false; }
  }
  response(id: string): void {
    if (this.responses.has(id)) return;
    const accepted = !this.accepted && (!this.state || this.state === 'TASK_ACCEPTED');
    if (accepted) this.accepted = true;
    const allowed = accepted || this.ordinaryPermit || !!this.state && !['RUNNING','RECOVERING_CONTEXT','TASK_ACCEPTED'].includes(this.state);
    this.ordinaryPermit = false;
    this.responses.set(id, { allowed, accepted, tools: false, generation: this.generation });
    this.active = id;
    while (this.responses.size > 256) this.responses.delete(this.responses.keys().next().value!);
    this.muteOutput(true);
  }
  item(responseId: string, item: string, type = 'message'): void {
    if (this.items.has(item)) return;
    const response = this.responses.get(responseId);
    if (type === 'function_call') { this.tool(responseId); return; }
    const allowed = !!response?.allowed && (!response.accepted || !response.tools && !response.message);
    if (response?.accepted) {
      if (allowed) response.message = item;
      else { response.allowed = false; this.muteOutput(true); }
    }
    this.items.set(item, { allowed });
    while (this.items.size > 1000) this.items.delete(this.items.keys().next().value!);
  }
  visible(item: string): boolean { return this.items.get(item)?.allowed === true; }
  audible(id?: string): boolean { return !!(id && this.responses.get(id)?.allowed && this.responses.get(id)?.generation === this.generation); }
  playback(id?: string): void { this.muteOutput(!this.audible(id)); }
  done(id: string): boolean {
    if (this.active === id) this.active = undefined;
    const response=this.responses.get(id);
    if (response?.generation===this.generation && response.tools && (!this.state || this.state==='TASK_ACCEPTED')) this.ordinaryPermit=true;
    // No second model roundtrip to replay/replace an initial response. Tool
    // execution starts independently of acknowledgement playback/completion.
    return false;
  }
  close(): void { this.responses.clear(); this.items.clear(); this.internalItems.clear(); this.state = undefined; this.active = undefined; this.muteOutput(true); }
}
