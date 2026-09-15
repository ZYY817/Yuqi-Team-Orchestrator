/** Reference-aligned layout for the plugin management shell and record lists.
 * Enforces refined light mode with pristine visual hierarchy, micro-borders, and tactile controls.
 */
export const centerAlignmentStyles = `
.yuqi-management-layer{z-index:1180}
.yuqi-management-layer .yuqi-settings-backdrop{background:rgba(0,0,0,0.24)!important;backdrop-filter:blur(4px)!important}
.yuqi-management{
  --dsw-alias-bg-base:#FFFFFF;
  --dsw-alias-bg-primary:#FFFFFF;
  --dsw-alias-bg-layer-2:#FFFFFF;
  --dsw-alias-bg-subtle:#F9FAFB;
  --dsw-alias-interactive-bg-hover:rgba(38,49,72,0.06);
  --dsw-alias-border-l1:rgba(0,0,0,0.04);
  --dsw-alias-border-l2:rgba(0,0,0,0.1);
  --dsw-alias-border-l3:rgba(0,0,0,0.12);
  --dsw-alias-label-primary:#0F1115;
  --dsw-alias-label-secondary:#61666B;
  --dsw-alias-label-tertiary:#81858C;
  --dsw-alias-bg-module-platform:#F9FAFB;
  --yuqi-canvas:#FFFFFF;
  --yuqi-surface:#FFFFFF;
  --yuqi-soft:#F9FAFB;
  --yuqi-soft-hover:rgba(38,49,72,0.06);
  --yuqi-line:rgba(0,0,0,0.1);
  --yuqi-line-light:rgba(0,0,0,0.06);
  --yuqi-text-title:#0F1115;
  --yuqi-text:#0F1115;
  --yuqi-muted:#81858C;
  --yuqi-dim:#ADB2B8;
  --yuqi-brand:#0F1115;
  --yuqi-brand-hover:#353638;
  --yuqi-brand-light:rgba(15,17,21,0.06);
  --yuqi-brand-border:rgba(0,0,0,0.12);
  font-size:14px;
  display:flex;
  flex-direction:row;
  width:min(940px,calc(100vw - 48px));
  height:min(800px,calc(100vh - 48px));
  max-height:calc(100vh - 48px);
  background:#FFFFFF;
  color:#0F1115;
  border:none;
  border-radius:32px;
  box-shadow:0 24px 48px rgba(0,0,0,0.16);
  scrollbar-color:rgba(0,0,0,0.15) transparent;
  overflow:hidden
}
.yuqi-settings-nav{
  flex:none;
  display:flex;
  flex-direction:column;
  gap:18px;
  width:188px;
  padding:22px 12px 0;
  box-sizing:border-box;
  background:transparent;
  border-right:none
}
.yuqi-settings-nav-title{
  padding:0 12px;
  font-size:16px;
  line-height:24px;
  font-weight:500;
  color:#0F1115
}
.yuqi-settings-nav-list{
  display:flex;
  flex-direction:column;
  gap:4px
}
.yuqi-settings-nav-cell{
  display:flex;
  align-items:center;
  gap:8px;
  height:40px;
  padding:9px 16px 9px 12px;
  box-sizing:border-box;
  border:none;
  border-radius:12px;
  background:transparent;
  cursor:pointer;
  font-family:inherit;
  font-size:14px;
  line-height:22px;
  font-weight:400;
  color:#0F1115;
  text-align:left;
  transition:background-color .12s ease
}
.yuqi-settings-nav-cell:hover:not(.active){
  background:rgba(38,49,72,0.06)
}
.yuqi-settings-nav-cell.active,
.yuqi-settings-nav-cell[aria-current="true"]{
  background:#EBEEF2;
  color:#0F1115;
  font-weight:500;
  border:none;
  box-shadow:none
}
.yuqi-settings-nav-cell svg{
  flex:none;
  color:#0F1115
}
.yuqi-settings-nav-label{
  flex:1;
  min-width:0;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis
}
.yuqi-count-badge{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:18px;
  height:18px;
  margin-left:auto;
  padding:0 6px;
  border-radius:999px;
  font-size:11px;
  line-height:1;
  font-weight:600;
  background:#EBEEF2;
  color:#0F1115
}
.yuqi-settings-content{
  flex:1;
  min-width:0;
  display:flex;
  flex-direction:column;
  background:#FFFFFF;
  overflow:hidden
}
.yuqi-settings-content .yuqi-settings-header{
  flex:none;
  display:flex;
  align-items:center;
  justify-content:flex-end;
  gap:8px;
  height:54px;
  min-height:54px;
  padding:20px 24px 8px 10px;
  box-sizing:border-box;
  border-bottom:none;
  background:#FFFFFF
}
.yuqi-settings-header-desc{
  display:none
}
.yuqi-management-header-actions{
  display:flex;
  align-items:center;
  gap:8px;
  margin-left:auto;
  flex:none
}
.yuqi-management .yuqi-close-button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:28px;
  height:28px;
  padding:0;
  border:none;
  border-radius:28px;
  background:transparent;
  cursor:pointer;
  color:#0F1115;
  font-size:16px;
  transition:background-color .12s ease
}
.yuqi-management .yuqi-close-button:hover{
  background:rgba(38,49,72,0.06)
}
.yuqi-management .yuqi-locale-switch{
  display:inline-flex;
  align-items:center;
  height:30px;
  padding:3px;
  border-radius:15px;
  background:#EBEEF2;
  box-sizing:border-box;
  gap:2px
}
.yuqi-management .yuqi-locale-switch button{
  height:24px;
  padding:0 10px;
  font-size:12px;
  line-height:24px;
  font-weight:400;
  border-radius:12px;
  border:0;
  color:#61666B;
  background:transparent;
  cursor:pointer;
  transition:all .16s ease
}
.yuqi-management .yuqi-locale-switch button:hover:not([aria-pressed=true]){
  color:#0F1115
}
.yuqi-management .yuqi-locale-switch button[aria-pressed=true]{
  background:#FFFFFF;
  color:#0F1115;
  font-weight:500;
  box-shadow:0 1px 3px rgba(0,0,0,0.1), 0 0.5px 1px rgba(0,0,0,0.06)
}
.yuqi-settings-options{
  flex:1;
  min-height:0;
  display:flex;
  flex-direction:column;
  overflow:hidden;
  background:#FFFFFF
}
.yuqi-defaults-intro{
  display:none
}
.yuqi-management-settings{
  background:#FFFFFF;
  display:flex;
  flex-direction:column;
  flex:1 1 auto;
  min-height:0;
  height:100%;
  overflow:hidden
}
.yuqi-management-settings-content{
  display:flex;
  flex-direction:column;
  flex:1 1 auto;
  min-width:0;
  min-height:0;
  height:100%;
  overflow:hidden;
  padding:0;
  background:#FFFFFF
}
.yuqi-management-settings-content>.yuqi-settings-scope{
  display:flex;
  flex-direction:column;
  gap:0;
  min-width:0;
  min-height:0;
  height:100%;
  flex:1 1 auto;
  padding:0;
  box-sizing:border-box;
  max-width:100%;
  margin:0;
  width:100%;
  overflow:hidden
}
.yuqi-management-settings-content>.yuqi-settings-scope>fieldset{
  display:flex;
  flex-direction:column;
  flex:1 1 auto;
  min-width:0;
  min-height:0;
  margin:0;
  overflow:hidden;
  border:0;
  padding:0
}
.yuqi-management-settings-content>.yuqi-settings-scope>fieldset>.yuqi-settings-embedded{
  display:flex;
  flex-direction:column;
  flex:1 1 auto;
  min-width:0;
  min-height:0;
  overflow:hidden;
  background:transparent
}
.yuqi-management-settings-content>.yuqi-settings-scope>fieldset>.yuqi-settings-embedded>.yuqi-settings-body{
  flex:1 1 auto;
  min-height:0;
  overflow-y:auto;
  overflow-x:hidden;
  overscroll-behavior:contain;
  padding:0 40px 32px 32px;
  background:transparent
}
.yuqi-settings-scope-card{
  flex:none;
  display:flex;
  flex-direction:column;
  gap:8px;
  padding:0 40px 14px 32px;
  border-bottom:0.5px solid rgba(0,0,0,0.1);
  border:none;
  border-bottom:0.5px solid rgba(0,0,0,0.1);
  border-radius:0;
  background:transparent;
  box-shadow:none;
  margin-bottom:0
}
.yuqi-scope-row-primary{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  flex-wrap:wrap
}
.yuqi-scope-picker-wrap{
  display:flex;
  align-items:center;
  gap:12px
}
.yuqi-scope-label{
  font-size:14px;
  font-weight:400;
  color:#0F1115;
  white-space:nowrap
}
.yuqi-level-segmented{
  display:inline-flex;
  padding:2px;
  border-radius:18px;
  background:#F9FAFB;
  border:none;
  gap:2px;
  box-sizing:border-box
}
.yuqi-level-btn{
  padding:0 14px;
  height:32px;
  border-radius:16px;
  border:none;
  background:transparent;
  color:#61666B;
  font:inherit;
  font-size:13px;
  font-weight:400;
  line-height:32px;
  cursor:pointer;
  transition:all .12s ease;
  white-space:nowrap;
  user-select:none
}
.yuqi-level-btn:hover:not(:disabled){
  color:#0F1115;
  background:rgba(38,49,72,0.06)
}
.yuqi-level-btn[aria-pressed=true]{
  background:#EBEEF2;
  color:#0F1115;
  font-weight:500;
  box-shadow:none
}
.yuqi-level-btn:disabled{
  opacity:.4;
  cursor:not-allowed
}
.yuqi-scope-actions-wrap{
  display:flex;
  align-items:center;
  gap:8px;
  margin-left:auto
}
.yuqi-scope-action-btn{
  height:28px;
  padding:0 12px;
  border:0.5px solid rgba(0,0,0,0.12);
  border-radius:14px;
  background:transparent;
  color:#0F1115;
  font:inherit;
  font-size:12px;
  line-height:28px;
  font-weight:400;
  cursor:pointer;
  transition:all .12s ease;
  white-space:nowrap
}
.yuqi-scope-action-btn:hover:not(:disabled){
  background:rgba(38,49,72,0.06)
}
.yuqi-scope-action-btn:disabled{
  opacity:.4;
  cursor:not-allowed
}
.yuqi-scope-action-ghost{
  height:28px;
  padding:0 10px;
  border:none;
  border-radius:14px;
  background:transparent;
  color:#61666B;
  font:inherit;
  font-size:12px;
  line-height:28px;
  font-weight:400;
  cursor:pointer;
  transition:all .12s ease;
  white-space:nowrap
}
.yuqi-scope-action-ghost:hover:not(:disabled){
  color:#0F1115;
  background:rgba(38,49,72,0.06)
}
.yuqi-scope-row-secondary{
  display:flex;
  align-items:center;
  gap:8px;
  padding-top:4px;
  border-top:none;
  flex-wrap:wrap
}
.yuqi-scope-status-badge{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:12px;
  font-weight:500;
  color:#0F1115;
  background:transparent;
  border:none;
  padding:0;
  white-space:nowrap
}
.yuqi-status-dot{
  width:6px;
  height:6px;
  border-radius:50%;
  display:inline-block
}
.yuqi-status-dot.dot-inherited{
  background:#81858C
}
.yuqi-status-dot.dot-overridden{
  background:#4176E6
}
.yuqi-scope-desc{
  margin:0;
  font-size:12px;
  line-height:18px;
  color:#81858C;
  flex:1;
  min-width:180px
}
.yuqi-scope-session-row{
  display:flex;
  align-items:center;
  gap:8px;
  font-size:12px;
  color:#61666B;
  width:100%
}
.yuqi-settings-sources{
  border:0.5px solid rgba(0,0,0,0.1);
  border-radius:14px;
  background:#F9FAFB;
  box-shadow:none;
  font-size:12.5px;
  line-height:1.6;
  overflow-wrap:anywhere;
  margin-top:6px
}
.yuqi-settings-sources>summary{
  display:grid;
  gap:2px;
  min-height:40px;
  padding:8px 14px;
  cursor:pointer;
  list-style-position:inside;
  color:#0F1115
}
.yuqi-settings-sources>summary>span{
  font-weight:500
}
.yuqi-settings-sources>summary>small{
  color:#81858C
}
.yuqi-settings-sources[open]>summary{
  border-bottom:0.5px solid rgba(0,0,0,0.06)
}
.yuqi-settings-sources dl{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:6px 14px;
  margin:0;
  padding:10px 14px
}
.yuqi-settings-sources dl>div{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  min-width:0;
  padding:5px 8px;
  border-radius:8px;
  background:#FFFFFF;
  border:0.5px solid rgba(0,0,0,0.06);
  color:#0F1115
}
.yuqi-settings-sources dt{
  min-width:0;
  overflow-wrap:anywhere
}
.yuqi-settings-sources dd{
  flex:none;
  margin:0;
  color:#81858C;
  font-size:11.5px
}
.yuqi-settings-scope-notice{
  display:inline-flex;
  align-items:center;
  padding:3px 8px;
  border-radius:12px;
  background:#EBEEF2;
  color:#0F1115;
  font-size:11.5px;
  font-weight:500;
  line-height:1.4
}
.yuqi-settings-state{
  flex:1 1 auto;
  min-height:0;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:14px;
  padding:40px 32px;
  text-align:center;
  color:#61666B;
  box-sizing:border-box
}
.yuqi-settings-state h3{margin:0 0 4px;font-size:16px;font-weight:600;color:#0F1115}
.yuqi-settings-state p{margin:0;font-size:13px;line-height:1.6;max-width:420px;color:#61666B}
.yuqi-settings-state details{margin-top:4px;text-align:left}
.yuqi-settings-state summary{cursor:pointer;font-size:12px;color:#81858C}
.yuqi-settings-state pre{margin:6px 0 0;padding:10px 12px;max-width:420px;background:#F9FAFB;border:1px solid rgba(0,0,0,0.08);border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;text-align:left}
.yuqi-settings-state .yuqi-primary-action,.yuqi-settings-state .yuqi-secondary-action{margin-top:10px}
.yuqi-settings-state-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:#EBEEF2;color:#61666B;font-size:20px;font-weight:600}
.yuqi-settings-state-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.yuqi-settings-state-loading .yuqi-settings-state-icon{margin:0 auto}
.yuqi-settings-state-error .yuqi-settings-state-icon{background:rgba(217,48,37,0.1);color:#D93025}
.yuqi-settings-state-context .yuqi-settings-state-icon{background:rgba(50,103,218,0.1);color:#3267DA}
.yuqi-settings-spinner{display:block;width:18px;height:18px;border:2px solid rgba(0,0,0,0.15);border-top-color:#0F1115;border-radius:50%;animation:yuqi-settings-state-spin .8s linear infinite}
@keyframes yuqi-settings-state-spin{to{transform:rotate(360deg)}}
.yuqi-management-settings-content>.yuqi-settings-scope>fieldset>.yuqi-settings-embedded>.yuqi-settings-footer{
  position:relative;
  flex:none;
  z-index:10;
  display:flex;
  align-items:center;
  gap:12px;
  min-height:56px;
  background:#FFFFFF!important;
  border-top:0.5px solid rgba(0,0,0,0.1)!important;
  box-shadow:none;
  margin:0!important;
  padding:12px 32px!important;
  width:100%!important;
  box-sizing:border-box!important
}
.yuqi-management .yuqi-settings-footer{
  padding:12px 32px;
  min-height:56px;
  border-top:0.5px solid rgba(0,0,0,0.1);
  background:#FFFFFF;
  display:flex;
  align-items:center;
  gap:12px;
  flex:none
}
.yuqi-management .yuqi-settings-footer>span{
  font-size:12px;
  line-height:18px;
  min-width:0;
  color:#81858C;
  margin-right:auto
}
.yuqi-management :is(.yuqi-primary-action,.yuqi-secondary-action){
  height:36px;
  padding:0 16px;
  font-size:14px;
  line-height:36px;
  border-radius:18px;
  font-weight:500;
  cursor:pointer;
  transition:all .12s ease
}
.yuqi-management .yuqi-primary-action{
  background:#0F1115;
  color:#FFFFFF;
  border:none;
  box-shadow:none
}
.yuqi-management .yuqi-primary-action:hover:not(:disabled){
  background:#353638
}
.yuqi-management .yuqi-secondary-action{
  background:transparent;
  color:#0F1115;
  border:0.5px solid rgba(0,0,0,0.12)
}
.yuqi-management .yuqi-secondary-action:hover:not(:disabled){
  background:rgba(38,49,72,0.06)
}
.yuqi-management .yuqi-team-center-list{
  padding:20px 32px 32px;
  scrollbar-gutter:stable;
  display:flex;
  flex-direction:column;
  background:#FFFFFF;
  flex:1 1 auto;
  min-height:0;
  overflow:auto
}
#yuqi-center-teams,#yuqi-center-attention{
  display:flex;
  flex-direction:column;
  flex:1 1 auto;
  min-height:100%
}
.yuqi-management #yuqi-center-teams,.yuqi-management #yuqi-center-attention{
  max-width:100%;
  margin:0;
  width:100%
}
.yuqi-management-toolbar{
  display:flex;
  align-items:center;
  gap:12px;
  margin-bottom:16px;
  width:100%
}
.yuqi-toolbar-status-slot{
  flex:none;
  display:flex;
  align-items:center
}
.yuqi-toolbar-search-slot{
  flex:0 1 260px;
  min-width:160px
}
.yuqi-toolbar-search-slot input[type=search]{
  width:100%;
  height:36px;
  box-sizing:border-box;
  font-size:13px;
  padding:0 14px;
  border:none;
  border-radius:18px;
  background:#F9FAFB;
  color:#0F1115
}
.yuqi-toolbar-search-slot input[type=search]:focus{
  outline:2px solid #0F1115
}
.yuqi-toolbar-actions-slot{
  margin-left:auto;
  display:flex;
  align-items:center;
  gap:8px;
  flex:none
}
.yuqi-segmented{
  display:inline-flex;
  gap:2px;
  padding:2px;
  border:none;
  border-radius:18px;
  background:#F9FAFB;
  max-width:100%
}
.yuqi-segmented>button{
  height:32px;
  border:0;
  border-radius:16px;
  padding:0 12px;
  background:transparent;
  color:#61666B;
  font:inherit;
  font-size:13px;
  font-weight:400;
  cursor:pointer;
  transition:all .12s ease;
  display:inline-flex;
  align-items:center;
  gap:4px
}
.yuqi-segmented>button:hover:not([aria-pressed=true]){
  background:rgba(38,49,72,0.06);
  color:#0F1115
}
.yuqi-segmented>button[aria-pressed=true]{
  color:#0F1115;
  background:#EBEEF2;
  font-weight:500;
  box-shadow:none
}
.yuqi-segmented .yuqi-count-badge{
  margin-left:2px
}
.yuqi-text-action{
  border:0;
  background:transparent;
  color:#0F1115;
  padding:4px 8px;
  font:inherit;
  font-size:12.5px;
  font-weight:500;
  cursor:pointer
}
.yuqi-team-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0;align-items:start}
.yuqi-team-card{padding:20px;border-radius:20px;border:0.5px solid rgba(0,0,0,0.1);background:#FFFFFF;box-shadow:none;display:flex;flex-direction:column;align-self:start;transition:all .12s ease}
.yuqi-team-card:hover{border-color:rgba(0,0,0,0.2)}
.yuqi-team-card>header{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%}
.yuqi-card-title-group{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.yuqi-card-title-group>strong{font-size:15px;line-height:22px;font-weight:600;color:#0F1115;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yuqi-card-status-group{display:flex;align-items:center;gap:8px;flex:none;white-space:nowrap}
.yuqi-card-status-group>small{margin:0;font-size:12px;color:#81858C}
.yuqi-card-status{display:inline-flex;align-items:center;justify-content:center;padding:0 10px;height:22px;border-radius:11px;font-size:12px;font-weight:500;white-space:nowrap}
.yuqi-card-status.yuqi-status-active{background:#EFF6FF;color:#1D4ED8;border:none}
.yuqi-card-status.yuqi-status-success{background:#ECFDF5;color:#047857;border:none}
.yuqi-card-status.yuqi-status-warning{background:#FFFBEB;color:#B45309;border:none}
.yuqi-card-status.yuqi-status-danger{background:#FEF2F2;color:#B91C1C;border:none}
.yuqi-team-card-progress{height:4px;border-radius:2px;background:#F1F3F5;overflow:hidden;margin:12px 0 8px}
.yuqi-card-current{font-size:12px;color:#81858C;margin:10px 0 8px}
.yuqi-card-task-preview{list-style:none;border:none;border-radius:12px;background:#F9FAFB;margin:0 0 14px;padding:4px 8px}
.yuqi-management .yuqi-card-task-preview li{display:flex;justify-content:space-between;gap:12px;min-height:36px;padding:6px 8px;background:transparent;border-radius:8px;border-bottom:0.5px solid rgba(0,0,0,0.06);font-size:12px;color:#0F1115;cursor:default;transition:background-color .12s ease}
.yuqi-management .yuqi-card-task-preview li:last-child{border:0}
.yuqi-management .yuqi-card-task-preview li:hover{background:rgba(38,49,72,0.04)}
.yuqi-card-task-preview li>span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.yuqi-management .yuqi-card-task-preview li>small{flex:none;font-size:11.5px;color:#81858C}
.yuqi-team-card:not(.yuqi-team-card-compact)>.yuqi-task-command{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0;width:100%;align-items:stretch}
.yuqi-team-card:not(.yuqi-team-card-compact)>.yuqi-task-command>button{width:100%;text-align:center;justify-content:center}
.yuqi-team-card:not(.yuqi-team-card-compact) .yuqi-card-direct-actions{grid-column:1/-1;display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px}
.yuqi-team-card:not(.yuqi-team-card-compact) .yuqi-card-direct-actions button{width:100%;text-align:center;justify-content:center}
.yuqi-card-view{background:#EBEEF2!important;color:#0F1115!important;border:none!important;font-weight:500}
.yuqi-management .yuqi-card-more{position:relative;overflow:visible;padding:0;border:0;border-radius:0}
.yuqi-management .yuqi-card-more>summary{border:0.5px solid rgba(0,0,0,0.12);min-height:32px;border-radius:16px;padding:0 12px;font-size:12px;line-height:32px;list-style:none;white-space:nowrap;cursor:pointer;color:#0F1115;background:#FFFFFF}
.yuqi-management .yuqi-card-more>div{position:absolute;right:0;top:calc(100% + 4px);z-index:3;display:grid;min-width:170px;padding:6px;gap:3px;border:0.5px solid rgba(0,0,0,0.1);border-radius:14px;background:#FFFFFF;box-shadow:0 8px 24px rgba(0,0,0,0.12)}
.yuqi-card-more button{text-align:left}
.yuqi-management .yuqi-card-children{display:block;margin:12px 0 0;padding:0;border:0;background:transparent}
.yuqi-management .yuqi-card-children>summary{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#61666B;font-weight:500;cursor:pointer;list-style:none;user-select:none;padding:3px 0;transition:color .12s ease}
.yuqi-management .yuqi-card-children>summary::-webkit-details-marker{display:none}
.yuqi-management .yuqi-card-children>summary::before{content:'';display:inline-block;width:14px;height:14px;flex:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M6 3.5L10.5 8L6 12.5' stroke='%2361666B' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:center;background-size:13px 13px;transition:transform .18s cubic-bezier(0.16, 1, 0.3, 1)}
.yuqi-management .yuqi-card-children[open]>summary::before{transform:rotate(90deg)}
.yuqi-management .yuqi-card-children>summary:hover{color:#0F1115}
.yuqi-management .yuqi-team-card .yuqi-card-children ol{max-height:220px;overflow-y:auto;overscroll-behavior:contain;margin:8px 0 0;padding-inline-start:18px;display:flex;flex-direction:column;gap:8px}
.yuqi-center-running-note{text-align:center;color:#81858C;font-size:13px;margin:20px 0 0}
.yuqi-team-history-list{display:grid;gap:12px}
.yuqi-team-card-compact{display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-radius:18px;border:0.5px solid rgba(0,0,0,0.1);background:#FFFFFF;box-shadow:none;align-items:stretch;width:100%;box-sizing:border-box;transition:all .12s ease}
.yuqi-team-card-compact:hover{border-color:rgba(0,0,0,0.18);box-shadow:0 2px 8px rgba(0,0,0,0.04)}
.yuqi-team-card-compact>.yuqi-card-action-hint{font-size:12px;color:#81858C;line-height:1.5;margin:0}
.yuqi-team-card-compact>.yuqi-card-children{margin:0}
.yuqi-team-card-compact>.yuqi-task-command{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px;width:100%}
.yuqi-team-card-compact .yuqi-card-direct-actions{display:flex;align-items:center;gap:8px;margin:0}
.yuqi-team-card-compact .yuqi-task-command button,.yuqi-team-card-compact .yuqi-card-direct-actions button{box-sizing:border-box;height:32px;min-height:32px;padding:0 16px;border-radius:16px;font-size:12.5px;line-height:32px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;text-align:center;white-space:nowrap;cursor:pointer;transition:all .12s ease;border:0.5px solid rgba(0,0,0,0.12);background:transparent;color:#0F1115}
.yuqi-team-card-compact .yuqi-card-view{background:#EBEEF2!important;color:#0F1115!important;border:none!important;font-weight:500}
.yuqi-team-card-compact .yuqi-card-view:hover{background:#E2E5E9!important}
.yuqi-team-card-compact .yuqi-child-link:hover{background:rgba(38,49,72,0.06)}
.yuqi-team-card-compact .yuqi-child-link.yuqi-archive-highlight{background:#0F1115!important;color:#FFFFFF!important;border:none!important;font-weight:500}
.yuqi-team-card-compact .yuqi-child-link.yuqi-archive-highlight:hover{background:#353638!important}
.yuqi-management .yuqi-management-help{margin:0 0 14px;font-size:13px;color:#81858C}
.yuqi-management .yuqi-attention-grid{padding:0;margin:0;background:transparent;border:0}
.yuqi-management .yuqi-attention-grid>ol{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.yuqi-management .yuqi-attention-grid li.yuqi-decision-card{display:grid;grid-template-columns:minmax(190px,27%) minmax(0,1fr) 140px;gap:18px;padding:18px 20px;border:0.5px solid rgba(0,0,0,0.1);background:#FFFFFF;border-radius:18px;box-shadow:none}
.yuqi-decision-context{min-width:0;border-right:0.5px solid rgba(0,0,0,0.06);padding-right:16px;display:flex;flex-direction:column;gap:6px}
.yuqi-decision-context>small{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;background:#FFFBEB;color:#B45309;width:fit-content}
.yuqi-management .yuqi-decision-context strong{font-size:14px!important;font-weight:500;line-height:1.4;color:#0F1115;margin:2px 0 0;overflow-wrap:anywhere}
.yuqi-management .yuqi-decision-context small,.yuqi-management .yuqi-decision-context p{font-size:12px!important;color:#81858C;margin:0;line-height:1.5}
.yuqi-decision-body{min-width:0;font-size:13px;overflow-wrap:anywhere;color:#0F1115}
.yuqi-decision-body>p{margin:0 0 8px!important;font-size:13px!important;line-height:1.6;color:#0F1115!important}
.yuqi-decision-body>small{font-size:12px;color:#81858C}
.yuqi-management .yuqi-team-center-decision-actions{display:flex;flex-direction:column;align-items:stretch;max-width:none;gap:7px}
.yuqi-management .yuqi-team-center-decision-actions button{font-size:12.5px;border-radius:16px;min-height:32px;white-space:normal;font-weight:500}
.yuqi-management .yuqi-team-center-decision-actions .yuqi-primary-action{background:#0F1115;color:#fff;border:none;font-weight:500}
.yuqi-management .yuqi-team-center-decision-actions .yuqi-secondary-action{background:transparent;border:0.5px solid rgba(0,0,0,0.12);color:#0F1115}
.yuqi-management .yuqi-team-center-decision-actions .yuqi-text-action{color:#81858C;text-align:center;padding:3px}
.yuqi-management .yuqi-team-center-decision-actions .yuqi-text-action:hover{color:#0F1115}
.yuqi-management .yuqi-global-attention-decision{font-size:13px;max-width:none;min-width:0;padding:12px 14px;border:0.5px solid rgba(0,0,0,0.1);border-radius:14px;background:#F9FAFB}
.yuqi-management .yuqi-global-attention-decision fieldset{border:0;padding:0;margin:0 0 10px;min-width:0}
.yuqi-management .yuqi-global-attention-decision legend{font-size:13px;font-weight:500;margin-bottom:6px;color:#0F1115}
.yuqi-management .yuqi-global-attention-decision label{font-size:12.5px;margin:5px 0;display:flex;align-items:center;gap:7px;color:#0F1115}
.yuqi-management .yuqi-global-attention-decision input[type=text]{max-width:100%;width:100%;border:none;padding:0 12px;height:34px;border-radius:17px;font:inherit;font-size:12.5px;background:#FFFFFF;color:#0F1115}
.yuqi-management .yuqi-global-attention-decision button{min-height:30px;padding:0 14px;border:0.5px solid rgba(0,0,0,0.12);border-radius:15px;font:inherit;font-size:12.5px;font-weight:500;background:transparent;color:#0F1115;cursor:pointer}
.yuqi-management .yuqi-team-center-empty{padding:40px 16px;text-align:center;font-size:13.5px;line-height:1.7;color:#81858C}
/* ==========================================================================
   Yuqi Team Workbench - Top-to-Bottom Flow Layout
   ========================================================================== */
.yuqi-workbench.yuqi-management {
  display: flex;
  flex-direction: column;
  width: min(1440px, calc(100vw - 48px));
  height: min(960px, calc(100dvh - 48px));
  max-height: calc(100vh - 48px);
  background: #FFFFFF;
  color: #0F1115;
  border: none;
  border-radius: 16px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.16);
  overflow: hidden;
  position: relative;
  z-index: 1;
  font-size: 14px;
}

/* Header */
.yuqi-workbench.yuqi-management .yuqi-workbench-top-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px 8px 24px;
  background: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-back {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: #0F1115;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background-color .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-back:hover {
  background: rgba(38, 49, 72, 0.06);
}
.yuqi-workbench.yuqi-management .yuqi-workbench-top-bar .yuqi-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #0F1115;
  cursor: pointer;
  transition: background-color .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-top-bar .yuqi-close-button:hover {
  background: rgba(38, 49, 72, 0.06);
}
.yuqi-workbench.yuqi-management .yuqi-workbench-header {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 4px 28px 16px;
  box-sizing: border-box;
  background: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-header-left {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-title-row h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
  color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-source-tag {
  font-size: 12px;
  color: #81858C;
  background: #F1F3F5;
  padding: 2px 8px;
  border-radius: 6px;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-header-counts {
  font-size: 12.5px;
  color: #81858C;
  margin: 0;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-header-right {
  flex: 0 1 auto;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-header-right > .yuqi-team-controls {
  padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none;
}
.yuqi-workbench.yuqi-management .yuqi-header-task-action { min-height:32px; white-space:nowrap; }

/* Start Confirmation Card in Header - Clean inline buttons without redundant copy */
.yuqi-workbench.yuqi-management .yuqi-header-start-card {
  width: auto;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-team-controls.yuqi-start-choice {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  margin: 0;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-plan-confirmation-copy {
  display: none !important;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-team-control-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  justify-content: flex-end;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-primary-action {
  background: #2454F5 !important;
  color: #FFFFFF !important;
  border: none !important;
  font-size: 12.5px !important;
  font-weight: 500 !important;
  height: 32px !important;
  padding: 0 16px !important;
  border-radius: 8px !important;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  transition: background-color .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-primary-action:hover:not(:disabled) {
  background: #1B45D6 !important;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-secondary-action {
  background: #FFFFFF !important;
  color: #0F1115 !important;
  border: 0.5px solid rgba(0, 0, 0, 0.14) !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  height: 32px !important;
  padding: 0 12px !important;
  border-radius: 8px !important;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-secondary-action:hover:not(:disabled) {
  background: #F9FAFB !important;
  border-color: rgba(0, 0, 0, 0.22) !important;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-danger-text {
  background: transparent !important;
  border: none !important;
  color: #DC2626 !important;
  font-size: 12px !important;
  padding: 0 8px !important;
}
.yuqi-workbench.yuqi-management .yuqi-header-start-card .yuqi-danger-text:hover:not(:disabled) {
  background: #FEF2F2 !important;
  border-radius: 6px !important;
}

/* Horizontal Tabs (DeepSeek Native Underline Tabs) */
.yuqi-workbench.yuqi-management .yuqi-workbench-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 0 28px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
  background: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 42px;
  padding: 0 2px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #61666B;
  font-family: inherit;
  font-size: 14px;
  font-weight: 400;
  cursor: pointer;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn:hover:not(.active) {
  color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn.active,
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn[aria-pressed="true"] {
  color: #2454F5;
  font-weight: 500;
  border-bottom-color: #2454F5;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn .yuqi-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: #F1F3F5;
  color: #61666B;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-tab-btn .yuqi-count-badge.attention {
  background: #FEF2F2;
  color: #B91C1C;
}

/* Body and Pages */
.yuqi-workbench.yuqi-management .yuqi-workbench-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.yuqi-workbench.yuqi-management #yuqi-panel-review {
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.yuqi-workbench.yuqi-management #yuqi-panel-activity {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

/* Tasks Page Split */
.yuqi-workbench.yuqi-management .yuqi-task-workspace-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.yuqi-workbench.yuqi-management .yuqi-task-master-detail {
  display: grid;
  grid-template-columns: minmax(260px, 32%) minmax(0, 1fr);
  gap: 0;
  flex: 1 1 0;
  min-height: 0;
  align-items: stretch;
  overflow: hidden;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: none !important;
  align-self: stretch !important;
  box-sizing: border-box !important;
  background: #FFFFFF;
  border: none;
  border-right: 1px solid #e5e7eb;
  border-radius: 0;
  overflow: hidden;
  padding: 0;
  gap: 0;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  font-size: 12px;
  font-weight: 600;
  color: #61666B;
  background: #FFFFFF;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-empty {
  flex: 1;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 32px 16px;
  text-align: center;
  box-sizing: border-box;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-empty-icon {
  width: 40px;
  height: 40px;
  border-radius: 20px;
  background: #F4F6F9;
  color: #8C95A6;
  display: grid;
  place-items: center;
  margin-bottom: 10px;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-empty p {
  margin: 0 0 4px;
  font-size: 13.5px;
  font-weight: 550;
  color: #1F2329;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-empty small {
  font-size: 12px;
  color: #8C95A6;
  line-height: 1.5;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-list button,
.yuqi-workbench.yuqi-management .yuqi-task-picker button {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-list button:hover:not([aria-pressed="true"]),
.yuqi-workbench.yuqi-management .yuqi-task-picker button:hover:not([aria-pressed="true"]) {
  background: rgba(38, 49, 72, 0.04);
}
.yuqi-workbench.yuqi-management .yuqi-task-picker-list button[aria-pressed="true"],
.yuqi-workbench.yuqi-management .yuqi-task-picker button[aria-pressed="true"] {
  background: #F0F5FF;
  border-color: rgba(36, 84, 245, 0.3);
}
.yuqi-workbench.yuqi-management .yuqi-picker-index {
  width: 24px;
  height: 24px;
  border-radius: 12px;
  background: #F1F3F5;
  color: #61666B;
  font-size: 12px;
  font-weight: 600;
  display: grid;
  place-items: center;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker button[aria-pressed="true"] .yuqi-picker-index {
  background: #2454F5;
  color: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker strong {
  font-size: 13px;
  line-height: 1.4;
  font-weight: 550;
  color: #0F1115;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker small {
  grid-column: 2 / -1;
  font-size: 11.5px;
  color: #81858C;
}
.yuqi-workbench.yuqi-management .yuqi-picker-status {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 8px;
  background: #F1F3F5;
  color: #61666B;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-task-picker button[aria-pressed="true"] .yuqi-picker-status {
  background: #DBEAFE;
  color: #1D4ED8;
  font-weight: 500;
}

/* Detail Pane */
.yuqi-workbench.yuqi-management .yuqi-task-list {
  flex: 1;
  min-height: 0 !important;
  height: 100% !important;
  max-height: none !important;
  align-self: stretch !important;
  box-sizing: border-box !important;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: #FFFFFF;
  border: none;
  border-radius: 0;
  padding: 28px 32px;
}
.yuqi-workbench.yuqi-management .yuqi-task-list:has(.yuqi-empty) {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-direction: column;
}
.yuqi-workbench.yuqi-management .yuqi-task-list .yuqi-empty {
  padding: 32px 24px;
  color: #8C95A6;
  font-size: 13.5px;
  text-align: center;
  line-height: 1.6;
}
.yuqi-workbench.yuqi-management .yuqi-task-inspector-title {
  margin: 0 0 16px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.4;
  color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-task-inspector { padding:0; border:0; content-visibility:visible; contain-intrinsic-size:none; }
.yuqi-workbench.yuqi-management .yuqi-task-description { margin:0 0 20px; font-size:15px; line-height:1.8; color:#374151; overflow-wrap:anywhere; }
.yuqi-workbench.yuqi-management .yuqi-inspector-next { margin:0 0 24px; padding:14px 0; border-block:1px solid #e5e7eb; font-size:14px; line-height:1.7; overflow-wrap:anywhere; }
.yuqi-workbench.yuqi-management .yuqi-task-inspector > details { margin:0; padding:16px 0; border:0; border-bottom:1px solid #e5e7eb; border-radius:0; background:transparent; }
.yuqi-workbench.yuqi-management .yuqi-task-inspector > details > summary { cursor:pointer; font-size:14px; font-weight:600; color:#24324a; }
.yuqi-workbench.yuqi-management .yuqi-task-inspector > details[open] > summary { margin-bottom:16px; }
.yuqi-workbench.yuqi-management .yuqi-task-picker > .yuqi-workbench-filter-details { margin:16px 20px 4px; flex:none; max-height:40%; overflow:auto; }
.yuqi-workbench.yuqi-management .yuqi-task-picker-heading { padding:16px 28px 10px; border:0; }
.yuqi-workbench.yuqi-management .yuqi-controller-recovery { margin:0 28px 12px; padding:12px 16px; border:1px solid #e2e7ee; border-radius:8px; flex:none; max-height:24vh; overflow:auto; }
.yuqi-workbench.yuqi-management .yuqi-controller-recovery p { margin:4px 0; }
.yuqi-workbench.yuqi-management .yuqi-controller-recovery > small { font-size:12px; }
.yuqi-workbench.yuqi-management .yuqi-task-properties {
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  gap: 12px 24px;
  margin: 0 0 20px;
}
.yuqi-workbench.yuqi-management .yuqi-task-scope-disclosure .yuqi-task-properties { grid-template-columns:minmax(0,1fr); }
.yuqi-workbench.yuqi-management .yuqi-task-inspector > details.yuqi-task-config-disclosure { padding:16px 0; }
.yuqi-workbench.yuqi-management .yuqi-task-inspector > details.yuqi-task-config-disclosure > summary { padding:0; background:transparent; }
.yuqi-workbench.yuqi-management .yuqi-task-properties > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
  font-size: 13px;
  line-height: 1.5;
}
.yuqi-workbench.yuqi-management .yuqi-task-properties dt {
  color: #81858C;
  font-weight: 500;
}
.yuqi-workbench.yuqi-management .yuqi-task-properties dd {
  margin: 0;
  color: #0F1115;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.yuqi-workbench.yuqi-management .yuqi-file-scope-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.yuqi-workbench.yuqi-management .yuqi-file-scope-tags li code {
  display: inline-block;
  padding: 2px 8px;
  background: #F1F3F5;
  border-radius: 6px;
  font-size: 11.5px;
  color: #374151;
  border: 0.5px solid rgba(0, 0, 0, 0.06);
}
.yuqi-workbench.yuqi-management .yuqi-task-config-disclosure {
  margin: 16px 0;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 10px;
  background: #F9FAFB;
  overflow: hidden;
}
.yuqi-workbench.yuqi-management .yuqi-task-config-disclosure summary {
  padding: 10px 14px;
  font-size: 12.5px;
  font-weight: 550;
  color: #374151;
  cursor: pointer;
  background: #FFFFFF;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
}
.yuqi-workbench.yuqi-management .yuqi-task-config-disclosure .yuqi-task-configuration {
  padding: 14px;
  border: none;
  background: transparent;
  margin: 0;
}
/* Filter Drawer in Task Page */
.yuqi-workbench.yuqi-management .yuqi-workbench-filter-details {
  margin: 0 0 16px;
  width: 100%;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-filter-details > summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: #F4F5F7;
  border: 0.5px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #0F1115;
  cursor: pointer;
  user-select: none;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-filter-details > summary:hover {
  background: #EBEEF2;
  border-color: rgba(0, 0, 0, 0.2);
}
.yuqi-workbench.yuqi-management .yuqi-workbench-filter-details[open] > summary {
  margin-bottom: 12px;
  background: #EBEEF2;
  border-color: rgba(36, 84, 245, 0.4);
  color: #2454F5;
}
.yuqi-workbench.yuqi-management .yuqi-filter-active-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2454F5;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  background: #FFFFFF;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-task-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #F9FAFB;
  border: 0.5px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  font-size: 13px;
  color: #61666B;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-task-search input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 13px;
  color: #0F1115;
  outline: none;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-filters button {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  background: #FFFFFF;
  color: #374151;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-filters button:hover {
  background: #F4F5F7;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-filters button.yuqi-filter-active {
  background: #0F1115;
  color: #FFFFFF;
  border-color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-content .yuqi-filters button span {
  font-size: 11px;
  opacity: 0.8;
}
.yuqi-workbench.yuqi-management .yuqi-filter-drawer-hint {
  font-size: 12px;
  color: #8C95A6;
  line-height: 1.4;
  padding: 2px 2px 0;
}

/* Review Page */
.yuqi-workbench.yuqi-management #yuqi-panel-review {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
}
.yuqi-workbench.yuqi-management .yuqi-review-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
  gap: 20px;
  align-items: stretch !important;
  flex: 1 1 auto !important;
  min-height: 100%;
}

/* The review page is intentionally a single desktop column: results, safe actions, then optional criteria. */
.yuqi-workbench.yuqi-management .yuqi-review-single-column { display: grid; gap: 24px; width:100%; margin:0; align-content:start; }
.yuqi-workbench.yuqi-management .yuqi-review-result-section,
.yuqi-workbench.yuqi-management .yuqi-review-action-card { padding: 0 0 24px; border:0; border-bottom:1px solid #e5e7eb; border-radius:0; background:#fff; }
.yuqi-workbench.yuqi-management .yuqi-review-result-section h3 { margin: 0 0 14px; font-size: 18px; color: #0f1115; }
.yuqi-workbench.yuqi-management .yuqi-review-empty { display: grid; min-height: 0; padding: 8px 0; gap: 3px; color: #687386; text-align: left; }
.yuqi-workbench.yuqi-management .yuqi-review-empty strong { color: #25334a; font-size: 17px; }
.yuqi-workbench.yuqi-management .yuqi-team-message-muted { max-height: none; padding-block: 8px; }
.yuqi-workbench.yuqi-management .yuqi-team-message-muted .yuqi-team-message-fields { opacity: .78; }
.yuqi-workbench.yuqi-management .yuqi-review-result-status { margin: 0 0 12px; color: #334155; }
.yuqi-workbench.yuqi-management .yuqi-review-custom-details { border-top: 1px solid #e5e7eb; padding-top: 14px; }
.yuqi-workbench.yuqi-management .yuqi-review-custom-details > summary { cursor: pointer; color: #24324a; font-weight: 650; }
.yuqi-workbench.yuqi-management .yuqi-review-custom-details[open] > summary { margin-bottom: 12px; }
.yuqi-workbench.yuqi-management .yuqi-review-custom-details small,
.yuqi-workbench.yuqi-management .yuqi-review-token-note { color: #6b7280; font-size: 12px; }
.yuqi-workbench.yuqi-management .yuqi-review-primary,
.yuqi-workbench.yuqi-management .yuqi-review-secondary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  height: 100%;
  align-self: stretch;
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
  border-radius: 0 !important;
}
.yuqi-workbench.yuqi-management .yuqi-review-guide-card {
  background: #FFFFFF;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 16px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.02);
  flex: 1 1 auto;
  min-height: 100%;
  box-sizing: border-box;
}
.yuqi-workbench.yuqi-management .yuqi-review-guide-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-review-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 12px;
  background: #ECFDF5;
  color: #065F46;
  font-size: 11.5px;
  font-weight: 500;
  width: fit-content;
}
.yuqi-workbench.yuqi-management .yuqi-review-status-pill .yuqi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10B981;
}
.yuqi-workbench.yuqi-management .yuqi-review-guide-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-review-guide-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: #61666B;
}
.yuqi-workbench.yuqi-management .yuqi-review-meta-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
  padding: 10px 14px;
  background: #F9FAFB;
  border: 0.5px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
}
.yuqi-workbench.yuqi-management .yuqi-review-meta-panel .yuqi-review-meta-item:first-child,
.yuqi-workbench.yuqi-management .yuqi-review-meta-panel .yuqi-review-meta-item:nth-child(2) {
  grid-column: 1 / -1;
}
.yuqi-workbench.yuqi-management .yuqi-review-meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.yuqi-workbench.yuqi-management .yuqi-review-meta-label {
  font-size: 11.5px;
  color: #81858C;
  font-weight: 500;
}
.yuqi-workbench.yuqi-management .yuqi-review-meta-item strong {
  font-size: 13px;
  color: #0F1115;
  font-weight: 600;
  line-height: 1.45;
}
.yuqi-workbench.yuqi-management .yuqi-review-findings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.yuqi-workbench.yuqi-management .yuqi-review-findings-section h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #0F1115;
  display: flex;
  align-items: center;
  gap: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-review-findings-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.yuqi-workbench.yuqi-management .yuqi-review-finding-card {
  padding: 12px 14px;
  background: #F8FAFC;
  border: 0.5px solid rgba(0, 0, 0, 0.08);
  border-left: 3px solid #2454F5;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-review-finding-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-severity-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}
.yuqi-workbench.yuqi-management .yuqi-severity-tag.yuqi-severity-error {
  background: #FEE2E2;
  color: #991B1B;
}
.yuqi-workbench.yuqi-management .yuqi-severity-tag.yuqi-severity-warning {
  background: #FEF3C7;
  color: #92400E;
}
.yuqi-workbench.yuqi-management .yuqi-severity-tag.yuqi-severity-info {
  background: #EFF6FF;
  color: #1E40AF;
}
.yuqi-workbench.yuqi-management .yuqi-review-finding-recom {
  margin: 0;
  font-size: 12.5px;
  color: #374151;
  line-height: 1.5;
}
.yuqi-workbench.yuqi-management .yuqi-review-workflow-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 0.5px solid rgba(0, 0, 0, 0.06);
}
.yuqi-workbench.yuqi-management .yuqi-review-workflow-section h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #0F1115;
  display: flex;
  align-items: center;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-review-workflow-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 9px;
  background: #F9FAFB;
  border: 0.5px solid rgba(0, 0, 0, 0.05);
  border-radius: 7px;
  transition: background 0.15s ease;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-item:hover {
  background: #F3F4F6;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #EEF2FF;
  color: #2454F5;
  font-size: 10.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-content strong {
  font-size: 12px;
  font-weight: 600;
  color: #1F2937;
}
.yuqi-workbench.yuqi-management .yuqi-review-step-content p {
  margin: 0;
  font-size: 11px;
  color: #6B7280;
  line-height: 1.35;
}

.yuqi-workbench.yuqi-management .yuqi-review-action-card {
  background: #FFFFFF;
  border: 0;
  border-radius: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: none;
  flex: none;
  height: auto;
  box-sizing: border-box;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-header h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: #0F1115;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1 1 auto;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-body .yuqi-settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-body textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 80px;
  border: 0.5px solid rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.55;
  color: #0F1115;
  background: #FFFFFF;
  resize: vertical;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-body textarea:focus {
  outline: 2px solid #2454F5;
  outline-offset: 1px;
}
.yuqi-workbench.yuqi-management .yuqi-review-template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
}
.yuqi-workbench.yuqi-management .yuqi-review-template-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: #6B7280;
  font-weight: 500;
}
.yuqi-workbench.yuqi-management .yuqi-template-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-template-count {
  font-size: 11px;
  color: #9CA3AF;
  font-variant-numeric: tabular-nums;
}
.yuqi-workbench.yuqi-management .yuqi-template-clear-btn {
  background: none;
  border: none;
  color: #DC2626;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-template-clear-btn:hover {
  background: #FEE2E2;
}
.yuqi-workbench.yuqi-management .yuqi-review-template-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  background: #F3F4F6;
  border: 0.5px solid rgba(0, 0, 0, 0.08);
  border-radius: 14px;
  color: #374151;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip:hover {
  background: #EEF2FF;
  border-color: #A5B4FC;
  color: #2454F5;
  transform: translateY(-1px);
}
.yuqi-workbench.yuqi-management .yuqi-template-chip:active {
  transform: translateY(0);
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.featured {
  background: #EFF6FF;
  border-color: #BFDBFE;
  color: #1D4ED8;
  font-weight: 600;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.featured:hover {
  background: #DBEAFE;
  border-color: #93C5FD;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.team-saved {
  background: #F0FDF4;
  border-color: #BBF7D0;
  color: #15803D;
  font-weight: 600;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.team-saved:hover {
  background: #DCFCE7;
  border-color: #86EFAC;
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.active {
  background: #2454F5;
  border-color: #2454F5;
  color: #FFFFFF;
  box-shadow: 0 1px 3px rgba(36, 84, 245, 0.25);
}
.yuqi-workbench.yuqi-management .yuqi-template-chip.active:hover {
  background: #1B44D8;
  border-color: #1B44D8;
  color: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-footer {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 0;
  padding-top: 12px;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-footer button.yuqi-primary-action {
  width:auto;
  padding:0 20px;
  height: 38px;
  line-height: 38px;
  border-radius: 8px;
  background: #0f1115;
  color: #FFFFFF;
  font-weight: 500;
  font-size: 13.5px;
  border: none;
  cursor: pointer;
  transition: all .12s ease;
  text-align: center;
}
.yuqi-workbench.yuqi-management .yuqi-review-action-footer button.yuqi-primary-action:hover:not(:disabled) {
  background: #1B45D6;
}
.yuqi-workbench.yuqi-management .yuqi-review-process {
  margin: 0;
  padding: 18px;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  background: #FFFFFF;
}

@media (max-width: 760px) {
  .yuqi-workbench.yuqi-management .yuqi-workbench-header { align-items: stretch; flex-direction: column; gap: 12px; }
  .yuqi-workbench.yuqi-management .yuqi-workbench-header-right { flex-basis: auto; }
  .yuqi-workbench.yuqi-management .yuqi-review-layout { grid-template-columns: minmax(0, 1fr); }
}

/* Activity & Topology Page */
.yuqi-workbench.yuqi-management #yuqi-panel-activity {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 28px 24px;
  display: flex;
  flex-direction: column;
}
.yuqi-workbench.yuqi-management .yuqi-activity-aligned {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  flex: 1;
  min-height: 0;
  height: 100%;
}
.yuqi-workbench.yuqi-management .yuqi-activity-aligned > .yuqi-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #FFFFFF;
  padding: 2px 0 6px;
  margin: 0;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}
.yuqi-workbench.yuqi-management .yuqi-activity-aligned h3 {
  font-size: 15px;
  font-weight: 600;
  color: #0F1115;
  margin: 0;
}
.yuqi-workbench.yuqi-management .yuqi-activity-aligned .yuqi-plan-explanation {
  font-size: 12px;
  color: #61666B;
  line-height: 1.5;
  margin: 0;
  padding: 8px 14px;
  background: #F9FAFB;
  border: 0.5px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph {
  overflow: auto;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 16px;
  background: #F9FAFB;
  flex: 1;
  height: 100%;
  min-height: 420px;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-canvas {
  display: flex;
  align-items: flex-start;
  gap: 40px;
  position: relative;
  width: max-content;
  min-width: 100%;
  padding: 24px;
}
.yuqi-workbench.yuqi-management .yuqi-activity-layer {
  width: 252px;
  flex: 0 0 252px;
  min-width: 0;
}
.yuqi-workbench.yuqi-management .yuqi-activity-layer > summary {
  font-size: 13px;
  font-weight: 600;
  color: #0F1115;
  padding-bottom: 14px;
  cursor: pointer;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node {
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 10px;
  background: #FFFFFF;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  padding: 12px;
  transition: all .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node:hover {
  border-color: rgba(36, 84, 245, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node button.yuqi-secondary-action {
  height: auto !important;
  min-height: 36px !important;
  line-height: 1.5 !important;
  padding: 8px 10px !important;
  border-radius: 8px !important;
  font-size: 12.5px !important;
  font-weight: 500 !important;
  text-align: left !important;
  border: 0.5px solid rgba(0, 0, 0, 0.1) !important;
  background: #FFFFFF !important;
  color: #0F1115 !important;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03) !important;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node button.yuqi-secondary-action:hover:not(:disabled) {
  border-color: rgba(36, 84, 245, 0.4) !important;
  background: #F8FAFC !important;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node .yuqi-insight-block {
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph-node .yuqi-status {
  width: fit-content;
}
.yuqi-workbench.yuqi-management .yuqi-route-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.yuqi-workbench.yuqi-management .yuqi-route-heading p,
.yuqi-workbench.yuqi-management .yuqi-route-empty-copy {
  margin: 4px 0 0;
  font-size: 12px;
  color: #61666B;
}
.yuqi-workbench.yuqi-management .yuqi-route-heading > span {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  background: #F1F3F5;
  color: #61666B;
  font-size: 12px;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-route-node-select {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px 8px;
  width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #0F1115;
  font: inherit;
  text-align: left;
}
.yuqi-workbench.yuqi-management .yuqi-route-node-select:not(:disabled) { cursor: pointer; }
.yuqi-workbench.yuqi-management .yuqi-route-node-select:not(:disabled):hover strong { color: #2454F5; }
.yuqi-workbench.yuqi-management .yuqi-route-node-select:focus-visible { outline: 2px solid #2454F5; outline-offset: 4px; border-radius: 4px; }
.yuqi-workbench.yuqi-management .yuqi-route-node-id {
  grid-row: span 2;
  align-self: start;
  padding: 2px 6px;
  border-radius: 5px;
  background: #F1F3F5;
  color: #61666B;
  font-size: 11px;
  font-weight: 600;
}
.yuqi-workbench.yuqi-management .yuqi-route-node-select strong {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yuqi-workbench.yuqi-management .yuqi-route-node-select .yuqi-status { font-size: 11px; }
.yuqi-workbench.yuqi-management .yuqi-route-node-dependency,
.yuqi-workbench.yuqi-management .yuqi-route-node-action {
  margin: 10px 0 0;
  color: #81858C;
  font-size: 11.5px;
  line-height: 1.45;
}
.yuqi-workbench.yuqi-management .yuqi-route-node-action { color: #61666B; }
.yuqi-workbench.yuqi-management .yuqi-route-node-action span { margin-right: 6px; color: #81858C; }
.yuqi-workbench.yuqi-management .yuqi-activity-edges {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  color: #ADB5BD;
}
.yuqi-workbench.yuqi-management .yuqi-activity-edges path {
  transition: all .15s ease;
}
.yuqi-workbench.yuqi-management .yuqi-activity-graph:hover .yuqi-activity-edges {
  color: #868E96;
}

/* Footer */
.yuqi-workbench.yuqi-management .yuqi-workbench-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 28px;
  border-top: 0.5px solid rgba(0, 0, 0, 0.06);
  background: #FFFFFF;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-footer span {
  font-size: 12.5px;
  color: #81858C;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-footer button {
  height: 32px;
  padding: 0 16px;
  border-radius: 16px;
  font-size: 12.5px;
  font-weight: 500;
  background: #EBEEF2;
  border: none;
  color: #0F1115;
  cursor: pointer;
  transition: background-color .12s ease;
}
.yuqi-workbench.yuqi-management .yuqi-workbench-footer button:hover {
  background: #E2E5E9;
}

/* Collapsible Composer in Tasks View */
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure {
  margin: 0;
  border: none;
  border-bottom: 1px solid #e5e7eb;
  border-radius: 0;
  background: #FFFFFF;
  overflow: hidden;
  transition: all .15s ease;
  flex: none;
}
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  font-size: 13px;
  font-weight: 550;
  color: #374151;
  background: transparent;
  cursor: pointer;
  user-select: none;
}
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure > summary:hover {
  background: #F3F4F6;
  color: #111827;
}
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure[open] > summary {
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
  background: #F3F4F6;
}
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure .yuqi-team-message {
  padding: 0 0 16px;
  border: none;
  background: transparent;
}
.yuqi-workbench.yuqi-management .yuqi-task-composer-disclosure .yuqi-team-message-header strong { display:none; }
.yuqi-workbench.yuqi-management .yuqi-workbench-page[hidden] { display:none; }
@media(max-width:680px) {
  .yuqi-workbench.yuqi-management .yuqi-task-master-detail { grid-template-columns:minmax(180px,36%) minmax(0,1fr); }
  .yuqi-workbench.yuqi-management .yuqi-task-list { padding:20px 16px; }
}

/* Side-by-side Diff in Files & Evidence */
.yuqi-diff-segment {
  margin-bottom: 14px;
  border: 0.5px solid var(--activity-border, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--activity-surface, #FFFFFF);
}
.yuqi-diff-fragment-title {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #374151;
}
.yuqi-diff-side-by-side {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
.yuqi-diff-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.yuqi-diff-pane strong {
  font-size: 11.5px;
  color: var(--activity-muted, #6B7280);
}
.yuqi-diff-pane pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 0.5px solid rgba(0, 0, 0, 0.06);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.yuqi-diff-before pre {
  background: #FFF5F5;
  color: #991B1B;
  border-color: rgba(239, 68, 68, 0.2);
}
.yuqi-diff-after pre {
  background: #F0FDF4;
  color: #166534;
  border-color: rgba(34, 197, 94, 0.2);
}
@container yuqi-audit (max-width: 600px) {
  .yuqi-diff-side-by-side {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* Summary Storage Notice */
.yuqi-summary-storage-note {
  margin: 4px 0 16px;
  font-size: 12.5px;
  line-height: 1.5;
}
`
