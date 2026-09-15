/** Visual rules owned by TeamActivityView; kept under the activity root. */
export const activityViewStyles = `
.yuqi-activity-aligned .yuqi-route-summary { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:12px 2px 10px; color:var(--activity-muted); font-size:12px; }
.yuqi-activity-aligned .yuqi-route-summary strong { flex:none; color:var(--activity-muted); font-weight:500; }
.yuqi-activity-aligned .yuqi-route-viewer { min-width:0; background:var(--activity-surface); }
.yuqi-activity-aligned .yuqi-route-toolbar { display:flex; align-items:center; justify-content:flex-end; gap:12px; min-height:40px; padding:4px 2px; color:var(--activity-muted); font-size:12px; }
.yuqi-activity-aligned .yuqi-route-toolbar .yuqi-secondary-action { min-height:32px; }
.yuqi-activity-aligned .yuqi-route-viewer.is-fullscreen { position:fixed; inset:0; z-index:1300; display:flex; flex-direction:column; padding:18px 24px 24px; background:var(--activity-surface); }
.yuqi-activity-aligned .yuqi-route-viewer.is-fullscreen .yuqi-route-toolbar { flex:none; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-viewer.is-fullscreen .yuqi-task-route { flex:1; min-height:0; border:1px solid var(--activity-border); border-radius:10px; }
.yuqi-activity-aligned .yuqi-task-route { cursor:grab; touch-action:none; user-select:none; }
.yuqi-activity-aligned .yuqi-task-route.is-panning { cursor:grabbing; }
.yuqi-activity-aligned .yuqi-task-route :is(button,summary) { user-select:text; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-task-route { height:auto; min-height:0; flex:none; border:0; border-radius:0; background:var(--activity-surface); }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-activity-graph-canvas { justify-content:center; gap:72px; padding:12px 24px 20px; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-activity-layer,
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-activity-graph-canvas > .yuqi-insight-section { width:320px; flex-basis:320px; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-activity-layer > ul { gap:0; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-activity-graph-node { box-sizing:border-box; min-height:96px; padding:10px 12px; border-color:#d8e0eb; box-shadow:0 1px 2px rgb(20 31 52 / 4%); }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-shell { display:grid; grid-template-columns:minmax(0,1fr) max-content; grid-template-rows:auto auto; align-items:center; gap:5px 10px; min-width:0; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-select { grid-column:1 / -1; display:grid; grid-template-columns:max-content minmax(0,1fr); align-items:start; gap:8px; width:100%; padding:0; border:0; background:transparent; color:inherit; text-align:start; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-select strong { display:-webkit-box; min-width:0; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; white-space:normal; font-size:13px; line-height:1.4; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-id { grid-row:auto; align-self:start; font-size:13px; font-weight:700; line-height:1.4; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-status { grid-column:1; grid-row:2; justify-self:start; font-size:12px; line-height:1.3; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-status .yuqi-status { font-size:12px; }
.yuqi-activity-aligned .yuqi-route-node-dependency, .yuqi-activity-aligned .yuqi-route-node-action { margin:7px 0 0; }
.yuqi-activity-aligned .yuqi-route-node-action span { margin-inline-end:6px; color:var(--activity-muted); }
.yuqi-activity-aligned .yuqi-activity-run-records { padding-top:6px; }
.yuqi-activity-aligned .yuqi-activity-run-table { width:100%; min-width:720px; border-collapse:collapse; table-layout:fixed; font-size:13px; }
.yuqi-activity-aligned .yuqi-activity-run-table > thead th { padding:11px 14px; background:var(--activity-soft); color:#39445a; text-align:start; font-weight:600; border-bottom:1px solid var(--activity-border); }
.yuqi-activity-aligned .yuqi-activity-run-table > thead th:first-child { width:46%; }
.yuqi-activity-aligned .yuqi-activity-run-table > thead th:nth-child(2) { width:16%; }
.yuqi-activity-aligned .yuqi-activity-run-table > thead th:nth-child(3) { width:26%; }
.yuqi-activity-aligned .yuqi-activity-run-table > thead th:last-child { width:12%; }
.yuqi-activity-aligned .yuqi-activity-run-row > td { padding:0; border-bottom:1px solid var(--activity-border); }
.yuqi-activity-aligned .yuqi-activity-run-static-row > :is(th,td) { min-height:58px; padding:12px 14px; border-bottom:1px solid var(--activity-border); text-align:start; font-weight:400; }
.yuqi-activity-aligned .yuqi-activity-run-static-row > th { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:10px; }
.yuqi-activity-aligned .yuqi-activity-run-static-row > th span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.yuqi-activity-aligned .yuqi-activity-run-disclosure > summary { min-height:58px; padding:8px 14px; cursor:pointer; }
.yuqi-activity-aligned .yuqi-activity-run-summary-grid { display:inline-grid; width:calc(100% - 18px); vertical-align:middle; grid-template-columns:46% 16% 26% 12%; align-items:center; min-height:40px; }
.yuqi-activity-aligned .yuqi-activity-run-summary-grid > span:first-child { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:10px; min-width:0; padding-inline-end:18px; }
.yuqi-activity-aligned .yuqi-activity-run-summary-grid > span:first-child span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.yuqi-activity-aligned .yuqi-activity-run-disclosure[aria-disabled="true"] > summary { cursor:default; }
.yuqi-activity-aligned .yuqi-activity-run-detail { display:grid; gap:12px; padding:4px 20px 18px; background:#fbfcfe; border-top:1px solid var(--activity-border); }
.yuqi-activity-aligned .yuqi-activity-attempt-list { display:grid; gap:6px; margin:0; padding:0; list-style:none; }
.yuqi-activity-aligned .yuqi-activity-attempt-list li { display:grid; grid-template-columns:140px minmax(150px,1fr) minmax(120px,1fr) max-content; gap:10px; padding:9px 10px; border:1px solid var(--activity-border); border-radius:7px; background:var(--activity-surface); }
.yuqi-activity-aligned .yuqi-activity-attempt-list small { min-width:0; overflow-wrap:anywhere; color:var(--activity-muted); }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-details { grid-column:2; grid-row:2; margin:0; min-width:0; font-size:12px; line-height:1.3; }
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-route-node-details[open] { grid-column:1 / -1; grid-row:3; }
.yuqi-activity-aligned .yuqi-route-node-details > summary { cursor:pointer; color:var(--activity-muted); text-align:end; }
.yuqi-activity-aligned .yuqi-route-node-details > div { padding-top:5px; }
.yuqi-activity-aligned .yuqi-route-node-details p { margin:4px 0; white-space:normal; overflow-wrap:anywhere; }
.yuqi-activity-aligned .yuqi-activity-run-actions { display:flex; flex-wrap:wrap; gap:8px; }
.yuqi-activity-aligned .yuqi-activity-usage-section > .yuqi-empty { min-height:360px; display:grid; place-items:center; color:var(--activity-muted); }
.yuqi-activity-aligned .yuqi-usage-disclosure { margin:0 0 14px; border:1px solid var(--activity-border); border-radius:9px; background:var(--activity-surface); }
.yuqi-activity-aligned .yuqi-usage-disclosure > summary { padding:11px 14px; }
.yuqi-activity-aligned .yuqi-usage-summary { padding:0 14px 12px; }
.yuqi-activity-aligned .yuqi-usage-stats-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; border-top:1px solid var(--activity-border); }
.yuqi-activity-aligned .yuqi-usage-stat-card { min-width:0; padding:11px 14px 0 0; border:0; border-radius:0; background:transparent; box-shadow:none; }
.yuqi-activity-aligned .yuqi-activity-usage-table .yuqi-child-link { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; white-space:normal; text-align:start; }
.yuqi-activity-aligned .yuqi-activity-usage-table > thead { position:sticky; top:0; z-index:1; }
@container yuqi-activity (max-width:600px) {
  .yuqi-activity-aligned .yuqi-activity-attempt-list li { grid-template-columns:minmax(0,1fr); }
  .yuqi-activity-aligned .yuqi-usage-stats-grid { grid-template-columns:minmax(0,1fr); }
}
`
