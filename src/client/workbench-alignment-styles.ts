/** Inner workbench layout only. The shared modal owns viewport size and placement. */
export const workbenchAlignmentStyles = `
.yuqi-workbench-aligned{--yuqi-accent:var(--dsw-alias-state-business-primary,#2454f5);display:flex;flex-direction:column;overflow:hidden}
.yuqi-workbench-aligned .yuqi-workbench-topbar{display:flex;align-items:center;justify-content:space-between;flex:none;padding:20px 32px 8px;gap:16px}
.yuqi-workbench-aligned .yuqi-workbench-back{display:inline-flex;align-items:center;gap:12px;border:0;background:transparent;color:inherit;padding:8px 0;font:inherit;font-size:16px;cursor:pointer}
.yuqi-workbench-aligned .yuqi-close-button{display:grid;place-items:center;min-width:36px;min-height:36px}
.yuqi-workbench-aligned .yuqi-panel-header{display:flex;align-items:flex-start;gap:24px;padding:12px 32px 18px;border:0}
.yuqi-workbench-title{flex:1;min-width:0}.yuqi-workbench-title-line{display:flex;align-items:center;flex-wrap:wrap;gap:14px}
.yuqi-workbench-aligned .yuqi-panel-header h2{font-size:27px;font-weight:650;line-height:1.35;overflow-wrap:anywhere;margin:0}
.yuqi-workbench-aligned .yuqi-panel-header .yuqi-workbench-counts{font-size:14px;margin:10px 0 0;color:var(--yuqi-muted);max-height:none;overflow:visible}
.yuqi-workbench-aligned .yuqi-panel-header>.yuqi-team-controls{flex:0 1 auto;max-width:52%;margin:0;margin-left:auto;padding:0;border:0;justify-items:end}
.yuqi-workbench-aligned .yuqi-panel-header .yuqi-team-control-actions{justify-content:flex-end}
.yuqi-workbench-aligned .yuqi-panel-header .yuqi-cancel-confirm{text-align:right}
.yuqi-workbench-aligned .yuqi-panel-header .yuqi-cancel-confirm>div{justify-content:flex-end}
.yuqi-workbench-aligned>.yuqi-management-tabs{padding:0 32px;gap:42px;flex:none}
.yuqi-workbench-aligned>.yuqi-management-tabs>button{font-size:16px;min-height:52px;padding:12px 4px}
.yuqi-workbench-aligned>.yuqi-management-tabs>button[aria-pressed=true]{color:var(--yuqi-accent);border-bottom:3px solid var(--yuqi-accent);border-radius:0;background:transparent}
.yuqi-workbench-aligned .yuqi-panel-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.yuqi-workbench-aligned .yuqi-workbench-page{padding:24px 32px;min-width:0}
.yuqi-workbench-aligned .yuqi-task-workspace-scroll{padding:16px 32px;min-height:0;overflow:auto}
.yuqi-workbench-filter-details{margin:0 0 12px;color:var(--yuqi-muted);font-size:12px}
.yuqi-workbench-filter-details>summary{cursor:pointer;padding:6px 0}.yuqi-workbench-filter-details[open]>summary{margin-bottom:10px}
.yuqi-workbench-aligned .yuqi-task-master-detail{grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:24px;align-items:stretch}
.yuqi-workbench-aligned .yuqi-task-picker{display:flex;flex-direction:column;gap:0;padding:0;max-height:none;border:1px solid var(--yuqi-line);border-radius:8px;overflow:hidden}
.yuqi-task-picker-heading{display:flex;justify-content:space-between;padding:13px 18px;background:var(--yuqi-soft);border-bottom:1px solid var(--yuqi-line);font-size:14px}
.yuqi-workbench-aligned .yuqi-task-picker>button{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;column-gap:12px;row-gap:4px;margin:3px;border-radius:6px;padding:13px 14px;min-height:62px;border:1px solid transparent}
.yuqi-workbench-aligned .yuqi-task-picker>button[aria-pressed=true]{border-color:var(--yuqi-accent);background:color-mix(in srgb,var(--yuqi-accent) 6%,var(--yuqi-surface))}
.yuqi-workbench-aligned .yuqi-task-picker strong{font-size:15px;font-weight:550;line-height:1.5}
.yuqi-workbench-aligned .yuqi-task-picker small{grid-column:2 / -1;font-size:12px;line-height:1.5}
.yuqi-picker-index{width:27px;height:27px;display:grid;place-items:center;border:1px solid var(--yuqi-line);border-radius:50%;font-size:13px}
.yuqi-task-picker [aria-pressed=true] .yuqi-picker-index,.yuqi-task-picker [aria-pressed=true] .yuqi-picker-status{color:var(--yuqi-accent)}
.yuqi-picker-status{font-size:12px;white-space:normal;text-align:right;max-width:100px}
.yuqi-workbench-aligned .yuqi-task-row{padding:20px;min-width:0}.yuqi-task-inspector-title{margin:0 0 18px;padding-bottom:18px;border-bottom:1px solid var(--yuqi-line);font-size:18px;line-height:1.5;overflow-wrap:anywhere}
.yuqi-task-properties{margin:0 0 20px;display:grid;gap:18px}.yuqi-task-properties>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:16px;font-size:14px;line-height:1.65}.yuqi-task-properties dt{color:var(--yuqi-muted)}.yuqi-task-properties dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.yuqi-task-technical{margin-top:20px;border-top:1px solid var(--yuqi-line);padding-top:12px}.yuqi-task-technical>summary{cursor:pointer;font-size:13px;color:var(--yuqi-muted);padding:8px 0}
.yuqi-task-original>summary{padding:0 0 14px;cursor:pointer;color:var(--yuqi-accent);font-size:13px}.yuqi-task-original:not([open]){margin-bottom:12px}
.yuqi-task-row:not(.yuqi-task-inspector)>.yuqi-task-technical{border:0;padding:0;margin:0}.yuqi-task-row:not(.yuqi-task-inspector)>.yuqi-task-technical>summary{display:none}
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-details{padding:12px 0}.yuqi-inspector-open-child{margin-top:12px}
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-technical>.yuqi-task-heading,
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-technical>.yuqi-task-plan-note,
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-technical>.yuqi-task-meta,
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-technical>.yuqi-task-next{display:none}
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-task-technical>.yuqi-task-details{margin:0;padding:10px 0 0;border-left:0;background:transparent}
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-file-audit-empty{padding:10px 12px;border:1px solid var(--yuqi-line);border-radius:8px;background:var(--yuqi-soft)}
.yuqi-workbench-aligned .yuqi-task-inspector .yuqi-file-audit-empty p{margin:4px 0 0;color:var(--yuqi-muted)}
.yuqi-controller-recovery{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:10px 16px;margin:0 0 14px;padding:14px 16px;border:1px solid #d9e2f2;border-radius:9px;background:#f7faff}
.yuqi-controller-recovery p{margin:4px 0 0;line-height:1.5}.yuqi-controller-recovery small{grid-column:1/-1;color:var(--yuqi-muted)}
.yuqi-controller-recovery details{margin-top:8px}.yuqi-controller-recovery details>summary{cursor:pointer;color:var(--yuqi-muted);font-size:12px}.yuqi-controller-recovery ul{display:grid;gap:6px;margin:8px 0 0;padding:0;list-style:none}.yuqi-controller-recovery li{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:2px 10px;padding-top:6px;border-top:1px solid #e4eaf4}.yuqi-controller-recovery li>small{grid-column:1/-1}
.yuqi-controller-recovery>.yuqi-command-error,.yuqi-controller-recovery>.yuqi-command-notice{grid-column:1/-1;margin:0}
.yuqi-controller-recovery-pending{grid-column:1/-1;display:flex;align-items:center;flex-wrap:wrap;gap:8px}.yuqi-controller-recovery-pending p{margin:0}
.yuqi-controller-recovery-accepted{grid-column:1/-1;display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--yuqi-muted)}
@media(max-width:760px){.yuqi-controller-recovery{grid-template-columns:minmax(0,1fr)}.yuqi-controller-recovery>.yuqi-primary-action{justify-self:start}}
.yuqi-workbench-aligned .yuqi-manual-control{display:flex;flex-direction:column;align-items:stretch;gap:12px;padding:18px;border:1px solid var(--yuqi-line);border-radius:8px;background:var(--yuqi-soft);margin:0}
.yuqi-manual-control h3{font-size:17px;line-height:1.5;margin:0}.yuqi-manual-control p{font-size:13px;line-height:1.65;margin:0;overflow-wrap:anywhere}.yuqi-manual-lead,.yuqi-manual-return-note{color:var(--yuqi-muted)}
.yuqi-manual-control .yuqi-manual-safety{order:10;border-top:1px solid var(--yuqi-line);padding-top:10px;font-size:12px;color:var(--yuqi-muted)}.yuqi-manual-safety>summary{cursor:pointer;padding:4px 0}.yuqi-manual-safety p{margin-top:8px}
.yuqi-manual-workspace{display:grid;gap:6px;font-size:13px}.yuqi-manual-workspace code{padding:9px 12px;background:var(--yuqi-surface);border:1px solid var(--yuqi-line);border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere}.yuqi-manual-workspace small{font-size:11px;color:var(--yuqi-muted)}
.yuqi-workbench-aligned .yuqi-manual-return{background:var(--yuqi-surface);border:0;padding:0}.yuqi-manual-summary{display:grid;gap:8px;font-size:14px}.yuqi-manual-summary textarea{width:100%;min-height:130px;resize:vertical;padding:12px;border:1px solid var(--yuqi-line);border-radius:8px;background:var(--yuqi-surface);color:inherit;font:inherit;line-height:1.7}.yuqi-manual-counter{text-align:right;font-size:11px;color:var(--yuqi-muted);margin-top:-8px}
.yuqi-manual-confirm{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.6}.yuqi-manual-confirm input{width:18px;height:18px;flex:none;accent-color:var(--yuqi-accent)}
.yuqi-workbench-aligned .yuqi-manual-return-submit{min-height:44px;width:100%;background:var(--yuqi-accent);color:#fff;border:0;border-radius:7px}.yuqi-workbench-aligned .yuqi-manual-return-submit:disabled{background:var(--yuqi-soft);color:var(--yuqi-muted);opacity:1;cursor:not-allowed}
.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message{margin:0 32px 18px;padding:12px 18px;border:1px solid var(--yuqi-line);border-radius:8px;max-height:220px}
.yuqi-workbench-aligned .yuqi-team-message header{margin-bottom:10px}.yuqi-workbench-aligned .yuqi-team-message header>span{font-size:11px;color:var(--yuqi-muted)}
.yuqi-workbench-aligned .yuqi-team-message-fields{display:grid;grid-template-columns:minmax(150px,25%) minmax(0,1fr) auto;align-items:center;gap:14px}.yuqi-workbench-aligned .yuqi-team-message-fields>label{display:flex;align-items:center;gap:8px;min-width:0}.yuqi-workbench-aligned .yuqi-team-message-fields>label>span{flex:none;font-size:12px}.yuqi-workbench-aligned .yuqi-team-message-fields select{min-width:0;width:100%;max-width:100%}
.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message textarea{min-height:42px;height:42px;max-height:100px;resize:vertical;font-size:13px}.yuqi-workbench-aligned .yuqi-team-message-fields>button{min-height:42px;white-space:normal}
.yuqi-workbench-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 32px;flex:none;border-top:1px solid var(--yuqi-line);background:var(--yuqi-surface)}.yuqi-workbench-footer>span{font-size:13px;color:var(--yuqi-muted)}.yuqi-workbench-footer>button{min-width:138px;min-height:42px;font-size:14px}
.yuqi-review-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:22px;align-items:start}.yuqi-review-primary,.yuqi-review-secondary{min-width:0;display:grid;gap:18px}.yuqi-review-primary{padding:18px;border:1px solid var(--yuqi-line);border-radius:8px;background:var(--yuqi-soft)}
.yuqi-review-layout h3{margin:0 0 16px;font-size:18px}.yuqi-review-overview h3 small{font-size:12px;padding:3px 8px;background:var(--yuqi-surface);border:1px solid var(--yuqi-line);border-radius:5px;margin-left:8px}.yuqi-review-finding{padding:14px;border:1px solid var(--yuqi-line);border-radius:7px;background:var(--yuqi-surface);margin-bottom:10px;font-size:14px}.yuqi-review-finding p{margin:8px 0 0;overflow-wrap:anywhere}
.yuqi-review-evidence{font-size:13px;line-height:1.75;overflow-wrap:anywhere}.yuqi-review-evidence ul{padding-left:20px}.yuqi-review-process{padding:20px;border:1px solid var(--yuqi-line);border-radius:8px}.yuqi-review-process dl{display:grid;gap:20px;margin:0}.yuqi-review-process dl>div{display:grid;gap:6px;font-size:13px}.yuqi-review-process dd{margin:0;color:var(--yuqi-muted)}
.yuqi-workbench-aligned #yuqi-panel-review .yuqi-quality-gate{margin:0;background:var(--yuqi-surface);border:1px solid var(--yuqi-line)}
.yuqi-workbench-aligned :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--yuqi-accent);outline-offset:3px}.yuqi-workbench-aligned button:disabled{cursor:not-allowed}
@media(max-width:760px){.yuqi-workbench-aligned .yuqi-workbench-topbar{padding:12px 18px 4px}.yuqi-workbench-aligned .yuqi-panel-header{padding:10px 18px;flex-direction:column;gap:12px}.yuqi-workbench-aligned .yuqi-panel-header>.yuqi-team-controls{max-width:100%}.yuqi-workbench-aligned .yuqi-panel-header h2{font-size:21px}.yuqi-workbench-aligned>.yuqi-management-tabs{padding:0 18px;gap:20px}.yuqi-workbench-aligned>.yuqi-management-tabs>button{font-size:14px}.yuqi-workbench-aligned .yuqi-task-workspace-scroll,.yuqi-workbench-aligned .yuqi-workbench-page{padding:14px 18px}.yuqi-workbench-aligned .yuqi-task-master-detail,.yuqi-review-layout{grid-template-columns:minmax(0,1fr)}.yuqi-workbench-aligned .yuqi-task-picker{max-height:240px;overflow:auto}.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message{margin:0 18px 12px;max-height:180px}.yuqi-workbench-aligned .yuqi-team-message-fields{grid-template-columns:minmax(0,1fr) auto}.yuqi-workbench-aligned .yuqi-team-message-fields>label{grid-column:1 / -1}.yuqi-workbench-footer{padding:12px 18px}.yuqi-workbench-footer>span{font-size:11px}.yuqi-task-properties>div{grid-template-columns:85px minmax(0,1fr);gap:10px}}
@media(max-height:600px){.yuqi-workbench-aligned .yuqi-panel-body{overflow:auto;display:block}.yuqi-workbench-aligned #yuqi-panel-tasks{overflow:visible;display:block}.yuqi-workbench-aligned .yuqi-task-workspace-scroll{overflow:visible}.yuqi-workbench-aligned #yuqi-panel-tasks>.yuqi-team-message{max-height:none}.yuqi-workbench-aligned .yuqi-workbench-page{overflow:visible}}
@media(prefers-reduced-motion:reduce){.yuqi-workbench-aligned *{scroll-behavior:auto;animation:none;transition:none}}
`
