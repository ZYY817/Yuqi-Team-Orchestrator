export const projectSummarySectionStyles = `
.yuqi-activity-aligned .yuqi-project-summary-section{display:grid;gap:24px;min-width:0;border:0;background:transparent;padding:0;border-radius:0;box-shadow:none}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px 16px;min-width:0;padding-bottom:16px;border-bottom:1px solid var(--activity-border,#e2e7ef)}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-header h3{margin:0;color:var(--activity-ink,#162235);font-size:18px;line-height:1.3}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-refresh-wrapper,.yuqi-activity-aligned .yuqi-summary-refresh-wrapper .yuqi-knowledge-refresh-block{display:contents}
.yuqi-activity-aligned .yuqi-summary-refresh-wrapper .yuqi-knowledge-refresh-header{grid-column:2;justify-content:flex-end;min-width:0}
.yuqi-activity-aligned .yuqi-summary-refresh-wrapper .yuqi-knowledge-help{grid-column:1/-1;margin:0;font-size:12px;line-height:1.6;color:var(--activity-muted,#687386)}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-body{min-width:0}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-content{display:grid;gap:0;min-width:0}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-block{display:grid;gap:10px;min-width:0;padding:0 0 20px;margin:0 0 20px;border:0;border-bottom:1px solid var(--activity-border,#e2e7ef);border-radius:0;background:transparent}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-block:last-child{margin-bottom:0}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-block>strong{color:var(--activity-ink,#162235);font-size:16px;line-height:1.4}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-block>p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--activity-text,#3c4249);font-size:14px;line-height:1.7}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-empty-box{display:grid;min-height:260px;align-content:center;text-align:center;padding:8px 0;color:var(--activity-muted,#687386)}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-empty-box p{margin:0;line-height:1.6}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-list,.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-links{display:grid;gap:10px;min-width:0;margin:0;padding:0;list-style:none}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-list li{display:grid;gap:4px;min-width:0;color:var(--activity-text,#3c4249);font-size:14px;line-height:1.6}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-list li>span{overflow-wrap:anywhere}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-list li>small{overflow-wrap:anywhere;color:var(--activity-muted,#687386);font-size:12px}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-links a{display:block;max-width:100%;overflow-wrap:anywhere;word-break:break-word;color:var(--activity-accent,#2454f5);line-height:1.6}
.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-knowledge-actions{min-width:0;overflow-wrap:anywhere}
@media(max-width:620px){.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-summary-header{gap:10px}.yuqi-activity-aligned .yuqi-summary-refresh-wrapper .yuqi-knowledge-refresh-header{flex-wrap:wrap}}
`
