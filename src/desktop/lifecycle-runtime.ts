import { DesktopLifecycleCoordinator, type DesktopCleanupOutcome, type DesktopLifecycleState } from './lifecycle-coordinator.js';
import type { DesktopCleanupProtocol, DesktopCleanupReason } from './cleanup-protocol.js';
import type { DesktopIpcController } from './ipc.js';

export interface DesktopLifecycleRuntimeDependencies {
  cleanup: Pick<DesktopCleanupProtocol, 'request' | 'dispose'>;
  ipc: Pick<DesktopIpcController, 'abortPending' | 'dispose'>;
  hideWindow(): void;
  restoreWindow(): void;
  destroyWindow(): void;
  stopCore(): Promise<void>;
  showHideFailure(): Promise<void>;
  showCoreCrash(): Promise<void>;
  quitApplication(): void;
}

/**
 * Electron-side effect owner. The coordinator remains the sole state authority;
 * this class maps explicit transitions to bounded, idempotent effects.
 */
export class DesktopLifecycleRuntime {
  private readonly coordinator: DesktopLifecycleCoordinator;
  private hideEffect?:Promise<DesktopCleanupOutcome>;

  constructor(private readonly dependencies:DesktopLifecycleRuntimeDependencies){
    this.coordinator=new DesktopLifecycleCoordinator({
      cleanupForHide:()=>this.cleanup('HIDE'),
      terminate:reason=>this.terminate(reason)
    });
  }

  get state():DesktopLifecycleState{return this.coordinator.state;}

  ready():void{this.coordinator.ready(false);}

  hide():Promise<DesktopCleanupOutcome>{
    if(this.hideEffect)return this.hideEffect;
    const operation=(async()=>{
      const outcome=await this.coordinator.hide();
      if(outcome==='COMPLETED'&&this.coordinator.state==='HIDDEN_DISCONNECTED')this.dependencies.hideWindow();
      else if(this.coordinator.state==='VISIBLE_ERROR'){
        this.dependencies.restoreWindow();
        await this.dependencies.showHideFailure();
      }
      return outcome;
    })();
    const wrapped=operation.finally(()=>{if(this.hideEffect===wrapped)this.hideEffect=undefined;});
    this.hideEffect=wrapped;
    return wrapped;
  }

  restore():boolean{
    const before=this.coordinator.state;
    if(['SHUTTING_DOWN','CORE_FAILED','TERMINATED','STARTING'].includes(before))return false;
    const transition=this.coordinator.restore();
    // A second instance also focuses an already-visible owner. During an
    // in-flight cleanup it supersedes the hide, but the renderer itself keeps
    // reconnection blocked until its authoritative close finishes.
    if(transition.accepted||['VISIBLE_DISCONNECTED','VISIBLE_ACTIVE','VISIBLE_ERROR'].includes(before)){
      this.dependencies.restoreWindow();
      return true;
    }
    return false;
  }

  quit():Promise<void>{return this.coordinator.quit();}
  coreCrash():Promise<void>{return this.coordinator.coreCrash();}

  private async cleanup(reason:DesktopCleanupReason):Promise<DesktopCleanupOutcome>{
    this.dependencies.ipc.abortPending(reason);
    const result=await this.dependencies.cleanup.request(reason);
    return result.status;
  }

  private async terminate(reason:'QUIT'|'CORE_CRASH'):Promise<void>{
    this.dependencies.ipc.abortPending(reason);
    // Cleanup is bounded by DesktopCleanupProtocol. Failure/UNKNOWN never
    // retries an action and cannot prevent an explicit terminal shutdown.
    await this.dependencies.cleanup.request(reason).catch(()=>undefined);
    this.dependencies.cleanup.dispose();
    this.dependencies.ipc.dispose();
    await this.dependencies.stopCore().catch(()=>undefined);
    if(reason==='CORE_CRASH'){
      this.dependencies.restoreWindow();
      await this.dependencies.showCoreCrash().catch(()=>undefined);
    }
    this.dependencies.destroyWindow();
    this.dependencies.quitApplication();
  }
}
