// A research-only equipment inspection, independent of the passport scene.
// This is an authored state machine, not a production web route.
export function equipmentWorlds({ leakVoltage = false, leakFuseByAvailability = false, shortcutViaClipboard = false } = {}) {
  return ['stable', 'unstable'].flatMap(voltage => ['intact', 'blown'].map(fuse => ({
    id: `${voltage}-${fuse}`, voltage, fuse,
    answer: voltage === 'stable' && fuse === 'intact' ? 'release' : 'hold',
    initialState: { panelOpen: false, voltageSeen: false, fuseSeen: false, clipboardMoved: false },
    observe(state) {
      return {
        panel: state.panelOpen ? 'open' : 'closed',
        voltage: state.voltageSeen || leakVoltage ? voltage : null,
        fuse: state.fuseSeen ? fuse : null,
        clipboard: state.clipboardMoved ? 'moved' : 'resting',
      };
    },
    enabled(state) {
      const actions = [];
      if (!state.panelOpen) actions.push('openPanel');
      if (state.panelOpen && !state.voltageSeen) actions.push('measureVoltage');
      if (!state.fuseSeen && (!leakFuseByAvailability || fuse === 'blown')) actions.push('inspectFuse');
      if (!state.clipboardMoved) actions.push('moveClipboard');
      return actions;
    },
    step(state, action) {
      const next = { ...state };
      if (action === 'openPanel') next.panelOpen = true;
      else if (action === 'measureVoltage') next.voltageSeen = true;
      else if (action === 'inspectFuse') next.fuseSeen = true;
      else if (action === 'moveClipboard') {
        next.clipboardMoved = true;
        if (shortcutViaClipboard) next.voltageSeen = true;
      } else throw new Error(`Unknown action: ${action}`);
      return next;
    },
  })));
}
