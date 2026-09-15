/** Activity owns one content scroller. No rules apply to the review or task pages. */
export const activityLayoutStyles = `
.yuqi-workbench.yuqi-management #yuqi-panel-activity:not([hidden]) {
  display:flex; flex-direction:column; flex:1; min-height:0; min-width:0;
  overflow:hidden; padding:0; scrollbar-gutter:auto;
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity > .yuqi-activity-aligned {
  display:flex; flex-direction:column; flex:1; min-height:0; height:auto;
  overflow:hidden; gap:0;
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-activity-aligned > .yuqi-filters {
  position:relative; top:auto; z-index:1; flex:none;
  display:flex; flex-wrap:wrap; gap:4px 12px;
  margin:0; padding:10px 28px 0; border:0;
  border-bottom:1px solid var(--activity-border,#e2e6ec);
  border-radius:0; box-shadow:none; background:var(--activity-surface,#fff);
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-filters > button {
  border:0; border-bottom:2px solid transparent; border-radius:0;
  box-shadow:none; background:transparent; padding:10px 12px;
  color:var(--activity-muted,#647084); font-size:14px;
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-filters > button[aria-pressed="true"] {
  color:var(--activity-accent,#2454f5); border-bottom-color:currentColor;
  font-weight:600; background:transparent; box-shadow:none;
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-filters > button::after { display:none; }
.yuqi-activity-aligned > .yuqi-activity-content {
  min-width:0; min-height:0; flex:1; overflow:auto;
  overscroll-behavior:contain; scrollbar-gutter:stable; padding:20px 28px 24px;
}
.yuqi-activity-aligned .yuqi-activity-files { grid-template-columns:minmax(0,1fr); }
.yuqi-activity-aligned .yuqi-activity-files > label { min-width:0; }
.yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-plan-explanation {
  border:0; background:transparent; padding:0; margin:0 0 14px;
}
.yuqi-activity-aligned > .yuqi-activity-content > .yuqi-empty {
  min-height:180px; display:grid; align-content:center; text-align:center;
}
@media(max-width:760px) {
  .yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-activity-aligned > .yuqi-filters {
    gap:0 8px; padding:8px 16px 0;
  }
  .yuqi-workbench.yuqi-management #yuqi-panel-activity .yuqi-filters > button {
    font-size:13px; padding:8px 6px;
  }
  .yuqi-activity-aligned > .yuqi-activity-content { padding:16px; }
}
`
