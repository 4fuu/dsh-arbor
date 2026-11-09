/// <reference lib="dom" />
/**
 * The panel's stylesheet, built from DSH's own `--dsw-*` design tokens
 * (`@deepseek-ai/dsh-client-ui-theme`), so light and dark, the content font
 * size and the page's fonts all follow the rest of the web client.
 *
 * The ChillDIN face is set only on numbers, statuses and short labels: the
 * selector list below is the one place it enters, and it never reaches a
 * sentence, a note body or the stream text.
 */

import { FONT_FACES } from './font.ts'

/** The stylesheet's id, so a second apply replaces rather than doubles it. */
const STYLE_ID = 'arbor-ui-panel-style'

/** The panel's stylesheet. */
export const CSS = `${FONT_FACES}
.arbor-page,.arbor-panel{
  --arbor-face:'ArborChillDIN','ArborChillDINGothic',var(--dsw-font-family,system-ui,sans-serif);
  box-sizing:border-box;
  color:var(--dsw-alias-label-primary,#1b1b1f);
  font-family:var(--dsw-font-family,system-ui,sans-serif);
  font-size:12px;line-height:1.5;
}
.arbor-page{display:flex;flex-direction:column;gap:14px;min-height:100%;overflow:auto;padding:24px 28px 48px}
.arbor-panel{display:flex;flex-direction:column;gap:6px;height:100%;overflow:auto;padding:10px 12px 20px;font-size:12px;line-height:1.45}
.arbor-page *,.arbor-panel *{box-sizing:border-box}
.arbor-page-head,.arbor-tabs,.arbor-page-body{width:100%;max-width:1040px;margin:0 auto}
.arbor-page-head{display:flex;flex-direction:column;gap:5px;flex:none;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-page-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.arbor-page-title{font-size:19px;font-weight:600;letter-spacing:.01em}
.arbor-page-intro{font-size:12.5px;max-width:72ch}
.arbor-page-data{font-size:11px;overflow-wrap:anywhere}
.arbor-tabs{display:flex;flex:none;gap:2px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));overflow-x:auto}
.arbor-tab-group{display:flex;align-items:center;flex:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.arbor-tab{height:32px;padding:0 11px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:11.5px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.arbor-tab:hover{color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-tab-group.is-active{border-bottom-color:var(--dsw-alias-brand-primary,#4176e6)}
.arbor-tab-group.is-active .arbor-tab{color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:500}
.arbor-tabs>.arbor-tab.is-active{border-bottom-color:var(--dsw-alias-brand-primary,#4176e6);color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:500}
.arbor-tab-close{width:20px;height:20px;line-height:1;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a92);cursor:pointer;font-size:13px;padding:0;margin-right:3px}
.arbor-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-page-body{display:flex;flex-direction:column;flex:0 0 auto;gap:4px;padding-bottom:20px}
.arbor-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;padding:2px 0 8px}
.arbor-stat{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));display:flex;flex-direction:column;gap:1px;min-width:0}
.arbor-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.05em;text-transform:uppercase}
.arbor-stat-value{font-size:20px;font-weight:500;line-height:1.25}
.arbor-session-list{display:flex;flex-direction:column;gap:6px;padding:2px 0 8px}
.arbor-session-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));min-width:0}
.arbor-session-row.is-live{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 34%,var(--dsw-alias-border-l1,transparent))}
.arbor-session-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.arbor-session-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.arbor-session-name{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-session-id{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-session-doing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-session-meta{font-size:10.5px}
.arbor-session-open{height:27px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:11px;cursor:pointer;flex:none}
.arbor-session-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-session-head{display:flex;align-items:flex-start;gap:12px;padding:2px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin-bottom:4px}
.arbor-session-head-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.arbor-session-head-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.arbor-session-head .arbor-session-name{font-size:15px}
.arbor-session-view{gap:2px}
.arbor-session-hint{margin-top:8px}
.arbor-chip-session{color:var(--dsw-alias-brand-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 12%,transparent)}
.arbor-page .arbor-sec-title,.arbor-page .arbor-stat-label,.arbor-page .arbor-page-title{font-family:var(--arbor-face)}
.arbor-page .arbor-sec-title{font-size:11px}
.arbor-page .arbor-sec-head{padding:12px 2px 8px}
.arbor-page .arbor-sec-body{padding-bottom:14px;gap:8px}
.arbor-page .arbor-muted{font-size:11.5px}
.arbor-page .arbor-empty{padding:14px}
.arbor-panel-empty{padding-top:22px}
.arbor-muted{color:var(--dsw-alias-label-tertiary,#8a8a92);font-size:11px}
.arbor-error{color:var(--dsw-alias-state-error-primary,#c62828);font-size:11px}
.arbor-hint{color:var(--dsw-alias-label-tertiary,#8a8a92);font-size:11px;line-height:1.5;margin-top:2px}
.arbor-stack{display:flex;flex-direction:column;gap:6px}
.arbor-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.arbor-label{letter-spacing:.01em}
.arbor-num,.arbor-handoff-key,.arbor-win-ref,.arbor-win-use,.arbor-chip,.arbor-badge,.arbor-sec-title,.arbor-kv-key,.arbor-panel-title,.arbor-panel-windows,.arbor-chip-name,.arbor-chip-state,.arbor-env-name,.arbor-note-id,.arbor-board-state,.arbor-stream-label,.arbor-send-label,.arbor-search-go,.arbor-hit-kind,.arbor-schedule-name{
  font-family:var(--arbor-face);
  font-feature-settings:'tnum' 1,'lnum' 1;
}
.arbor-num{font-variant-numeric:tabular-nums}
.arbor-panel-head{display:flex;flex-direction:column;gap:2px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-panel-title-row{display:flex;align-items:center;gap:7px;min-width:0}
.arbor-panel-mark{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4176e6);flex:none}
.arbor-panel-mark.is-live{animation:arbor-pulse 1.4s ease-in-out infinite}
.arbor-panel-title{font-size:12px;font-weight:500;letter-spacing:.04em}
.arbor-panel-windows{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a92);white-space:nowrap}
.arbor-panel-doing{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arbor-sec{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-sec:last-child{border-bottom:none}
.arbor-sec-head{display:flex;align-items:center;gap:8px;padding:8px 2px;cursor:pointer;list-style:none;user-select:none}
.arbor-sec-head::-webkit-details-marker{display:none}
.arbor-sec-title{font-size:10.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-sec-count{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-chevron{width:0;height:0;border-left:4px solid var(--dsw-alias-label-tertiary,#8a8a92);border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;transition:transform .15s ease;flex:none}
.arbor-sec[open] .arbor-chevron{transform:rotate(90deg)}
.arbor-sec-body{padding:0 2px 10px;display:flex;flex-direction:column;gap:6px}
.arbor-wins{display:flex;flex-direction:column;gap:8px}
.arbor-win{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;padding:7px 8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));display:flex;flex-direction:column;gap:4px;min-width:0}
.arbor-win-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 35%,var(--dsw-alias-border-l1,transparent))}
.arbor-win-head{display:flex;align-items:center;gap:6px;min-width:0}
.arbor-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-dot-running{background:var(--dsw-alias-state-success-primary,#1a8a4a)}
.arbor-dot-idle{background:var(--dsw-alias-state-warn-primary,#b26a00)}
.arbor-dot-paused{background:var(--dsw-alias-state-warn-primary,#b26a00)}
.arbor-dot-ended{background:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-win-ref{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66);flex:none}
.arbor-chip{font-size:9.5px;line-height:16px;padding:0 5px;border-radius:5px;flex:none;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c5c66);white-space:nowrap}
.arbor-chip-running{color:var(--dsw-alias-state-success-primary,#1a8a4a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 12%,transparent)}
.arbor-chip-idle,.arbor-chip-paused{color:var(--dsw-alias-state-warn-primary,#b26a00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 12%,transparent)}
.arbor-win-doing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.arbor-win-use{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none;white-space:nowrap}
.arbor-win-meta{display:flex;flex-wrap:wrap;gap:3px 8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-meta-refs{font-size:10px;opacity:.8}
.arbor-meta-refused{color:var(--dsw-alias-state-error-primary,#c62828)}
.arbor-handoff{display:flex;flex-direction:column;gap:1px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 40%,transparent);padding-left:7px;margin:2px 0}
.arbor-handoff-row{display:flex;gap:7px;align-items:baseline;font-size:11px;min-width:0}
.arbor-handoff-key{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.03em}
.arbor-handoff-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-badge{display:inline-block;font-size:9.5px;line-height:15px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c5c66);white-space:nowrap}
.arbor-badge-handoff,.arbor-badge-accent{color:var(--dsw-alias-brand-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 12%,transparent)}
.arbor-badge-ok{color:var(--dsw-alias-state-success-primary,#1a8a4a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 12%,transparent)}
.arbor-badge-warn{color:var(--dsw-alias-state-warn-primary,#b26a00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 12%,transparent)}
.arbor-badge-err{color:var(--dsw-alias-state-error-primary,#c62828);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 12%,transparent)}
.arbor-badge-plain{opacity:.65}
.arbor-stream{margin-top:2px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:7px;padding:6px 7px;background:var(--dsw-alias-bg-base,transparent);display:flex;flex-direction:column;gap:4px}
.arbor-stream-head{display:flex;align-items:center;gap:6px}
.arbor-stream-label,.arbor-send-label{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-pulse{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-pulse.is-live{background:var(--dsw-alias-state-success-primary,#1a8a4a);animation:arbor-pulse 1.1s ease-in-out infinite}
.arbor-stream-text{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:170px;overflow:auto;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-send{margin-top:2px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-top:5px;display:flex;flex-direction:column;gap:3px}
.arbor-send-text{color:var(--dsw-alias-label-primary,#1b1b1f);max-height:130px}
.arbor-stream-empty{font-size:11px}
.arbor-kv{display:flex;gap:8px;align-items:baseline;min-width:0}
.arbor-kv-key{flex:none;width:76px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.03em}
.arbor-val{min-width:0;flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.arbor-mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px}
.arbor-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;display:inline-block;vertical-align:bottom}
.arbor-sub{display:flex;flex-direction:column;gap:3px}
.arbor-sub-title{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.04em;margin-top:2px}
.arbor-empty{border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px}
.arbor-empty-title{font-size:11px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-board{display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-bottom:5px}
.arbor-board:last-child{border-bottom:none;padding-bottom:0}
.arbor-board-state{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-board-doing{font-size:11.5px}
.arbor-board-open{display:flex;flex-wrap:wrap;gap:4px}
.arbor-board-targets{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-notes-head{display:flex;flex-direction:column;gap:1px}
.arbor-notes-count{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-note{border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));padding-left:7px;display:flex;flex-direction:column;gap:1px}
.arbor-note-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.arbor-note-id{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-note-title{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-note-sum{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.arbor-env-counts{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-env-name{font-size:11px}
.arbor-env-desc{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.arbor-schedule{display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-bottom:5px}
.arbor-schedule:last-child{border-bottom:none;padding-bottom:0}
.arbor-schedule-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.arbor-schedule-meta{font-size:10px}
.arbor-judge{display:flex;flex-wrap:wrap;gap:3px}
.arbor-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:11px}
.arbor-search{display:flex;gap:6px;align-items:center}
.arbor-search-input{flex:1;min-width:0;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:7px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1b1b1f);padding:0 8px;font:inherit;font-size:11px;outline:none}
.arbor-search-input:focus{border-color:var(--dsw-alias-brand-primary,#4176e6)}
.arbor-search-go{height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#1b1b1f);font-size:10px;letter-spacing:.06em;cursor:pointer}
.arbor-search-go:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.arbor-search-go:disabled{opacity:.45;cursor:default}
.arbor-search-hint{font-size:10px}
.arbor-hit{display:flex;flex-direction:column;gap:1px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));padding-left:7px}
.arbor-hit-head{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.arbor-hit-kind{font-size:10px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-hit-sum{font-size:11px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.arbor-loading{font-size:11px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-chip-button{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;cursor:pointer;flex:none}
.arbor-chip-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-chip-button.is-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 38%,var(--dsw-alias-border-l1,transparent))}
.arbor-chip-mark{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-chip-button.is-running .arbor-chip-mark{background:var(--dsw-alias-state-success-primary,#1a8a4a)}
.arbor-chip-mark.is-streaming{animation:arbor-pulse 1s ease-in-out infinite}
.arbor-chip-name{font-size:10.5px;font-weight:500;letter-spacing:.04em}
.arbor-chip-state{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);white-space:nowrap}
@keyframes arbor-pulse{0%,100%{opacity:.45;transform:scale(.86)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.arbor-panel-mark.is-live,.arbor-pulse.is-live,.arbor-chip-mark.is-streaming{animation:none}}
`

/** Put the panel's stylesheet in the page, replacing an earlier copy. */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
