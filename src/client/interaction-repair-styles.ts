/** Plugin-only interaction fixes; never target the native Host sidebar. */
export const interactionRepairStyles = `
.yuqi-settings-introduction{display:none!important}
.yuqi-task-configuration{border:0!important;border-radius:0!important;background:transparent!important;padding:12px 0!important;border-top:1px solid var(--yuqi-line)!important}
.yuqi-card-title-group{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.yuqi-card-title-group>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yuqi-history-checkbox{width:16px;height:16px;flex:none;accent-color:#0F1115;margin:0;cursor:pointer}
.yuqi-select-all-btn{margin-left:4px;font-size:14px;cursor:pointer}
.yuqi-task-configuration{margin-bottom:18px;padding:14px;border:1px solid var(--yuqi-line);border-radius:8px;background:var(--yuqi-soft);display:grid;gap:12px}.yuqi-task-configuration h4{margin:0;font-size:14px}.yuqi-task-configuration .yuqi-task-model-control{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end}.yuqi-task-configuration .yuqi-task-model-control label{min-width:0}.yuqi-task-configuration select{width:100%;min-width:0;max-width:100%}.yuqi-task-configuration .yuqi-task-model-control>span{grid-column:1/-1}
.yuqi-workbench-aligned .yuqi-task-workspace-scroll{display:flex;flex-direction:column;overflow:hidden;flex:1;min-height:0}
.yuqi-workbench-aligned .yuqi-task-master-detail{flex:1;min-height:0;overflow:hidden}
.yuqi-workbench-aligned .yuqi-task-picker,.yuqi-workbench-aligned .yuqi-task-list{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.yuqi-workbench-aligned .yuqi-task-picker>button{flex-shrink:0}
.yuqi-task-picker-heading{position:sticky;top:0;z-index:1;flex-shrink:0}
.yuqi-workbench-aligned .yuqi-team-message-fields{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;border:1px solid var(--yuqi-line);border-radius:9px;padding:10px;background:var(--yuqi-surface)}
.yuqi-workbench-aligned .yuqi-team-message-fields>label{grid-column:1;grid-row:2;max-width:420px}
.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message textarea{grid-column:1/-1;grid-row:1;width:100%;min-height:54px;height:54px;max-height:96px;border:0;padding:4px;resize:vertical}
.yuqi-workbench-aligned .yuqi-team-message-fields>button{grid-column:2;grid-row:2;min-height:34px;width:auto;padding:6px 14px;justify-self:end}
.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message{max-height:240px;overflow:auto}
.yuqi-review-layout{align-items:stretch}.yuqi-review-primary{min-height:320px}.yuqi-review-empty{align-self:center;text-align:center;padding:30px;line-height:1.7;color:var(--yuqi-muted)}
.yuqi-workbench-aligned #yuqi-panel-activity{padding-top:0;overflow:auto}
.yuqi-activity-aligned>.yuqi-filters{position:sticky;top:0;z-index:10;background:var(--activity-surface,#fff);border-radius:0;border:0;border-bottom:1px solid var(--activity-border,#e2e6ec);padding:14px 0 12px;margin:0 0 16px;box-shadow:0 2px 8px #14233b0a}
.yuqi-file-audit-aligned button,.yuqi-card-direct-actions button{border:1px solid var(--dsw-alias-border-l1,#d9dfe8);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;min-height:34px;padding:6px 12px;font:inherit;cursor:pointer}
.yuqi-file-audit-aligned button:disabled,.yuqi-card-direct-actions button:disabled{opacity:.5;cursor:not-allowed}
.yuqi-card-direct-actions{display:flex;flex-wrap:wrap;gap:8px}.yuqi-card-action-hint{font-size:12px;color:var(--yuqi-muted);line-height:1.6;margin:4px 0}
.yuqi-card-direct-actions button.yuqi-archive-highlight{background:#0F1115!important;color:#FFFFFF!important;border:none!important;font-weight:500;box-shadow:none}
.yuqi-card-direct-actions button.yuqi-archive-highlight:hover{background:#353638!important}
.yuqi-card-action-ready{color:#0F1115!important;font-weight:500}
.yuqi-knowledge-actions{display:grid;gap:8px;margin:10px 0}
.yuqi-knowledge-refresh-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.yuqi-knowledge-feedback{font-size:12px;color:var(--dsw-alias-state-business-primary,#3267da);font-weight:500}
.yuqi-knowledge-help{font-size:12px;color:var(--yuqi-muted,#667080);line-height:1.6;margin:0}
.yuqi-timeline-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.yuqi-timeline-header>p{margin:0;flex:1;min-width:240px}
.yuqi-timeline-actions{flex:none}
.yuqi-timeline-confirm-card{padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#e2e6ec);border-radius:8px;background:var(--yuqi-soft,#f7f9fc);margin:10px 0 16px;display:grid;gap:10px}
.yuqi-timeline-confirm-card>p{margin:0;font-size:13px;line-height:1.6}
.yuqi-timeline-confirm-actions{display:flex;align-items:center;gap:10px}
.yuqi-team-card>.yuqi-task-command{margin-top:14px;align-items:center}.yuqi-team-card>header>strong{min-height:54px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.yuqi-usage-stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:14px 0 22px}
.yuqi-usage-stat-card{background:var(--yuqi-soft,#f7f9fc);border:1px solid var(--yuqi-line,#e2e6ec);border-radius:10px;padding:16px;display:grid;gap:6px}
.yuqi-usage-stat-label{font-size:12px;color:var(--yuqi-muted,#667080);font-weight:500}
.yuqi-usage-stat-value{font-size:20px;font-weight:600;color:var(--yuqi-text,#1d2129);line-height:1.3;font-variant-numeric:tabular-nums}
.yuqi-usage-stat-desc{font-size:12px;color:var(--yuqi-muted,#667080)}
.yuqi-activity-usage-table{border:1px solid var(--yuqi-line,#e2e6ec);border-radius:8px;overflow:hidden;background:var(--yuqi-surface,#fff)}
.yuqi-activity-usage-table th,.yuqi-activity-usage-table td{border-bottom:1px solid var(--yuqi-line,#e2e6ec)}
.yuqi-session-menu{animation:yuqi-menu-enter .12s ease-out;overscroll-behavior:contain}
.yuqi-session-menu button:focus-visible{outline:2px solid #3569df;outline-offset:-2px}
@keyframes yuqi-menu-enter{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:761px) and (min-height:801px){.yuqi-workbench-aligned .yuqi-task-list{height:100%}}
@media(max-width:760px),(max-height:800px){.yuqi-workbench-aligned .yuqi-panel-body{display:block;overflow:auto}.yuqi-workbench-aligned #yuqi-panel-tasks{display:block;overflow:visible}.yuqi-workbench-aligned .yuqi-task-workspace-scroll{display:block;overflow:visible}.yuqi-workbench-aligned .yuqi-task-master-detail{overflow:visible;align-items:stretch}.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message{max-height:none;overflow:visible}.yuqi-workbench-aligned .yuqi-workbench-page{overflow:visible}.yuqi-review-primary{min-height:200px}}
@media(prefers-reduced-motion:reduce){.yuqi-session-menu{animation:none}}
.yuqi-sidecar-header-actions{display:flex;align-items:center;gap:6px}
.yuqi-sidecar-close{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:#6B7280;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.yuqi-sidecar-close:hover{background:rgba(0,0,0,.06);color:#0F1115}
.yuqi-sidecar-close:focus-visible{outline:2px solid #3267da;outline-offset:2px}
.yuqi-sidecar-status-collapsed-wrap{position:fixed;inset-block-end:16px;inset-inline-end:16px;z-index:1160;display:inline-flex;align-items:center;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#dfe4eb);border-radius:8px;box-shadow:0 4px 14px rgba(18,31,55,.1);padding-right:4px}
.yuqi-sidecar-status-collapsed-wrap .yuqi-sidecar-status-collapsed{position:static;border:0;box-shadow:none;background:transparent;padding:8px 10px}
.yuqi-sidecar-close-mini{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:#8C95A6;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.yuqi-sidecar-close-mini:hover{background:rgba(0,0,0,.08);color:#0F1115}
.yuqi-sidecar-close-mini:focus-visible{outline:2px solid #3267da;outline-offset:2px}
`
