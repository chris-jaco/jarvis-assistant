import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopTrayController,
  type DesktopTrayIcon,
  type DesktopTrayMenuItem,
  type DesktopTrayScheduler,
  type DesktopTrayTarget
} from '../desktop/tray-controller.js';

function fixture(options: { emptyIcon?: boolean; createFailure?: boolean; setupFailure?: boolean } = {}) {
  const listeners = new Set<() => void>();
  let destroyed = false;
  let creates = 0;
  let destroys = 0;
  let restores = 0;
  let quits = 0;
  let tooltip = '';
  let menu: readonly DesktopTrayMenuItem[] = [];
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const scheduler: DesktopTrayScheduler = {
    schedule: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    cancel: handle => { timers.delete(handle as number); }
  };
  const tray: DesktopTrayTarget = {
    on: (_event, listener) => { listeners.add(listener); },
    removeListener: (_event, listener) => { listeners.delete(listener); },
    setToolTip: value => { tooltip = value; },
    setContextMenu: () => { if (options.setupFailure) throw new Error('fixture'); },
    isDestroyed: () => destroyed,
    destroy: () => { if (!destroyed) { destroyed = true; destroys++; } }
  };
  const controller = new DesktopTrayController({
    loadIcon: () => ({ isEmpty: () => options.emptyIcon ?? false }) as DesktopTrayIcon,
    createTray: () => { creates++; if (options.createFailure) throw new Error('fixture'); return tray; },
    buildMenu: items => { menu = items; return { items }; },
    actions: { restore: () => { restores++; }, quit: () => { quits++; } },
    scheduler,
    restoreCoalesceMs: 200
  });
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  return {
    controller,
    click: () => [...listeners].forEach(listener => listener()),
    menuClick: (label: DesktopTrayMenuItem['label']) => menu.find(item => item.label === label)?.click(),
    flush,
    tray,
    state: () => ({ creates, destroys, restores, quits, tooltip, listeners: listeners.size, timers: timers.size, menu: menu.map(item => item.label) })
  };
}

test('initialization creates one complete Tray with Atlas tooltip and allowlisted menu', () => {
  const f = fixture();
  assert.equal(f.controller.initialize(), true);
  assert.equal(f.controller.initialize(), true);
  assert.equal(f.controller.available, true);
  assert.equal(f.controller.canHideSafely(), true);
  assert.deepEqual(f.state(), { creates: 1, destroys: 0, restores: 0, quits: 0, tooltip: 'Atlas', listeners: 1, timers: 0, menu: ['Abrir Atlas', 'Salir de Atlas'] });
});

test('invalid icon fails closed without creating a Tray or becoming available', () => {
  const f = fixture({ emptyIcon: true });
  assert.equal(f.controller.initialize(), false);
  assert.equal(f.controller.initialize(), false);
  assert.equal(f.controller.available, false);
  assert.deepEqual(f.state(), { creates: 0, destroys: 0, restores: 0, quits: 0, tooltip: '', listeners: 0, timers: 0, menu: [] });
});

for (const options of [{ createFailure: true }, { setupFailure: true }]) {
  test(`creation/setup failure is unavailable and destroys any partial Tray once: ${JSON.stringify(options)}`, () => {
    const f = fixture(options);
    assert.equal(f.controller.initialize(), false);
    assert.equal(f.controller.available, false);
    assert.equal(f.controller.initialize(), false);
    assert.equal(f.state().creates, 1);
    assert.equal(f.state().destroys, options.setupFailure ? 1 : 0);
  });
}

test('left click and double click coalesce into one lifecycle restore', () => {
  const f = fixture(); f.controller.initialize();
  f.click(); f.click();
  assert.equal(f.state().restores, 0);
  assert.equal(f.state().timers, 1);
  f.flush();
  assert.equal(f.state().restores, 1);
});

test('Open menu shares the restore coalescer while Exit delegates once to lifecycle quit', () => {
  const f = fixture(); f.controller.initialize();
  f.click(); f.menuClick('Abrir Atlas');
  assert.equal(f.state().timers, 1);
  f.flush();
  assert.equal(f.state().restores, 1);
  f.menuClick('Salir de Atlas'); f.menuClick('Salir de Atlas');
  assert.equal(f.state().quits, 1);
  assert.equal(f.controller.available, false);
});

test('Exit cancels a pending restore and never creates a parallel shutdown path', () => {
  const f = fixture(); f.controller.initialize();
  f.click();
  f.menuClick('Salir de Atlas');
  f.flush();
  assert.deepEqual({ restores: f.state().restores, quits: f.state().quits, timers: f.state().timers }, { restores: 0, quits: 1, timers: 0 });
});

test('dispose is idempotent, destroys once and invalidates late callbacks', () => {
  const f = fixture(); f.controller.initialize();
  f.click();
  const lateClick = f.click;
  f.controller.dispose(); f.controller.dispose();
  lateClick(); f.menuClick('Abrir Atlas'); f.menuClick('Salir de Atlas'); f.flush();
  assert.equal(f.controller.available, false);
  assert.deepEqual({ destroys: f.state().destroys, restores: f.state().restores, quits: f.state().quits, listeners: f.state().listeners }, { destroys: 1, restores: 0, quits: 0, listeners: 0 });
});

test('an externally destroyed Tray fails availability checks and cannot restore or quit', () => {
  const f = fixture(); f.controller.initialize();
  f.tray.destroy();
  f.click(); f.menuClick('Abrir Atlas'); f.menuClick('Salir de Atlas'); f.flush();
  assert.equal(f.controller.canHideSafely(), false);
  assert.deepEqual({ restores: f.state().restores, quits: f.state().quits }, { restores: 0, quits: 0 });
});
