/** Activity-only presentation for recorded task evidence; TaskRow keeps its legacy layout. */
export const fileAuditActivityStyles = `
.yuqi-detail-screen .yuqi-audit-browser{display:grid;grid-template-columns:minmax(200px,30%) minmax(0,1fr);gap:24px;margin-top:24px;align-items:start}
.yuqi-detail-screen .yuqi-audit-file-list{max-height:none;overflow:visible;margin:0;padding:0 20px 0 0;border-right:1px solid #dce5ef;list-style:none}
.yuqi-detail-screen .yuqi-audit-file-list li{margin:0;border-bottom:1px solid #e2e9f0}
.yuqi-detail-screen .yuqi-audit-file-list button{display:grid;width:100%;gap:8px;padding:16px 12px;border:0;border-radius:6px;text-align:left;background:transparent;overflow-wrap:anywhere}
.yuqi-detail-screen .yuqi-audit-file-list button[aria-pressed=true]{background:#eaf3ff;box-shadow:inset 3px 0 #2474ea}
.yuqi-detail-screen .yuqi-audit-file-list code{font:inherit;font-size:16px;overflow-wrap:anywhere}
.yuqi-detail-screen .yuqi-audit-file-list small,.yuqi-detail-screen .yuqi-audit-file-list span{font-size:12px;color:#65758a}
.yuqi-detail-screen .yuqi-audit-evidence{min-width:0;border:0;padding:0;container-type:inline-size;container-name:yuqi-audit}
.yuqi-detail-screen .yuqi-audit-evidence h4{margin:0 0 16px;font-size:24px;overflow-wrap:anywhere}
.yuqi-detail-screen .yuqi-audit-evidence h4 code{font:inherit}
.yuqi-detail-screen .yuqi-audit-record-select{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:0 0 16px;font-size:14px}
.yuqi-detail-screen .yuqi-audit-record-select select{max-width:100%;padding:9px 12px;border:1px solid #dce5ef;border-radius:6px;background:#fff;color:inherit;font:inherit}
.yuqi-detail-screen .yuqi-file-content-diff,.yuqi-detail-screen .yuqi-audit-record-metadata{margin-top:16px;border:0;border-top:1px solid #dce5ef;border-radius:0;padding:0}
.yuqi-detail-screen .yuqi-file-content-diff>summary,.yuqi-detail-screen .yuqi-audit-record-metadata>summary{padding:16px 0;font-size:16px;cursor:pointer}
.yuqi-detail-screen .yuqi-diff-side-by-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.yuqi-detail-screen .yuqi-diff-pane{min-width:0;border:1px solid #dce5ef;border-radius:6px;overflow:hidden}
.yuqi-detail-screen .yuqi-diff-pane>strong{display:block;padding:10px 14px;background:#f0f4f8;font-size:14px}
.yuqi-detail-screen .yuqi-diff-pane pre{margin:0;padding:14px;max-height:none;overflow:visible;font:13px/1.8 ui-monospace,monospace}
.yuqi-detail-screen .yuqi-diff-before pre{background:#fff7f8}.yuqi-detail-screen .yuqi-diff-after pre{background:#f1fbf5}
.yuqi-detail-screen .yuqi-audit-metadata{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;margin:0 0 20px;font-size:13px}.yuqi-detail-screen .yuqi-audit-metadata dd{margin:0;overflow-wrap:anywhere}
@container yuqi-audit (max-width:600px){.yuqi-detail-screen .yuqi-diff-side-by-side{grid-template-columns:minmax(0,1fr)}}
@media(max-width:760px){.yuqi-detail-screen .yuqi-audit-browser{grid-template-columns:minmax(0,1fr)}.yuqi-detail-screen .yuqi-audit-file-list{border-right:0;padding:0}}
.yuqi-activity-aligned .yuqi-activity-file-audit { display: grid !important; grid-template-columns:minmax(0,1fr); min-width:0; gap: 14px; overflow-wrap:anywhere; }
.yuqi-activity-aligned .yuqi-activity-file-audit > .yuqi-detail-label { width: auto !important; display: block; font-size: 14px; font-weight: 600; color: var(--activity-text, #0F1115); }
.yuqi-activity-aligned .yuqi-activity-file-audit > p { margin: -6px 0 0; }
.yuqi-activity-aligned .yuqi-activity-file-empty { display: grid; align-content: center; justify-items: start; gap: 8px; min-height: 100px; padding: 16px 0; border: 0; background: transparent; text-align: start; }
.yuqi-activity-aligned p.yuqi-activity-file-empty { margin: 0; color: var(--activity-muted); }
.yuqi-activity-aligned .yuqi-activity-file-empty p { margin: 0; color: var(--activity-muted); }
.yuqi-activity-aligned .yuqi-activity-file-empty strong { color: inherit; font-size: 1.05em; }
.yuqi-activity-aligned .yuqi-activity-file-empty button { justify-self: center; }
.yuqi-activity-aligned .yuqi-activity-file-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.yuqi-activity-aligned .yuqi-activity-file-actions > p { flex: 1 1 260px; margin: 0; color: var(--activity-muted); font-size: .88em; }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout,
.yuqi-activity-aligned .yuqi-activity-workspace-evidence { border: 1px solid var(--activity-border); border-radius: 9px; background: var(--activity-surface); }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout > summary { padding: 12px 14px; font-weight: 650; cursor: pointer; }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout > :not(summary),
.yuqi-activity-aligned .yuqi-activity-workspace-evidence > :not(.yuqi-activity-evidence-heading) { margin-inline: 14px; }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout > ul { padding-inline-start: 30px; }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout li + li { margin-top: 10px; }
.yuqi-activity-aligned .yuqi-activity-file-evidence-foldout li > p { margin: 2px 0 0; color: var(--activity-muted); font-size: .88em; }
.yuqi-activity-aligned .yuqi-activity-evidence-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--activity-border); }
.yuqi-activity-aligned .yuqi-activity-evidence-heading h4 { margin: 0; }
.yuqi-activity-aligned .yuqi-activity-workspace-evidence > details { padding: 0 0 12px; }
.yuqi-activity-aligned .yuqi-activity-workspace-evidence summary { padding: 10px 14px; cursor: pointer; }
@container yuqi-activity (max-width: 480px) {
  .yuqi-activity-aligned .yuqi-activity-evidence-heading { align-items: flex-start; flex-direction: column; }
}
`
