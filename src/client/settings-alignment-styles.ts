/** Append after managementStyles. Scoped to the defaults cards, never Host chrome.
 * Enforces refined light mode styling with crisp form controls and accessible hierarchy.
 */
export const settingsAlignmentStyles = `
.yuqi-settings-aligned.yuqi-defaults-grid{grid-template-columns:minmax(0,1fr);align-items:stretch;column-gap:0!important;row-gap:0!important}
.yuqi-settings-aligned .yuqi-settings-introduction{display:none!important}
.yuqi-settings-aligned .yuqi-settings-group{display:flex;flex-direction:column;gap:0;padding:0!important;border:none!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;min-width:0;max-width:none;align-self:stretch}
.yuqi-settings-aligned .yuqi-settings-group h3{flex:none;margin:0;padding:24px 0 8px;border:none!important;border-bottom:none!important;border-radius:0;font-size:14px;font-weight:500;line-height:22px;color:#0F1115;background:transparent!important}
.yuqi-settings-aligned .yuqi-settings-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:16px;row-gap:2px;padding:16px 0;border:none;border-bottom:0.5px solid rgba(0,0,0,0.1);margin:0}
.yuqi-settings-aligned .yuqi-settings-field:last-of-type{border-bottom:none}
.yuqi-settings-aligned .yuqi-settings-field>span{grid-column:1;grid-row:1;font-size:14px;font-weight:400;line-height:22px;color:#0F1115}
.yuqi-settings-aligned .yuqi-settings-field>small{grid-column:1;grid-row:2;font-size:12px;font-weight:400;line-height:18px;color:#81858C;margin:0}
.yuqi-settings-aligned .yuqi-settings-field>:is(input:not([type=checkbox]),select){grid-column:2;grid-row:1/span 2;justify-self:end;width:auto}
.yuqi-settings-aligned .yuqi-settings-field input[type=number]{box-sizing:border-box;min-width:72px;width:72px;height:36px;padding:0 8px;border:0.5px solid rgba(0,0,0,0.08);border-radius:18px;background:#F0F2F5;color:#0F1115;font:inherit;font-size:14px;font-weight:400;text-align:center;font-variant-numeric:tabular-nums;outline:none;transition:all .12s ease}
.yuqi-settings-aligned .yuqi-settings-field input[type=number]:hover:not(:disabled){background:#E4E7EB;border-color:rgba(0,0,0,0.16)}
.yuqi-settings-aligned .yuqi-settings-field select{box-sizing:border-box;height:36px;min-width:180px;max-width:320px;padding:0 34px 0 14px;border:0.5px solid rgba(0,0,0,0.08);border-radius:18px;background-color:#F0F2F5;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M3.5 6L8 10.5L12.5 6' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:14px 14px;appearance:none;-webkit-appearance:none;color:#0F1115;font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:all .12s ease}
.yuqi-settings-aligned .yuqi-settings-field select:hover:not(:disabled){background-color:#E4E7EB;border-color:rgba(0,0,0,0.16)}
.yuqi-settings-aligned .yuqi-settings-field input[type=text]{box-sizing:border-box;min-width:220px;max-width:380px;height:36px;padding:0 14px;border:0.5px solid rgba(0,0,0,0.08);border-radius:18px;background:#F0F2F5;color:#0F1115;font:inherit;font-size:14px;line-height:22px;transition:all .12s ease}
.yuqi-settings-aligned .yuqi-settings-field input[type=text]:hover:not(:disabled){background:#E4E7EB;border-color:rgba(0,0,0,0.16)}
.yuqi-settings-aligned .yuqi-settings-switch input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;box-sizing:border-box;grid-column:2;grid-row:1/span 2;justify-self:end;width:36px;height:20px;min-height:20px;padding:2px;margin:0;border:none;border-radius:10px;background:rgba(0,0,0,0.12);cursor:pointer;transition:background-color .12s ease}
.yuqi-settings-aligned .yuqi-settings-switch input[type=checkbox]::before{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,0.15);transition:transform .12s ease}
.yuqi-settings-aligned .yuqi-settings-switch input[type=checkbox]:checked{background:#0F1115}
.yuqi-settings-aligned .yuqi-settings-switch input[type=checkbox]:checked::before{transform:translateX(16px)}
.yuqi-settings-aligned .yuqi-settings-switch input:disabled{opacity:.4;cursor:not-allowed}
.yuqi-settings-aligned .yuqi-settings-model-tiers{display:grid;gap:8px;padding:14px 16px;border:0.5px solid rgba(0,0,0,0.1);border-radius:16px;background:#F9FAFB;margin:8px 0}
.yuqi-settings-aligned .yuqi-settings-model-tiers legend{font-size:12px;font-weight:500;color:#0F1115;padding:0 4px}
.yuqi-settings-aligned .yuqi-settings-model-tiers label{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 14px;font-size:13px}
.yuqi-settings-aligned .yuqi-settings-model-tiers label>span{font-size:13px;font-weight:400;color:#61666B}
.yuqi-settings-aligned .yuqi-settings-model-tiers select{min-width:200px;max-width:320px;height:34px;padding:0 30px 0 12px;font-size:13px;background-color:#FFFFFF;border:0.5px solid rgba(0,0,0,0.12);border-radius:17px}
.yuqi-settings-aligned .yuqi-settings-review-policy{display:grid;gap:8px;margin:0;padding:0;border:0;background:transparent}
.yuqi-settings-aligned .yuqi-review-mode-choices{display:flex;gap:8px;margin:8px 0 12px;width:100%}
.yuqi-settings-aligned .yuqi-review-mode-choices label{position:relative;flex:1;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:76px;padding:18px 24px;border:0.5px solid rgba(0,0,0,0.16);border-radius:20px;background:transparent;color:#0F1115;text-align:center;font-size:14px;line-height:22px;cursor:pointer;transition:all .12s ease}
.yuqi-settings-aligned .yuqi-review-mode-choices label input[type=radio]{position:absolute;opacity:0;pointer-events:none}
.yuqi-settings-aligned .yuqi-review-mode-choices label strong{font-weight:400}
.yuqi-settings-aligned .yuqi-review-mode-choices label:hover:not(.selected):not(:has(input:checked)){background:rgba(38,49,72,0.06)}
.yuqi-settings-aligned .yuqi-review-mode-choices label.selected,
.yuqi-settings-aligned .yuqi-review-mode-choices label:has(input:checked){background:#F5F6F7;border-color:#ADB2B8;font-weight:500;box-shadow:none}
.yuqi-settings-aligned .yuqi-review-mode-choices label:has(input:disabled){cursor:not-allowed;opacity:.4}
.yuqi-settings-aligned .yuqi-review-rework-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:16px;row-gap:2px;padding:16px 0;border-bottom:0.5px solid rgba(0,0,0,0.1)}
.yuqi-settings-aligned .yuqi-review-rework-field>span:first-child{grid-column:1;grid-row:1;font-size:14px;font-weight:400;color:#0F1115}
.yuqi-settings-aligned .yuqi-review-rework-field>small{grid-column:1;grid-row:2;font-size:12px;color:#81858C;margin:0}
.yuqi-settings-aligned .yuqi-review-rework-field>.yuqi-review-rework-control{grid-column:2;grid-row:1/span 2;justify-self:end;display:flex;align-items:center;gap:6px;padding:0 12px;height:36px;border-radius:18px;background:#F0F2F5;border:0.5px solid rgba(0,0,0,0.08);transition:all .12s ease}
.yuqi-settings-aligned .yuqi-review-rework-field>.yuqi-review-rework-control:hover:not(:has(input:disabled)){background:#E4E7EB;border-color:rgba(0,0,0,0.16)}
.yuqi-settings-aligned .yuqi-review-rework-field>.yuqi-review-rework-control input[type=number]{width:44px;height:32px;padding:0;border:0!important;background:transparent!important;color:#0F1115;text-align:center;font-size:14px;font-variant-numeric:tabular-nums}
.yuqi-settings-aligned .yuqi-review-rework-field>.yuqi-review-rework-control em{font-size:13px;font-style:normal;color:#61666B;white-space:nowrap}
.yuqi-settings-aligned .yuqi-review-tip{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-radius:14px;background:#F0F2F5;border:0.5px solid rgba(0,0,0,0.06);margin:10px 0}
.yuqi-settings-aligned .yuqi-review-tip-icon{font-size:14px;line-height:1.4;flex:none}
.yuqi-settings-aligned .yuqi-review-tip p{margin:0;font-size:12.5px;line-height:1.55;color:#4B5157}
.yuqi-settings-aligned .yuqi-review-guide{display:grid;gap:4px;padding:10px 14px;border-radius:12px;background:#F9FAFB;margin:8px 0}
.yuqi-settings-aligned .yuqi-review-guide p{margin:0;font-size:12px;line-height:1.55;color:#81858C}
.yuqi-settings-aligned .yuqi-settings-field:has(textarea){grid-template-columns:minmax(0,1fr);padding:14px 0}
.yuqi-settings-aligned .yuqi-settings-field:has(textarea)>span{grid-column:1;grid-row:1}
.yuqi-settings-aligned .yuqi-settings-field:has(textarea)>textarea{grid-column:1;grid-row:2;width:100%;min-height:88px;padding:10px 14px;border:0.5px solid rgba(0,0,0,0.08);border-radius:14px;background:#F0F2F5;color:#0F1115;font:inherit;font-size:13.5px;line-height:1.55;resize:vertical;transition:all .12s ease}
.yuqi-settings-aligned .yuqi-settings-field:has(textarea)>textarea:focus{background:#FFFFFF;border-color:#0F1115}
.yuqi-settings-aligned .yuqi-settings-field:has(textarea)>small{grid-column:1;grid-row:3;margin-top:4px}
.yuqi-settings-aligned .yuqi-settings-provider-list{margin:8px 0;padding:12px;border:0.5px solid rgba(0,0,0,0.1);border-radius:14px;max-height:180px;overflow:auto;overscroll-behavior:contain;background:#F9FAFB}
.yuqi-settings-aligned .yuqi-settings-provider-list legend{font-size:12px;font-weight:500;color:#0F1115}
.yuqi-settings-aligned .yuqi-settings-provider-list label{display:flex;align-items:center;min-height:28px;gap:8px;font-size:13px;color:#0F1115}
.yuqi-settings-aligned .yuqi-settings-help,.yuqi-settings-aligned .yuqi-settings-catalog-note{display:block;margin:6px 0 0;padding:0;border:0;background:transparent;font-size:12px;line-height:1.6;color:#81858C}
.yuqi-settings-aligned details{display:block;margin:12px 0;padding:0;border:0.5px solid rgba(0,0,0,0.08);border-radius:14px;background:#FAFAFA;overflow:hidden;transition:all .12s ease}
.yuqi-settings-aligned details:hover{border-color:rgba(0,0,0,0.14)}
.yuqi-settings-aligned details>summary{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:12px 16px;cursor:pointer;font-size:13px;font-weight:500;color:#0F1115;list-style:none;user-select:none;transition:background-color .12s ease}
.yuqi-settings-aligned details>summary::-webkit-details-marker{display:none}
.yuqi-settings-aligned details>summary::before{content:'';display:inline-block;width:14px;height:14px;flex:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M6 3.5L10.5 8L6 12.5' stroke='%2361666B' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:center;background-size:14px 14px;transition:transform .18s cubic-bezier(0.16, 1, 0.3, 1)}
.yuqi-settings-aligned details[open]>summary::before{transform:rotate(90deg)}
.yuqi-settings-aligned details[open]>summary{border-bottom:0.5px solid rgba(0,0,0,0.06);background:transparent}
.yuqi-settings-aligned details>summary:hover{background:rgba(38,49,72,0.04);color:#0F1115}
.yuqi-settings-aligned details>*:not(summary){margin:12px 16px;font-size:12px;line-height:1.6;color:#81858C}
.yuqi-settings-aligned details>button{margin:8px 16px 14px}
.yuqi-settings-aligned :is(input,select,textarea):focus-visible{outline:2px solid #0F1115;outline-offset:1px}
@media(max-width:760px){.yuqi-settings-aligned .yuqi-settings-field{grid-template-columns:minmax(0,1fr)}.yuqi-settings-aligned .yuqi-settings-field>:is(input,select){grid-column:1;grid-row:3;justify-self:start;width:100%;max-width:none}}
`
