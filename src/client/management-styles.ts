/** Layout-only overrides for Team management. Native Host chrome is untouched. */
export const managementStyles = `
.yuqi-management-layer{z-index:1180}
.yuqi-management,.yuqi-workbench,.yuqi-settings-wide{--yuqi-surface:var(--dsw-alias-bg-base,#fff);--yuqi-muted:var(--dsw-alias-label-secondary,#667080);--yuqi-line:var(--dsw-alias-border-l1,#e4e7ec);--yuqi-soft:var(--dsw-alias-interactive-bg-hover,#f4f5f7);color:var(--dsw-alias-label-primary,#20242c);font-size:14px;line-height:1.6}
.yuqi-management *,.yuqi-workbench *,.yuqi-settings-wide *{box-sizing:border-box}
.yuqi-management [hidden],.yuqi-workbench [hidden]{display:none!important}
.yuqi-management{display:flex;flex-direction:column;width:min(1240px,calc(100vw - 64px));height:min(940px,calc(100dvh - 80px));max-height:calc(100dvh - 80px);overflow:hidden;background:var(--yuqi-surface);border-color:var(--yuqi-line);border-radius:14px}
.yuqi-management .yuqi-settings-header,.yuqi-settings-wide .yuqi-settings-header{flex:none;align-items:center;padding:22px 26px 18px;gap:16px}
.yuqi-management .yuqi-settings-header h2,.yuqi-settings-wide .yuqi-settings-header h2{margin:0;font-size:20px;line-height:1.5}
.yuqi-management .yuqi-settings-header p{margin:4px 0 0;font-size:13px;line-height:1.6;color:var(--yuqi-muted)}
.yuqi-management .yuqi-settings-header>.yuqi-management-header-actions{display:flex;align-items:center;justify-content:flex-end;gap:20px;flex:0 0 auto;margin-left:auto}
.yuqi-management .yuqi-locale-switch button[aria-pressed=true]{background:var(--yuqi-soft);color:inherit}
.yuqi-management-tabs{display:flex;flex:none;gap:20px;padding:0 26px;border-bottom:1px solid var(--yuqi-line,#e4e7ec);background:var(--yuqi-surface,#fff);overflow-x:auto;overscroll-behavior:contain}
.yuqi-management-tabs>button{flex:none;min-height:48px;padding:10px 2px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--yuqi-muted,#667080);font:inherit;font-size:14px;cursor:pointer}
.yuqi-management-tabs>button:hover{color:inherit;background:var(--yuqi-soft,#f4f5f7)}
.yuqi-management-tabs>button[aria-pressed=true]{border-bottom-color:var(--dsw-alias-state-business-primary,#3267da);color:var(--dsw-alias-state-business-primary,#3267da);font-weight:600}
.yuqi-management :is(button,input,select,textarea,summary):focus-visible,.yuqi-settings-wide :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3267da);outline-offset:2px}
.yuqi-management button:disabled,.yuqi-settings-wide button:disabled{opacity:.5;cursor:not-allowed}
.yuqi-management-settings,.yuqi-settings-embedded{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#f4f6f9)}
.yuqi-management .yuqi-settings-body,.yuqi-settings-wide .yuqi-settings-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:24px;align-content:start}
.yuqi-defaults-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px!important;align-items:start}
.yuqi-settings-group{display:grid;gap:16px;min-width:0;padding:20px;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:12px;background:var(--yuqi-surface,#fff);overflow-wrap:anywhere}
.yuqi-settings-group h3{margin:-20px -20px 0;padding:12px 20px;background:var(--yuqi-soft,#f4f5f7);border-bottom:1px solid var(--yuqi-line,#e4e7ec);border-radius:12px 12px 0 0;font-size:16px;font-weight:600;line-height:1.5}
.yuqi-settings-help{font-size:12px;line-height:1.65;color:var(--yuqi-muted,#667080);min-width:0}
.yuqi-settings-help summary{min-height:32px;padding:6px 0;cursor:pointer;color:inherit;font-size:13px}
.yuqi-settings-help p{margin:8px 0}.yuqi-settings-help fieldset{margin-top:8px!important}
.yuqi-review-mode-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.yuqi-review-mode-choices label{position:relative;display:flex;align-items:center;justify-content:center;padding:8px 6px;min-height:40px;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:7px;font-size:13px;text-align:center;cursor:pointer}
.yuqi-review-mode-choices input{position:absolute;opacity:0;width:1px;height:1px}
.yuqi-review-mode-choices label:has(input:checked){border-color:var(--dsw-alias-state-business-primary,#3267da);background:var(--yuqi-soft,#f4f5f7)}
.yuqi-review-mode-choices label:has(input:focus-visible){outline:2px solid var(--dsw-alias-state-business-primary,#3267da);outline-offset:2px}
.yuqi-review-mode-choices label:has(input:disabled){opacity:.55;cursor:not-allowed}
.yuqi-review-mode-choices em{display:block;width:max-content;margin:2px auto 0}
.yuqi-model-policy-choices{border:0;margin:0;padding:0;min-width:0}
.yuqi-model-policy-choices legend{font-size:13px;margin-bottom:8px}
.yuqi-model-policy-choices p{margin:8px 0 0;color:var(--yuqi-muted,#667080);font-size:12px;line-height:1.65}
.yuqi-team-card-progress{display:block;appearance:none;width:100%;height:4px;margin:14px 0 0;border:0;border-radius:999px;overflow:hidden;background:var(--yuqi-soft,#f4f5f7);accent-color:var(--dsw-alias-state-business-primary,#3267da)}
.yuqi-team-card-progress::-webkit-progress-bar{background:var(--yuqi-soft,#f4f5f7)}
.yuqi-team-card-progress::-webkit-progress-value{background:var(--dsw-alias-state-business-primary,#3267da);border-radius:999px}
.yuqi-team-card-progress::-moz-progress-bar{background:var(--dsw-alias-state-business-primary,#3267da);border-radius:999px}
.yuqi-settings-group :is(fieldset,select,input,textarea,label){min-width:0;max-width:100%}
.yuqi-settings-group .yuqi-settings-field{gap:7px;font-size:14px}
.yuqi-settings-group .yuqi-settings-field>span{font-size:14px}
.yuqi-settings-group .yuqi-settings-field :is(select,input){width:100%;height:auto;min-height:40px;font-size:13px;background:var(--yuqi-surface,#fff);color:inherit;border-color:var(--yuqi-line,#e4e7ec)}
.yuqi-settings-group textarea{width:100%;min-height:104px;resize:vertical;max-height:300px;font:inherit;font-size:13px}
.yuqi-settings-group small,.yuqi-settings-group .yuqi-settings-note,.yuqi-settings-group .yuqi-settings-review-policy>p{font-size:12px;line-height:1.65;color:var(--yuqi-muted,#667080)}
.yuqi-settings-group .yuqi-settings-checkbox{font-size:14px}
.yuqi-settings-group .yuqi-settings-provider-scope,.yuqi-settings-group .yuqi-settings-model-tiers,.yuqi-settings-group .yuqi-settings-review-policy{margin:0;padding:12px;border:1px solid var(--yuqi-line,#e4e7ec);background:var(--yuqi-surface,#fff);border-radius:8px}
.yuqi-settings-group .yuqi-settings-review-policy{padding:0;border:0;gap:14px}
.yuqi-settings-group .yuqi-settings-review-policy>legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.yuqi-settings-group .yuqi-settings-model-tiers label{grid-template-columns:70px minmax(0,1fr)}
.yuqi-settings-group .yuqi-settings-provider-list{max-height:220px;overflow:auto;grid-template-columns:minmax(0,1fr);margin-left:0}
.yuqi-settings-group .yuqi-settings-catalog-note{display:block;font-size:12px;padding:10px 12px;background:var(--yuqi-soft,#f4f5f7);border-color:var(--yuqi-line,#e4e7ec)}
.yuqi-settings-catalog-note summary{cursor:pointer;font-weight:500;min-height:24px}
.yuqi-settings-catalog-note[open]>:not(summary){display:block;margin-top:6px}
.yuqi-settings-feedback{grid-column:1/-1;min-width:0}
.yuqi-settings-feedback:empty{display:none}
.yuqi-management .yuqi-settings-footer,.yuqi-settings-wide .yuqi-settings-footer{flex:none;display:flex;align-items:center;gap:10px;padding:14px 24px;border-top:1px solid var(--yuqi-line,#e4e7ec);background:var(--yuqi-surface,#fff);flex-wrap:wrap}
.yuqi-settings-footer>span{margin-right:auto;color:var(--yuqi-muted,#667080);font-size:12px}
.yuqi-management :is(.yuqi-primary-action,.yuqi-secondary-action),.yuqi-settings-wide :is(.yuqi-primary-action,.yuqi-secondary-action){min-height:36px;padding:7px 14px;border-radius:8px;font-size:13px;line-height:1.5;white-space:normal}
.yuqi-management .yuqi-team-center-list{display:block;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:24px}
.yuqi-management-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.yuqi-management-toolbar input{flex:1;min-width:150px}
.yuqi-management-toolbar :is(input,select),.yuqi-task-search input{min-height:40px;padding:8px 12px;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:8px;background:var(--yuqi-surface,#fff);color:inherit;font:inherit;font-size:13px;max-width:100%}
.yuqi-management-help{margin:12px 0;color:var(--yuqi-muted,#667080);font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.yuqi-team-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start;margin:16px 0}
.yuqi-team-card{min-width:0;padding:18px;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:12px;background:var(--yuqi-surface,#fff)}
.yuqi-team-card>header{display:grid;gap:8px}
.yuqi-team-card>header>strong{font-size:15px;line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yuqi-team-card>header>small{color:var(--yuqi-muted,#667080);font-size:12px;overflow-wrap:anywhere}
.yuqi-team-card>.yuqi-task-command{margin:14px 0;display:flex;gap:8px;flex-wrap:wrap}
.yuqi-team-card .yuqi-child-link{padding:6px 10px;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:7px;min-height:34px;font-size:12px}
.yuqi-management .yuqi-team-card>details{padding:0;border:0;border-top:1px solid var(--yuqi-line,#e4e7ec);border-radius:0}
.yuqi-team-card>details>summary{padding-top:12px;min-height:36px;font-size:12px;color:var(--yuqi-muted,#667080)}
.yuqi-team-card>details>ol{max-height:300px;overflow:auto;overscroll-behavior:contain}
.yuqi-management .yuqi-team-card li{grid-template-columns:minmax(0,1fr);gap:6px}
.yuqi-management .yuqi-team-center-task-actions{justify-self:start}
.yuqi-management .yuqi-team-center-attention{margin:16px 0;padding:18px;background:var(--yuqi-soft,#f4f5f7)}
.yuqi-management .yuqi-team-center-attention li,.yuqi-management .yuqi-team-center-read-decisions li{padding:16px;gap:18px;align-items:start}
.yuqi-management .yuqi-team-center-attention li :is(strong,small,p),.yuqi-management .yuqi-team-center-read-decisions li :is(strong,small,p){white-space:normal;overflow-wrap:anywhere;font-size:13px;line-height:1.65}
.yuqi-management .yuqi-team-center-decision-actions{justify-content:flex-end;max-width:200px}
.yuqi-management .yuqi-team-center-decision-actions button{min-height:36px;white-space:normal}
.yuqi-settings-wide{display:flex;flex-direction:column;width:min(1040px,calc(100vw - 40px));overflow:hidden}
.yuqi-panel-layer:has(.yuqi-workbench){justify-content:center;align-items:center}
.yuqi-workbench{width:min(1240px,calc(100vw - 64px));height:min(940px,calc(100dvh - 80px));margin:0;border:1px solid var(--yuqi-line);border-radius:14px;background:var(--yuqi-surface)}
.yuqi-workbench .yuqi-panel-header{padding:20px 24px;flex:none}
.yuqi-workbench .yuqi-panel-header h2{font-size:18px;line-height:1.5}
.yuqi-workbench .yuqi-panel-header p{display:block;-webkit-line-clamp:unset;font-size:13px;line-height:1.6;max-height:4.8em;overflow:auto;white-space:normal}
.yuqi-workbench .yuqi-panel-body{display:flex;flex-direction:column;overflow:hidden}
.yuqi-workbench .yuqi-panel-state{flex:none;padding:10px 24px;gap:10px;flex-wrap:wrap}
.yuqi-workbench .yuqi-panel-body>.yuqi-team-controls{flex:none}
.yuqi-workbench .yuqi-management-tabs{padding-inline:24px}
.yuqi-workbench-page{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px 24px}
.yuqi-workbench #yuqi-panel-tasks{display:flex;flex-direction:column;overflow:hidden;padding:0}
.yuqi-task-workspace-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px 24px}
.yuqi-workbench #yuqi-panel-tasks>.yuqi-team-message{flex:none;max-height:220px;overflow:auto;margin:0;padding:14px 24px;border-top:1px solid var(--yuqi-line);border-radius:0;background:var(--yuqi-surface)}
.yuqi-workbench #yuqi-panel-tasks>.yuqi-team-message textarea{max-height:110px;resize:vertical}
.yuqi-workbench .yuqi-panel-body>.yuqi-insight-sections{overflow:auto;min-height:0;margin:0}
.yuqi-workbench #yuqi-panel-review .yuqi-quality-gate,.yuqi-workbench #yuqi-panel-review .yuqi-attention-actions{margin:0 0 16px}
.yuqi-workbench .yuqi-panel-body>.yuqi-reconciliation{flex:none;max-height:110px;overflow:auto;margin:10px 24px}
.yuqi-task-search{display:flex;align-items:center;gap:12px;font-size:13px;margin-bottom:14px}
.yuqi-task-search input{flex:1;min-width:0}
.yuqi-workbench .yuqi-filters{padding:0;gap:6px;flex-wrap:wrap;overflow:visible}
.yuqi-workbench .yuqi-filters button{padding:7px 10px;border-radius:7px;min-height:36px}
.yuqi-workbench .yuqi-plan-explanation{margin:10px 0;font-size:12px;line-height:1.6;padding:10px 12px;background:var(--yuqi-soft);border-color:var(--yuqi-line);color:var(--yuqi-muted)}
.yuqi-task-master-detail{display:grid;grid-template-columns:minmax(180px,30%) minmax(0,1fr);gap:18px;align-items:start}
.yuqi-task-picker{display:grid;gap:6px;align-content:start;max-height:440px;overflow:auto;overscroll-behavior:contain;padding:3px}
.yuqi-task-picker>button{display:grid;gap:6px;min-width:0;min-height:64px;padding:12px;text-align:left;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.yuqi-task-picker>button:hover{background:var(--yuqi-soft)}
.yuqi-task-picker>button[aria-pressed=true]{background:var(--yuqi-soft);border-color:var(--yuqi-line)}
.yuqi-task-picker strong{font-size:13px;line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yuqi-task-picker small{font-size:11px;color:var(--yuqi-muted);overflow-wrap:anywhere}
.yuqi-workbench .yuqi-task-list{min-width:0;border:1px solid var(--yuqi-line);border-radius:10px;overflow:hidden}
.yuqi-workbench .yuqi-task-row{padding:16px;content-visibility:visible;contain-intrinsic-size:none;border:0}
.yuqi-workbench .yuqi-task-row :is(select,textarea){max-width:100%}
.yuqi-workbench .yuqi-task-model-control label{min-width:min(220px,100%)}
.yuqi-workbench .yuqi-task-row:hover{background:transparent}
.yuqi-workbench .yuqi-task-goal{white-space:normal;overflow-wrap:anywhere}
.yuqi-workbench .yuqi-quality-gate{font-size:13px;line-height:1.7;padding:18px}
.yuqi-workbench .yuqi-quality-gate>header strong{font-size:16px}
.yuqi-workbench .yuqi-insight-content{font-size:13px;line-height:1.65}
.yuqi-activity-files{display:grid;gap:16px;margin-top:16px;min-width:0}.yuqi-activity-files select{width:100%;max-width:100%;min-width:0}
.yuqi-usage-task-list{list-style:none;margin:16px 0;padding:0;border:1px solid var(--yuqi-line,#e4e7ec);border-radius:10px;overflow:hidden}
.yuqi-usage-task-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:14px;border-bottom:1px solid var(--yuqi-line,#e4e7ec);align-items:start;font-size:13px}
.yuqi-usage-task-list li:last-child{border-bottom:0}.yuqi-usage-task-list button{white-space:normal;overflow-wrap:anywhere;text-align:left}
@media(max-width:740px){
 .yuqi-management,.yuqi-settings-wide{width:100%;height:calc(100dvh - 16px);max-height:calc(100dvh - 16px);border-radius:12px}
 .yuqi-management .yuqi-settings-header{padding:16px;align-items:start}.yuqi-management .yuqi-settings-header p{display:none}
 .yuqi-management-header-actions{gap:8px}.yuqi-management .yuqi-settings-header h2{font-size:17px}
 .yuqi-management-tabs{gap:14px;padding-inline:16px}.yuqi-management-tabs>button{font-size:13px}
 .yuqi-defaults-grid,.yuqi-team-card-grid{grid-template-columns:minmax(0,1fr)}
 .yuqi-management .yuqi-settings-body,.yuqi-settings-wide .yuqi-settings-body,.yuqi-management .yuqi-team-center-list{padding:14px}
 .yuqi-settings-group{padding:16px}.yuqi-settings-group h3{margin:-16px -16px 0;padding:12px 16px}.yuqi-settings-footer>span{flex-basis:100%}
 .yuqi-management .yuqi-team-center-attention li,.yuqi-management .yuqi-team-center-read-decisions li{grid-template-columns:minmax(0,1fr)}
 .yuqi-management .yuqi-team-center-decision-actions{justify-content:start;max-width:none}
 .yuqi-workbench{width:calc(100vw - 16px);height:calc(100dvh - 16px);margin:8px;border-radius:12px}
 .yuqi-workbench .yuqi-panel-header{padding:16px}.yuqi-workbench .yuqi-panel-header p{max-height:3.2em}
 .yuqi-workbench-page{padding:14px}.yuqi-task-master-detail{grid-template-columns:minmax(0,1fr)}
 .yuqi-task-picker{max-height:180px;border-bottom:1px solid var(--yuqi-line)}
 .yuqi-workbench .yuqi-panel-state{padding:8px 14px;font-size:11px}.yuqi-workbench .yuqi-management-tabs{padding-inline:14px}
}
@media(prefers-reduced-motion:reduce){.yuqi-workbench{animation:none}}
@media(max-width:740px){.yuqi-task-workspace-scroll{padding:14px}.yuqi-workbench #yuqi-panel-tasks>.yuqi-team-message{padding:12px 14px;max-height:200px}}
@media(max-height:560px){.yuqi-workbench #yuqi-panel-tasks{display:block;overflow:visible}.yuqi-task-workspace-scroll{overflow:visible}.yuqi-workbench #yuqi-panel-tasks>.yuqi-team-message{max-height:none;overflow:visible}}
@media(max-height:560px){.yuqi-workbench .yuqi-panel-body{display:block;overflow:auto}.yuqi-workbench-page{overflow:visible}.yuqi-workbench .yuqi-panel-body>.yuqi-insight-sections{overflow:visible}}
`
