// =============================================================================
// dashboard/panels/StatusBar.tsx — bottom-of-screen telemetry strip.
// =============================================================================

export function StatusBar() {
  return (
    <footer
      className="col-span-3 flex items-center gap-3 px-2 sm:px-3 border-t border-[var(--border)] glass-3 text-[7.5px] font-mono uppercase tracking-wider text-[var(--rwr-t3)] overflow-x-auto"
      style={{ gridRow: 4, gridColumn: '1 / -1', height: 20 }}
    >
      <span className="shrink-0 flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-[var(--signal-green)] shadow-[0_0_4px_var(--signal-green)] animate-pulse" />
        ONLINE
      </span>
      <span className="shrink-0 text-[var(--rwr-t2)]">CONNECTION 32MS</span>
      <span className="shrink-0">SAT LINK NOMINAL</span>
      <span className="shrink-0">DETECTIONS 14</span>
      <span className="shrink-0">GIS LAYERS 3</span>
      <span className="shrink-0">SCENES 42</span>
      <span className="ml-auto shrink-0 text-[var(--signal-cyan)]">SENTINEL v4.2</span>
    </footer>
  );
}
