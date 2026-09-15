/** Scoped activity/audit layout. The client stylesheet owner imports this string. */
export const activityAlignmentStyles = `
.yuqi-activity-aligned,
.yuqi-file-audit-aligned {
  --activity-border: var(--yuqi-border, #e2e6ec);
  --activity-muted: var(--yuqi-text-muted, #647084);
  --activity-surface: var(--yuqi-surface, #fff);
  --activity-soft: var(--yuqi-surface-muted, #f7f9fc);
  --activity-accent: var(--dsw-alias-state-business-primary, #3569bf);
  min-width: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.yuqi-activity-aligned { container-type: inline-size; container-name: yuqi-activity; }
.yuqi-file-audit-aligned { container-type: inline-size; container-name: yuqi-audit; }
.yuqi-activity-aligned *, .yuqi-file-audit-aligned * { box-sizing: border-box; }
.yuqi-activity-aligned > .yuqi-filters {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 6px;
  background: var(--activity-soft); border: 1px solid var(--activity-border); border-radius: 9px;
}
.yuqi-activity-aligned > .yuqi-filters button { min-height: 40px; padding: 7px 18px; border-radius: 6px; }
.yuqi-activity-aligned > .yuqi-filters .yuqi-filter-active {
  background: var(--activity-surface); color: var(--activity-accent); box-shadow: 0 1px 4px #14233b12;
}
.yuqi-activity-aligned :is(button, select), .yuqi-file-audit-aligned button {
  font: inherit; max-width: 100%; white-space: normal; overflow-wrap: anywhere;
}
.yuqi-activity-aligned :is(button, .yuqi-secondary-action),
.yuqi-file-audit-aligned :is(button, .yuqi-secondary-action) {
  cursor: pointer;
  height: auto !important;
  min-height: 36px;
  line-height: 1.5 !important;
}
.yuqi-activity-aligned button:disabled, .yuqi-file-audit-aligned button:disabled { cursor: default; opacity: .55; }
.yuqi-activity-aligned :is(button, summary, select):focus-visible,
.yuqi-file-audit-aligned :is(button, summary):focus-visible,
.yuqi-activity-graph:focus-visible, .yuqi-activity-table-scroll:focus-visible, .yuqi-audit-file-list:focus-visible {
  outline: 2px solid var(--activity-accent); outline-offset: 3px;
}
.yuqi-activity-aligned :is(h3, h4), .yuqi-file-audit-aligned h4 { margin: 0 0 14px; font-size: 1em; font-weight: 650; }
.yuqi-activity-aligned p, .yuqi-file-audit-aligned p { margin: 10px 0; }
.yuqi-activity-aligned .yuqi-plan-explanation, .yuqi-file-audit-aligned > p { color: var(--activity-muted); font-size: .88em; }
.yuqi-activity-runs { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr); gap: 18px; align-items: start; }
.yuqi-activity-card { min-width: 0; border: 1px solid var(--activity-border); border-radius: 10px; padding: 20px; background: var(--activity-surface); }
.yuqi-activity-execution { display: flex; flex-direction: column; gap: 14px; }
.yuqi-execution-selected-header { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: #f8fafc; border: 0.5px solid rgba(0, 0, 0, 0.08); border-radius: 8px; }
.yuqi-execution-task-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.yuqi-task-id-badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 6px; background: #e8eef8; color: #2454f5; font-size: 12px; font-weight: 600; }
.yuqi-locate-task-btn { margin-left: auto; border: none; background: transparent; color: #2454f5; font-size: 12px; font-weight: 500; cursor: pointer; padding: 0; }
.yuqi-locate-task-btn:hover { text-decoration: underline; }
.yuqi-execution-goal-desc { margin: 0; font-size: 13px; line-height: 1.55; color: #0f1115; word-break: break-word; }
.yuqi-activity-route-records { grid-column: 1 / -1; }
.yuqi-activity-metadata, .yuqi-audit-metadata { display: grid; grid-template-columns: 105px minmax(0, 1fr); gap: 0 16px; margin: 10px 0; font-size: 13px; line-height: 1.5; }
.yuqi-activity-metadata dt, .yuqi-audit-metadata dt { color: var(--activity-muted); margin: 0; padding: 8px 0; border-bottom: 1px solid var(--activity-border); min-width: 0; }
.yuqi-activity-metadata dd, .yuqi-audit-metadata dd { color: #0f1115; margin: 0; padding: 8px 0; border-bottom: 1px solid var(--activity-border); min-width: 0; word-break: break-word; }
.yuqi-activity-file-preview { padding-inline-start: 20px; max-height: 180px; overflow: auto; }
.yuqi-activity-timeline .yuqi-activity-events { list-style: none; padding: 0 0 0 18px; margin: 8px 0; }
.yuqi-activity-events > li { position: relative; display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 14px; padding: 0 0 22px 22px; border-inline-start: 1px solid var(--activity-border); }
.yuqi-activity-event-time { padding-top: 8px; font-size: .85em; color: var(--activity-muted); font-variant-numeric: tabular-nums; word-break: break-word; }
.yuqi-activity-events > li::before { content: ''; position: absolute; width: 9px; height: 9px; inset-inline-start: -5px; top: 14px; border-radius: 50%; background: var(--activity-accent); }
.yuqi-activity-events > li:last-child { padding-bottom: 0; }
.yuqi-activity-events .yuqi-insight-section { border: 0; background: transparent; padding: 0; }
.yuqi-activity-events summary { padding: 7px 0; }
.yuqi-activity-events time { color: var(--activity-muted); font-size: .85em; font-variant-numeric: tabular-nums; }
.yuqi-activity-events .yuqi-insight-content { gap: 4px; }
.yuqi-activity-events p { margin: 3px 0; font-size: .9em; }
.yuqi-activity-events button { justify-self: start; margin-top: 6px; }
.yuqi-activity-graph { overflow: auto; border: 1px solid var(--activity-border); border-radius: 10px; background: var(--activity-soft); }
.yuqi-activity-graph-canvas { display: flex; align-items: flex-start; gap: 48px; position: relative; width: max-content; min-width: 100%; padding: 24px; }
.yuqi-activity-layer, .yuqi-activity-graph-canvas > .yuqi-insight-section { width: 260px; flex: 0 0 260px; min-width: 0; background: transparent; border: 0; }
.yuqi-activity-layer > summary { color: var(--activity-muted); padding-bottom: 16px; }
.yuqi-activity-layer > ul { list-style: none; padding: 0; display: grid; gap: 24px; }
.yuqi-activity-graph-node { position: relative; z-index: 1; border: 1px solid var(--activity-border); border-radius: 8px; background: var(--activity-surface); padding: 14px; font-size: .9em; }
.yuqi-activity-graph-node:hover, .yuqi-activity-graph-node:focus-within { border-color: var(--activity-accent); }
.yuqi-activity-graph-node .yuqi-insight-block { padding: 0; border: 0; background: transparent; }
.yuqi-activity-graph-node p { color: var(--activity-muted); font-size: .9em; }
.yuqi-activity-graph-node summary { cursor: pointer; }
.yuqi-activity-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; color: #96a9c5; overflow: visible; }
.yuqi-activity-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin: 20px 0 12px; }
.yuqi-activity-heading h3 { margin: 0; }
.yuqi-activity-heading > strong { font-size: 1.4em; font-variant-numeric: tabular-nums; }
.yuqi-activity-heading > span { color: var(--activity-muted); font-size: .85em; }
.yuqi-activity-table-scroll { overflow: auto; border: 1px solid var(--activity-border); border-radius: 9px; }
.yuqi-activity-usage-table { width: 100%; min-width: 680px; border-collapse: collapse; text-align: start; font-size: .9em; }
.yuqi-activity-usage-table table { width: 100%; border-collapse: collapse; margin-block: 12px; }
.yuqi-activity-usage-table caption { text-align: start; color: var(--activity-muted); padding: 12px 16px; }
.yuqi-activity-usage-table :is(th, td) { padding: 13px 16px; vertical-align: top; text-align: start; border-bottom: 1px solid var(--activity-border); }
.yuqi-activity-usage-table thead, .yuqi-activity-usage-table tfoot { background: var(--activity-soft); }
.yuqi-activity-usage-table :is(th, td):nth-child(n+3) { white-space: nowrap; font-variant-numeric: tabular-nums; text-align: end; }
.yuqi-activity-usage-table small { display: block; color: var(--activity-muted); font-weight: normal; max-width: 320px; }
.yuqi-activity-usage-table summary { cursor: pointer; color: var(--activity-accent); }
.yuqi-activity-usage-table tbody > tr:last-child > td { padding-top: 6px; }
.yuqi-activity-files > label { margin: 16px 0; }
.yuqi-activity-files select { min-height: 42px; width: 100%; }
.yuqi-audit-browser { display: grid; grid-template-columns: minmax(220px, .85fr) minmax(0, 1.55fr); border: 1px solid var(--activity-border); border-radius: 9px; overflow: hidden; margin-top: 18px; }
.yuqi-audit-file-list { list-style: none; padding: 8px; margin: 0; border-inline-end: 1px solid var(--activity-border); background: var(--activity-soft); }
.yuqi-audit-file-list li + li { margin-top: 6px; }
.yuqi-audit-file-list button { display: flex !important; flex-direction: column !important; align-items: flex-start !important; gap: 4px !important; width: 100%; text-align: start; padding: 10px 12px; border: 1px solid transparent; border-radius: 6px; background: transparent; height: auto !important; line-height: 1.4 !important; }
.yuqi-audit-file-list button:hover { background: var(--activity-surface); }
.yuqi-audit-file-list button[aria-pressed="true"] { border-color: var(--activity-accent); background: var(--activity-surface); }
.yuqi-audit-file-list button code { font-size: 12px; word-break: break-all; }
.yuqi-audit-file-list :is(span, small) { color: var(--activity-muted); font-size: .85em; }
.yuqi-audit-evidence { padding: 22px; min-width: 0; container:yuqi-audit / inline-size; background: var(--activity-surface); }
.yuqi-audit-evidence > p { color: var(--activity-muted); font-size: .9em; }
.yuqi-audit-source { display: inline-block; padding: 4px 9px; background: var(--activity-soft); border: 1px solid var(--activity-border); border-radius: 5px; font-size: .85em; }
.yuqi-project-summary-section { display: flex; flex-direction: column; gap: 20px; }
.yuqi-summary-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.yuqi-summary-content-grid { display: flex; flex-direction: column; gap: 16px; }
.yuqi-summary-block { display: flex; flex-direction: column; gap: 8px; padding: 16px; background: #f8fafc; border: 0.5px solid rgba(0, 0, 0, 0.07); border-radius: 10px; }
.yuqi-summary-block > strong { font-size: 13.5px; font-weight: 600; color: #0f1115; }
.yuqi-summary-block > p { margin: 0; font-size: 13px; line-height: 1.6; color: #3c4249; }
@container yuqi-activity (max-width: 720px) {
  .yuqi-activity-runs { grid-template-columns: minmax(0, 1fr); }
  .yuqi-activity-card { padding: 14px; }
}
@container yuqi-activity (max-width: 440px) {
  .yuqi-activity-events > li { grid-template-columns: minmax(0, 1fr); gap: 0; }
}
@container yuqi-audit (max-width: 600px) {
  .yuqi-audit-browser { grid-template-columns: minmax(0, 1fr); }
  .yuqi-audit-file-list { max-height: 240px; border-inline-end: 0; border-bottom: 1px solid var(--activity-border); }
}
@media (max-width: 760px) {
  .yuqi-activity-runs, .yuqi-audit-browser { grid-template-columns: minmax(0, 1fr); }
  .yuqi-activity-card, .yuqi-audit-evidence { padding: 14px; }
  .yuqi-audit-file-list { max-height: 240px; border-inline-end: 0; border-bottom: 1px solid var(--activity-border); }
  .yuqi-activity-aligned > .yuqi-filters button { padding-inline: 10px; }
  .yuqi-activity-metadata, .yuqi-audit-metadata { grid-template-columns: minmax(80px, .65fr) minmax(0, 1.4fr); gap: 0 10px; }
}
`
