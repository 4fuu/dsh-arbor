/// <reference lib="dom" />
/**
 * The arbor page's stylesheet, built from DSH's own `--dsw-*` design tokens
 * (`@deepseek-ai/dsh-client-ui-theme`), so light and dark, the content font
 * size and the page's fonts all follow the rest of the web client.
 *
 * Every text node carries one `data-arbor-text` role: body, display, numeric or
 * code. The four roles read `--arbor-font-body`, `--arbor-font-display`,
 * `--arbor-font-numeric` and `--arbor-font-code`, all defined on the page root
 * and defaulting to DSH's own body and monospace tokens. A font plugin can
 * override the properties without touching this stylesheet.
 */

/** The stylesheet's id, so a second apply replaces rather than doubles it. */
const STYLE_ID = 'arbor-ui-panel-style'

/** The page's stylesheet. */
export const CSS = `.arbor-page{
  --arbor-font-body:var(--dsw-font-family);
  --arbor-font-display:var(--dsw-font-family);
  --arbor-font-numeric:var(--dsw-font-family);
  --arbor-font-code:var(--ds-font-family-code);
  box-sizing:border-box;min-height:100%;overflow:auto;
  padding:24px 28px 32px;
  background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#0f1115);
  font-family:var(--arbor-font-body);
  font-size:13px;line-height:1.55;
}
.arbor-page *{box-sizing:border-box}
.arbor-page [data-arbor-text="body"]{font-family:var(--arbor-font-body)}
.arbor-page [data-arbor-text="display"]{font-family:var(--arbor-font-display)}
.arbor-page [data-arbor-text="numeric"]{font-family:var(--arbor-font-numeric);font-variant-numeric:tabular-nums}
.arbor-page [data-arbor-text="code"]{font-family:var(--arbor-font-code)}
.arbor-page-inner{width:100%;max-width:1160px;min-height:calc(100vh - 56px);margin:0 auto;display:flex;flex-direction:column;gap:14px}
.arbor-page .arbor-tabs{display:flex;flex:none;gap:4px;align-items:center;overflow-x:auto;padding:0 1px}
.arbor-page .arbor-tab-group{display:flex;align-items:center;flex:none}
.arbor-page .arbor-tab{height:27px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-tab.is-active, .arbor-page .arbor-tab-group.is-active .arbor-tab{background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-border-l1,#0000000a);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-tab-close{width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;font-size:13px;line-height:1}
.arbor-page .arbor-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-hero{display:flex;flex-direction:column;gap:2px;padding:8px 0 10px}
.arbor-page .arbor-hero-top{display:flex;align-items:center;gap:12px;min-height:32px}
.arbor-page .arbor-date{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-top-actions{display:flex;gap:6px;align-items:center;flex:none}
.arbor-page .arbor-icon-button{width:32px;height:32px;padding:0;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;box-shadow:var(--dsw-elevation-soft,0 4px 16px #00000008)}
.arbor-page .arbor-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-hero-title{max-width:960px;margin:10px 0 2px;font-size:clamp(20px,2vw,27px);line-height:1.5;font-weight:400;letter-spacing:.005em;color:var(--dsw-alias-label-tertiary,#81858c);text-wrap:balance}
.arbor-page .arbor-hero-num{font-family:var(--arbor-font-numeric);font-weight:600;font-size:1.18em;line-height:.95;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-hero-name{font-weight:400;color:inherit}.arbor-page .arbor-hero-title .arbor-hero-name{color:inherit}
.arbor-page .arbor-hero-hint{display:block;margin-top:10px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hero-links{display:flex;gap:10px;margin-top:6px}.arbor-page .arbor-hero-links .arbor-card-link{margin-left:0;align-self:flex-start}
.arbor-page .arbor-overview{display:flex;flex:1;flex-direction:column;gap:4px;min-height:0}
.arbor-page .arbor-sky{position:relative;width:100%;flex:none;min-height:0}
.arbor-page .arbor-sky-cell{position:absolute;min-width:0;z-index:1;transform-origin:50% 50%;transition:transform 150ms ease}
.arbor-page .arbor-sky-cell>.arbor-card{width:100%}
.arbor-page .arbor-sky-cell[data-paper="true"]{transform:rotate(var(--arbor-tilt,0deg))}
.arbor-page .arbor-sky-cell[data-paper="true"]:hover{transform:rotate(0deg) translateY(-2px);z-index:4}
.arbor-page .arbor-sky-cell[data-paper="true"]>.arbor-card{transition:box-shadow 150ms ease}
.arbor-page .arbor-sky-cell[data-paper="true"]:hover>.arbor-card{box-shadow:0 14px 30px #00000024}
.arbor-page .arbor-index-card{background:var(--dsw-alias-bg-layer-1,#fff);border-top:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);border-radius:7px;box-shadow:0 7px 18px #00000012}
.arbor-page .arbor-note-card{border-radius:8px;box-shadow:0 8px 20px #00000014}
.arbor-page .arbor-card{min-width:0;display:flex;flex-direction:column;gap:7px;padding:15px 17px 12px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:17px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 4px 16px #00000008);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.arbor-page .arbor-card-kicker{flex:1;min-width:0;font-size:10px;line-height:14px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-aside{flex:none;display:inline-flex;align-items:center;gap:6px}
.arbor-page .arbor-card-session{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-title{font-size:16px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere}
.arbor-page .arbor-card-project{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-card-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-card-foot{margin-top:auto;display:flex;align-items:baseline;gap:3px 7px;flex-wrap:wrap;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a);font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-card-foot-line{flex-basis:100%;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-link{margin-left:auto;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-card-link:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-board-card{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 7%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-note-card{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 9%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 20%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-empty-card{min-height:220px;align-items:center;justify-content:center;text-align:center;gap:8px;border-style:dashed;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 55%,transparent)}
.arbor-page .arbor-empty-mark{width:40px;height:40px;border:1px dashed var(--dsw-alias-border-l3,#0000001f);border-radius:50%;position:relative;margin-bottom:4px}
.arbor-page .arbor-empty-mark:after{content:'';position:absolute;inset:13px;border-radius:50%;background:var(--dsw-alias-brand-primary,#0f1115);opacity:.16}
.arbor-page .arbor-empty-title{font-size:19px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-empty-hint{max-width:44ch;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-state{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:9.5px;line-height:18px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-state-running{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent)}
.arbor-page .arbor-state-idle, .arbor-page .arbor-state-paused{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}
.arbor-page .arbor-state-ended{color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-dot-running{background:var(--dsw-alias-state-success-primary,#22c55e)}
.arbor-page .arbor-dot-idle{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.arbor-page .arbor-dot-paused{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.arbor-page .arbor-dot-ended{background:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-stream-block{margin-top:2px;padding:10px 11px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:5px;min-width:0}
.arbor-page .arbor-stream-head{display:flex;align-items:center;gap:6px}
.arbor-page .arbor-pulse{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#81858c);flex:none}
.arbor-page .arbor-pulse.is-live{background:var(--dsw-alias-state-success-primary,#22c55e);animation:arbor-pulse 1.1s ease-in-out infinite}
.arbor-page .arbor-stream-label{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-md-wrap{max-height:260px;overflow:hidden;position:relative}
.arbor-page .arbor-md-wrap.is-clamped{mask-image:linear-gradient(180deg,#000 72%,transparent 100%)}
.arbor-page .arbor-md-wrap.is-expanded{max-height:none;overflow:visible}
.arbor-page .arbor-md{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-md-p{margin:0 0 8px}
.arbor-page .arbor-md-p:last-child{margin-bottom:0}
.arbor-page .arbor-md-heading{margin:4px 0 7px;font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-md-list{margin:0 0 8px;padding-left:18px}
.arbor-page .arbor-md-list li{margin:1px 0}
.arbor-page .arbor-md-pre{margin:0 0 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#f5f5f5));overflow:auto;font-family:var(--arbor-font-code);font-size:11px;line-height:1.55}
.arbor-page .arbor-md-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-bg-layer-2,#f5f5f5));font-family:var(--arbor-font-code);font-size:11px}
.arbor-page .arbor-md-link{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#4176e6));text-decoration:underline;text-underline-offset:2px}
.arbor-page .arbor-stream-toggle{align-self:flex-start;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:10.5px;cursor:pointer}
.arbor-page .arbor-stream-toggle:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-stream-empty{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-stream-send{margin-top:4px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:3px}
.arbor-page .arbor-chain-scroll{overflow-x:auto;padding:3px 0 7px;scrollbar-width:thin}
.arbor-page .arbor-chain-card{container-type:inline-size}
.arbor-page .arbor-chain{display:flex;align-items:center;min-width:max-content}
.arbor-page .arbor-node{min-width:112px;max-width:166px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:12px;background:var(--dsw-alias-interactive-bg-hover,#2631480f);display:flex;flex-direction:column;gap:1px;min-height:72px}
.arbor-page .arbor-node-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 35%,var(--dsw-alias-border-l1,#0000000a));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 7%,var(--dsw-alias-bg-layer-1,#fff))}
.arbor-page .arbor-node-idle{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 28%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-node-ref{font-family:var(--arbor-font-numeric);font-size:15px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-node-state{font-size:9px;line-height:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-node-running .arbor-node-state{color:var(--dsw-alias-state-success-primary,#22c55e)}
.arbor-page .arbor-node-doing{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-connector{width:52px;flex:none;height:72px;display:flex;align-items:center;justify-content:center;position:relative}
.arbor-page .arbor-connector-line{position:absolute;left:0;right:0;top:50%;height:1px;background:var(--dsw-alias-border-l2,#0000001a)}
.arbor-page .arbor-connector-label{position:relative;z-index:1;padding:0 4px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap}
.arbor-page .arbor-connector-arrow{position:relative;z-index:1;padding-left:2px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:1}
.arbor-page .arbor-handoffs{display:flex;flex-direction:column;gap:3px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-handoff-row{display:flex;gap:8px;align-items:baseline;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-handoff-ref{flex:none;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.04em}
.arbor-page .arbor-handoff-text{min-width:0;overflow-wrap:anywhere}
.arbor-page .arbor-note-sum{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-tags{display:flex;flex-wrap:wrap;gap:4px}
.arbor-page .arbor-tag{display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:6px;font-size:9.5px;line-height:19px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-tag-ok{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent)}
.arbor-page .arbor-tag-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}
.arbor-page .arbor-tag-err{color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent)}
.arbor-page .arbor-tag-plain{opacity:.7}
.arbor-page .arbor-env-counts{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;padding:1px 0 4px}
.arbor-page .arbor-env-count{display:flex;align-items:baseline;gap:3px;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}
.arbor-page .arbor-env-big{font-family:var(--arbor-font-numeric);font-size:26px;line-height:30px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-env-group{padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:1px}
.arbor-page .arbor-env-group-title{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c);margin-bottom:2px}
.arbor-page .arbor-env-row{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:11.5px;line-height:1.6}
.arbor-page .arbor-env-name{flex:none;max-width:55%;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-env-path{flex:1;min-width:0;overflow-wrap:anywhere;font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-env-functions{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}
.arbor-page .arbor-env-revision{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-schedule-next{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-workspace-rows{display:flex;flex-direction:column;gap:7px;min-width:0}
.arbor-page .arbor-workspace-row{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-workspace-row>.arbor-label{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-workspace-list{display:flex;flex-direction:column;gap:2px;min-width:0}
.arbor-page .arbor-workspace-item{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px}
.arbor-page .arbor-muted{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.arbor-page .arbor-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:1.5}
.arbor-page .arbor-mono{font-family:var(--arbor-font-code);font-size:10.5px;overflow-wrap:anywhere}
.arbor-page .arbor-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.arbor-page .arbor-label{letter-spacing:.02em}
.arbor-page .arbor-num{font-variant-numeric:tabular-nums}
.arbor-page .arbor-dock{position:sticky;bottom:18px;z-index:8;margin:10px auto 0;width:fit-content;max-width:calc(100% - 24px);padding:5px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #0000000a);isolation:isolate}
.arbor-page .arbor-dock-pills{display:flex;gap:2px;align-items:center;overflow-x:auto;scrollbar-width:none}
.arbor-page .arbor-dock-pills::-webkit-scrollbar{display:none}
.arbor-page .arbor-pill{height:30px;padding:0 13px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-pill:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-pill.is-active{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}
.arbor-page .arbor-sheet-layer{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end}
.arbor-page .arbor-sheet-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-2,#0000001f);backdrop-filter:blur(1px)}
.arbor-page .arbor-sheet{position:relative;width:min(560px,100%);height:100%;overflow:auto;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));border-left:1px solid var(--dsw-alias-border-l1,#0000000a);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #0000000a);padding:18px 20px 28px;display:flex;flex-direction:column;gap:14px}
.arbor-page .arbor-sheet-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:10px;padding-bottom:10px;background:inherit;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-sheet-title{flex:1;margin:0;font-size:16px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-sheet-body{display:flex;flex-direction:column;gap:12px}
.arbor-page .arbor-settings{display:flex;flex-direction:column;gap:8px;font-size:12px}
.arbor-page .arbor-settings-source{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-settings-group{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-settings-group-title{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-setting-row{display:flex;gap:10px;align-items:baseline;min-width:0;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-setting-row:last-child{border-bottom:none}
.arbor-page .arbor-setting-key{flex:none;width:98px;font-size:9.5px;line-height:1.45;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-setting-value{flex:1;min-width:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-settings-wrap{overflow-wrap:anywhere}
.arbor-page .arbor-settings-note{padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,var(--dsw-alias-border-l1,#0000000a));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 7%,var(--dsw-alias-bg-layer-1,#fff));font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search{display:flex;flex-direction:column;gap:8px}
.arbor-page .arbor-search-row{display:flex;gap:7px;align-items:center}
.arbor-page .arbor-search-input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;outline:none}
.arbor-page .arbor-search-input:focus{border-color:var(--dsw-alias-brand-primary,#0f1115)}
.arbor-page .arbor-search-go{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-size:10px;letter-spacing:.05em;cursor:pointer}
.arbor-page .arbor-search-go:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
.arbor-page .arbor-search-go:disabled{opacity:.45;cursor:default}
.arbor-page .arbor-search-hint{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-search-empty{padding:18px 0;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search-results{display:flex;flex-direction:column;gap:12px}
.arbor-page .arbor-search-total{font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search-group{display:flex;flex-direction:column;gap:5px}
.arbor-page .arbor-search-group-title{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#0000000a);background:var(--dsw-alias-bg-layer-2,#fff)}
.arbor-page .arbor-hit-head{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}
.arbor-page .arbor-hit-ref{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit-kind{font-size:9.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-hit-window{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit-sum{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
@container (max-width:460px){
.arbor-page .arbor-node{min-width:90px;max-width:130px;padding:8px 9px}
.arbor-page .arbor-connector{width:28px}
}
@container (max-width:360px){
.arbor-page .arbor-node{min-width:76px;max-width:120px;padding:7px 8px}
.arbor-page .arbor-connector{width:20px}
.arbor-page .arbor-node-ref{font-size:13px;line-height:17px}
.arbor-page .arbor-node-handoff{font-size:8px;padding:0 4px}
}
@container (max-width:260px){
.arbor-page .arbor-node{min-width:70px;max-width:100px;padding:6px 7px}
.arbor-page .arbor-connector{width:16px}
.arbor-page .arbor-node-handoff{display:none}
}
@keyframes arbor-pulse{0%,100%{opacity:.45;transform:scale(.86)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){
.arbor-page .arbor-sky-cell{transform:none!important;transition:none!important}
.arbor-page .arbor-sky-cell>.arbor-card{transition:none!important}
}
@media (max-width:620px){
.arbor-page{padding:18px 14px 24px}
.arbor-page .arbor-hero-title{font-size:23px}
.arbor-page .arbor-hero-hint{font-size:12px}
.arbor-page .arbor-dock{max-width:100%}
.arbor-page .arbor-pill{padding:0 10px}
}
@media (prefers-reduced-motion:reduce){.arbor-page .arbor-pulse.is-live{animation:none}}`

/** Put the page's stylesheet in the page, replacing an earlier copy. */
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
