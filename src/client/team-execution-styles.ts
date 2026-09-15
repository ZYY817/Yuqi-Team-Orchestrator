export const teamExecutionStyles = `
.yuqi-pause-control{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%;font-size:12px;line-height:1.5}
.yuqi-pause-control>span{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#687386)}
.yuqi-pause-control>span[role=alert]{color:var(--dsw-alias-error-primary,#b42318)}
.yuqi-pause-control>button{flex-shrink:0;min-height:30px}
.yuqi-pause-stop-immediate{color:var(--dsw-alias-error-primary,#b42318)!important;border-color:var(--dsw-alias-error-secondary,#fecdca)!important}
.yuqi-pause-stop-immediate:hover:not(:disabled){background:var(--dsw-alias-error-secondary,#fee4e2)!important}
.yuqi-pause-cancel-resume{color:var(--dsw-alias-brand-primary,#155eef)!important}
.yuqi-team-dock-actions{flex:0 1 auto;flex-wrap:wrap;min-width:0;max-width:100%;gap:4px}
.yuqi-team-dock-actions>.yuqi-pause-control{flex:0 1 auto;padding:4px 8px}
.yuqi-detail-screen-actions{flex:0 1 auto;flex-wrap:wrap;min-width:0;max-width:100%}
.yuqi-detail-screen-actions>.yuqi-pause-control{max-width:min(100%,360px)}
.yuqi-team-dock-summary .yuqi-team-summary-heading{flex-wrap:wrap;min-width:0}
.yuqi-team-dock-summary .yuqi-status{display:inline-flex;align-items:center;gap:5px;white-space:normal}
.yuqi-execution-spinner{display:inline-block;flex:0 0 10px;width:10px;height:10px;box-sizing:border-box;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:yuqi-execution-spin .9s linear infinite}
@keyframes yuqi-execution-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.yuqi-execution-spinner{animation:none}}
`
