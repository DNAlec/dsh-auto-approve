/**
 * dsh-auto-approve — 浏览器半：提示条、审批时间线、设置页。
 * 访问模式芯片上的盾+A 由本插件画在「自动审批」按钮/菜单上，不改 DSH。
 * 纯 JS：无 TS / JSX / import。React 用 createElement。

 * 网页文案：locales.mjs 的 zh/en，apply 时 ctx.locale.register。
 * Host API 走 connection.rpc.call('/api', 'dsh-auto-approve', …)（已鉴权），不用裸 HTTP。
 * 设置页折叠状态用 React state 控 details，避免 snapshot 刷新后合上。人工只走原网页审批框。
 * 恢复默认：第一次点武装，5 秒内再点才执行。
 */
window.__ModuleLoader__.load({
  id: '@dnalec/dsh-auto-approve',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const CSS = `
.ab-notice{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}
.ab-notice-card{box-sizing:border-box;display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:6px 10px 6px 12px;box-shadow:var(--dsw-shadow-lv1)}
.ab-notice-card-pending{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.ab-notice-card-manual{border-color:var(--dsw-alias-state-warn-primary)}
.ab-notice-card-err{border-color:var(--dsw-alias-state-error-primary)}
.ab-notice-glyph{color:var(--dsw-alias-state-success-primary);flex:none;display:inline-flex;align-items:center;justify-content:center}
.ab-notice-glyph-warn{color:var(--dsw-alias-state-warn-label);flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:16px;width:16px;height:16px}
.ab-notice-glyph-err{color:var(--dsw-alias-state-error-primary);flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:16px;width:16px;height:16px}
.ab-notice-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.ab-notice-head{display:flex;align-items:center;gap:8px;min-width:0}
.ab-notice-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ab-notice-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ab-notice-meta{display:flex;align-items:center;gap:8px}
.ab-tag{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ab-tag-neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ab-tag-warn{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex}
.ab-tag-err{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex}
.ab-time{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.ab-notice-close{width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0}
.ab-notice-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ab-view{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);position:relative}
.ab-view-head{box-sizing:border-box;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 14px 8px;display:flex;flex-direction:column;gap:2px}
.ab-view-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.ab-view-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ab-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 14px 48px;display:flex;flex-direction:column;gap:2px}
.ab-row{box-sizing:border-box;display:flex;gap:10px;padding:9px 10px;border-radius:10px;width:100%;text-align:left;background:transparent;font:inherit;color:inherit}
.ab-row-open{background:var(--dsw-alias-interactive-bg-hover)}
.ab-row-rail{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:2px}
.ab-row-line{flex:none;width:1px;background:var(--dsw-alias-border-l1);min-height:10px}
.ab-row:last-child .ab-row-line{display:none}
.ab-row-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.ab-row-head{box-sizing:border-box;margin:0;padding:0;border:none;background:transparent;cursor:pointer;display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;font:inherit;color:inherit}
.ab-row-head:hover .ab-row-tool{color:var(--dsw-alias-state-business-primary)}
.ab-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.ab-row-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ab-row-chev{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.ab-row-open .ab-row-chev{transform:rotate(180deg)}
.ab-row-reason{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.ab-row-open .ab-row-reason{display:none}
.ab-details{flex-direction:column;gap:10px;padding:8px 0 2px;display:flex}
.ab-detail-sec{display:flex;flex-direction:column;gap:6px}
.ab-detail-h{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;letter-spacing:.04em}
.ab-detail-grid{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 10px;align-items:start}
.ab-detail-k{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;padding-top:1px}
.ab-detail-v{margin:0;color:var(--dsw-alias-label-primary);font:12px/18px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all}
.ab-detail-v-box{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform));border-radius:8px;padding:6px 8px;max-height:180px;overflow:auto}
.ab-empty,.ab-loading{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ab-set{box-sizing:border-box;width:100%;max-width:720px;padding:0 0 28px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.ab-set-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.ab-set-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.ab-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.ab-set-fold{padding:0}
.ab-set-fold>summary{list-style:none;cursor:pointer;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px}
.ab-set-fold>summary::-webkit-details-marker{display:none}
.ab-set-fold>summary:hover{background:var(--dsw-alias-interactive-bg-hover);border-radius:12px}
.ab-set-fold[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:12px 12px 0 0}
.ab-set-fold-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px}
.ab-set-fold-sum{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:right;max-width:46%}
.ab-set-fold-chev{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.ab-set-fold[open]>summary .ab-set-fold-chev{transform:rotate(180deg)}
.ab-set-card-head{flex-direction:column;gap:4px;display:flex}
.ab-set-card-title{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;font-size:14px;font-weight:500;line-height:20px;display:flex}
.ab-set-card-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.ab-set-note{color:var(--dsw-alias-state-warn-label);margin:0;font-size:13px;line-height:20px}
.ab-set-ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:13px;line-height:20px}
.ab-set-err{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}
.ab-set-row{flex-wrap:wrap;gap:8px;display:flex;align-items:center}
.ab-set-row-choices{align-items:stretch;flex-wrap:nowrap}
.ab-set-input,.ab-set-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:32px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 10px;font-size:13px;line-height:20px;font-family:var(--ds-font-family-code)}
.ab-set-input:focus,.ab-set-select:focus{border-color:var(--dsw-alias-state-business-primary)}
.ab-set-input-num{width:96px}
.ab-set-input-grow{flex:1 1 180px}
.ab-set-btn{box-sizing:border-box;height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:16px;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex;white-space:nowrap}
.ab-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ab-set-btn:disabled{opacity:.4;cursor:default}
.ab-set-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.ab-set-btn-danger{color:var(--dsw-alias-label-primary-foreground);border:none;background:var(--dsw-alias-state-error-primary)}
.ab-set-list{flex-direction:column;gap:4px;display:flex}
.ab-set-item{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;align-items:center;gap:8px;padding:6px 10px;min-width:0;display:flex}
.ab-set-item-kw{padding:4px 8px}
.ab-set-kw-text{flex:1 1 auto;min-width:0;cursor:text;color:var(--dsw-alias-label-primary);font:12px/18px var(--ds-font-family-code);word-break:break-all}
.ab-set-textarea{box-sizing:border-box;width:100%;min-height:72px;resize:none;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/18px inherit;border-radius:8px;outline:none;padding:6px 10px}
.ab-set-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.ab-set-textarea-prompt{min-height:180px;max-height:360px;resize:vertical;overflow:auto;font-family:var(--ds-font-family-code);white-space:pre-wrap}
.ab-set-input-ui{font-family:inherit;width:100%}
.ab-set-foot{justify-content:flex-end}
.ab-set-list-crit{gap:8px}
.ab-set-item-crit{flex-direction:column;align-items:stretch;gap:8px;padding:10px 12px}
.ab-set-crit-top{display:flex;align-items:center;gap:8px;min-width:0}
.ab-set-item-fields{min-width:0;flex-direction:column;gap:6px;display:flex}
.ab-set-item-id{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;font-family:var(--ds-font-family-code)}
.ab-set-item-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.ab-set-item-del{flex:none;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:0}
.ab-set-item-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ab-set-empty{color:var(--dsw-alias-label-caption);margin:0;font-size:13px;line-height:20px;padding:4px 2px}
.ab-set-tag{box-sizing:border-box;flex:none;height:18px;border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex}
.ab-set-tag-blue{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ab-set-tag-warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.ab-set-steps{display:flex;flex-wrap:wrap;gap:6px}
.ab-set-step{box-sizing:border-box;margin:0;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:10px;padding:8px 10px;min-width:108px;flex:1 1 108px;cursor:pointer;display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;font:inherit;color:inherit}
.ab-set-step:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ab-set-step:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.ab-set-step-k{color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;font-size:11px;line-height:16px;display:flex}
.ab-set-step-v{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:18px;word-break:break-all}
.ab-set-invs{flex-wrap:wrap;gap:6px;display:flex}
.ab-set-inv{box-sizing:border-box;border-radius:8px;padding:6px 10px;font-size:12px;line-height:18px;display:inline-flex;align-items:center;max-width:100%}
.ab-set-inv-hard{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.ab-set-inv-ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.ab-set-inv-mode{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.ab-set-choice{box-sizing:border-box;margin:0;flex:1 1 0;min-width:0;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:10px;padding:10px 12px;cursor:pointer;text-align:left;font:inherit;color:inherit;display:flex;flex-direction:column;gap:4px}
.ab-set-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ab-set-choice-on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ab-set-choice-t{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.ab-set-choice-d{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ab-set-choice:disabled{opacity:.4;cursor:default}
.ab-set-flash{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1);padding:4px 0}
.ab-access-glyph{display:inline-flex;flex:none;align-items:center;color:inherit}
.ab-access-glyph svg{width:14px;height:14px}
/* 菜单行里的图标色必须跟 DSH 自己的 .itemIcon 一致（label-tertiary）：
   菜单按钮是 label-primary，注入的徽标会继承它，看起来比旁边三个图标更黑。
   触发器正好相反 —— .trigger 是 label-secondary、.triggerIcon 不设色，inherit 就对了。 */
[role="menuitem"] .ab-access-glyph{color:var(--dsw-alias-label-tertiary,currentColor)}
[role="menuitem"] .ab-access-glyph svg{width:16px;height:16px}
`

    const NS = "dsh-auto-approve"
    const ZH = JSON.parse(String.raw`{"slot.notice":"自动放行提示","slot.history":"审批","slot.settings":"自动审批","action.reject":"拒绝","action.allow":"允许","action.human":"人工","criterion.deletion":"删除/覆盖不可再生数据","criterion.credential":"凭据/密钥/授权修改","criterion.remote":"远程系统/生产环境/数据库","criterion.system":"系统级路径/配置","criterion.bulk":"批量不可回补操作","criterion.approval-config":"自动审批配置","criterion.safe":"安全/常规可回补","criterion.other":"其他（拿不准）","sandbox.read-only":"只读","sandbox.workspace-write":"工作区可写","sandbox.danger-full-access":"全权限","source.web":"网页","verdict.keyword-allow":"关键词允许","verdict.keyword-reject":"关键词拒绝","verdict.keyword-human":"关键词转人工","verdict.criteria-reject":"审核表拒绝","verdict.criteria-allow":"审核表允许","verdict.criteria-human":"审核表转人工","verdict.judge-failed":"判定失败转人工","verdict.missing-payload":"缺少工具参数转人工","verdict.truncated-payload":"参数过长转人工","verdict.plugin-error":"插件异常转人工","verdict.human":"转人工","verdict.cancelled":"人工取消","verdict.unavailable":"审批不可用","path.keyword-reject":"关键词拒绝","path.keyword-allow":"关键词允许","path.keyword-human":"关键词转人工","path.criteria-reject":"审核表拒绝","path.criteria-allow":"审核表允许","path.criteria-human":"审核表转人工","path.judge-failed":"判定失败转人工","path.missing-payload":"缺少工具参数转人工","path.truncated-payload":"参数过长转人工","path.plugin-error":"插件异常转人工","notice.feedError":"审批提示暂时不可用","notice.feedErrorTag":"连接失败","notice.pendingTitle":"等待人工审批：{preview}","notice.pendingTag":"人工审批中","notice.webApproved":"人工审批通过：{preview}","notice.webApprovedTag":"人工审批通过","notice.rejectedTitle":"已拒绝：{preview}","notice.rejectedTag":"已拒绝","notice.cancelledTitle":"已取消人工审批：{preview}","notice.unavailableTitle":"审批不可用：{preview}","notice.autoTag":"自动放行 · {verdict}","notice.autoDefault":"自动放行","notice.rejectedDefault":"已拒绝","notice.hint":"提示","notice.close":"关闭","notice.feedLoadFailed":"审批提示加载失败，将自动重试","history.noSession":"未选择会话","history.loadFailed":"加载失败：{error}","history.loading":"加载中…","history.title":"审批","history.emptySub":"当前会话还没有审批记录","history.emptyHint":"自动放行与转人工都会出现在这里","history.sub":"最新在上 · 点开看命令与详情","history.tagAuto":"自动放行","history.tagPending":"转人工","history.tagAllow":"人工批准","history.tagReject":"人工拒绝","history.tagCancel":"人工取消","history.tagUnavailable":"审批不可用","history.unknownTool":"工具","detail.request":"请求","detail.audit":"审核","detail.command":"命令","detail.path":"路径","detail.description":"描述","detail.old":"原文","detail.new":"改成","detail.content":"写入内容","detail.code":"代码","detail.url":"URL","detail.query":"查询","detail.script":"脚本","detail.sql":"SQL","detail.prompt":"提示词","detail.input":"输入","detail.text":"文本","detail.body":"正文","detail.message":"消息","detail.pattern":"模式","detail.selector":"选择器","detail.cwd":"工作目录","detail.workdir":"命令工作目录","detail.empty":"(空)","detail.sandbox":"沙箱","detail.justification":"模型理由","detail.pipe":"管道","detail.keyword":"关键词","detail.judgeModel":"审核模型","detail.judgeCategory":"审核类别","detail.judgeAction":"执行动作","detail.judgeReason":"审核理由","detail.judgeError":"审核失败","detail.judgeRaw":"审核结果原文","detail.source":"来源","detail.judgeFailed":"未完成（解析失败/超时转人工，不执行「其他」的动作）","set.title":"自动审批","set.intro":"需要审批的行为由审核模型自动判定。允许或拒绝与在网页点按钮相同；拿不准则交给原来的人工审批框。","set.allowlistCorrupt":"规则文件损坏，当前是内存默认，普通保存不会覆盖磁盘。请修好 allowlist.json，或点「恢复默认」写回出厂规则。","set.pluginCorrupt":"插件配置损坏，拒绝保存以免清空审核模型。请修好 ~/.dsh/auto-approve/config.json，或","set.pluginCorruptOverwrite":"覆盖损坏配置","set.loading":"加载中…","set.loadFailed":"加载失败：{error}","set.resetConfirm":"再点一次确认恢复","set.presetMissingTitle":"权限预设","set.driftTitle":"权限预设表需要更新","set.driftBody":"DSH 出厂权限预设表多了 {keys}。本 profile 的 permission 行由本插件写入，patch 会整块替换 config，所以不会自动出现这些预设；请更新插件或手工合并该行。","set.presetMissingSub":"插件启动时会写入 auto-approve。当前未检测到，可手动补写。","set.presetWrite":"写入权限预设","set.presetWriteNote":"写入后需重启 dsh web","set.presetWrote":"已写入，请重启 dsh web","set.modeTitle":"自动审批模式","set.modeWs":"工作区可写（推荐）","set.modeWsHint":"工作区内直接放行，越出工作区需审核。","set.modeRo":"只读","set.modeRoHint":"工作区内写操作也需审核。","set.modeHint":"点选即写入。改完需重启 dsh web，并重新选择「自动审批」或开新会话。","set.save":"保存","set.hotOk":"已生效（热更新，无需重启）","set.modeSaved":"已写入。请重启 dsh web，并重新选择「自动审批」或开新会话","set.overview":"审批总览","set.overviewSub":"关键词（拒绝优先于人工优先于允许）→ 审核表由模型归类，程序按表执行。解析失败转人工。","set.stepKeywords":"关键词","set.stepCriteria":"审核表","set.stepJudge":"审核模型","set.counts":"拒 {reject} · 人 {human} · 允 {allow}","set.criteriaCount":"{n} 项","set.followDefault":"跟随默认","set.unconfigured":"未配置","set.kwSub":"匹配命令、路径和工作目录。拒绝/人工词也匹配工具名；允许词不匹配工具名，避免把 bash/write 整类放行。","set.empty":"暂无","set.presetTag":"预置","set.kwEditTitle":"点击修改","set.kwPlaceholder":"新关键词","set.add":"添加","set.resetKeywords":"恢复默认关键词","set.resetKeywordsOk":"已恢复默认关键词","set.confirm":"确认","set.delete":"删除","set.criteriaSub":"审核模型以此表作为审核标准。「其他」作为兜底选项不能删除。","set.labelPlaceholder":"标签","set.descPlaceholder":"说明（写入审核提示词）","set.resetCriteria":"恢复默认审核表（{lang}）","set.resetCriteriaOk":"已恢复为{lang}默认审核表","set.addCriterion":"添加审核项","set.criterionId":"id","set.judgeTitle":"审核模型","set.judgeSubLead":"独立于当前会话模型。空则跟随部署默认","set.judgeSubFallback":"（{provider} / {model}）","set.judgeSubNoFallback":"（当前没有默认可跟随）","set.judgeSubTail":"。没有可用路由时当次转人工，不会再猜一个模型。建议思考强度 off。","set.followProvider":"跟随默认提供方","set.followModel":"跟随默认模型","set.modelDefaultEffort":"模型默认","set.effortOff":"off（建议）","set.judgeTimeoutMs":"审核超时(ms)：","set.judgeSaved":"审核设置已保存","set.judgeLang":"提示词语言","set.judgeLangZh":"中文","set.judgeLangEn":"English","set.judgeLangHint":"切换发给审核模型的框架语言与卡片标签，不会改当前审核表。下面的提示词按此语言编辑；恢复默认审核表也用这里选的语言。","set.judgePrompt":"审核提示词","set.judgePromptHint":"按所选语言内置默认提示词。用 {{criteria}} 插入当前审核表；删掉占位符时会把审核表附在末尾。与审核模型、超时一起保存。","set.judgePromptCustom":"已自定义","set.judgePromptDefault":"默认","set.resetJudgePrompt":"恢复默认提示词","set.resetJudgePromptOk":"已恢复默认提示词","set.overwriteOk":"已覆盖损坏的插件配置","err.missingPayload":"工具参数不完整，转人工","err.missingPayloadUncaptured":"未捕获工具参数，转人工","err.truncatedPayload":"工具参数过长已截断，转人工（禁止按前缀自动放行）","err.pluginError":"插件判定异常，转人工","err.allowlistCorrupt":"规则文件损坏，拒绝覆盖。请先「恢复默认」写回出厂规则，或修好磁盘上的 allowlist.json","err.allowlistWrite":"写入 allowlist 失败","err.criterionNotFound":"未找到该审核项","err.criterionNeedId":"需要 id 或 label","err.criterionIdExists":"id 已存在","err.criterionOtherLocked":"「其他」不可删除","err.criteriaOp":"审核表请用添加 / 修改 / 删除 / 恢复默认","err.opMustSet":"{kind} 只能用修改操作","err.invalidNumber":"无效数值","err.keywordEmpty":"关键词不能为空","err.keywordNotFound":"未找到该关键词","err.keywordsOp":"关键词请用添加 / 修改 / 删除 / 恢复默认","err.valueEmpty":"值不能为空","err.unknownKind":"未知规则类型：{kind}","err.unknownOp":"未知操作：{op}","err.ruleNotFound":"未找到匹配的规则","err.badBody":"请求体不是 JSON","err.needSessionId":"需要 sessionId","err.pluginCorrupt":"插件配置损坏，拒绝覆盖。请修好磁盘文件，或点「覆盖损坏配置」","err.pluginWrite":"写入配置失败","err.unknownEndpoint":"未知接口：{endpoint}","err.internal":"内部错误：{error}","err.catalog":"无法列出模型：{error}","err.info":"无法读取模型信息：{error}","err.judgeUnconfigured":"未配置审核模型","err.judgeEffort":"思考强度 {effort} 不受支持","err.judgeTimeout":"审核超时（{ms}ms）","err.judgeRetryTimeout":"审核重试超时（{ms}ms）","err.judgeFailed":"审核失败","err.judgeCall":"审核模型调用失败：{error}","err.judgeEmpty":"审核模型输出为空","err.judgeParse":"审核模型输出无法解析","err.judgeUpstream":"审核模型路由失败：{error}","err.noPresetsKey":"permission 条目缺少 presets 键，请手动添加","err.preset":"写入预设失败：{error}","err.presetSandboxMissing":"预设里没有 sandbox 行，无法写入沙箱模式；请检查 profile 的 cordis.patch.yml","rpc.unavailable":"connection.rpc 不可用","rpc.failed":"RPC 失败"}`)
    const EN = JSON.parse(String.raw`{"slot.notice":"Auto-approve notice","slot.history":"Approvals","slot.settings":"Auto-approve","action.reject":"Reject","action.allow":"Allow","action.human":"Human","criterion.deletion":"Delete/overwrite irreplaceable data","criterion.credential":"Credentials/keys/auth changes","criterion.remote":"Remote/production/database","criterion.system":"System paths/config","criterion.bulk":"Bulk irreversible operations","criterion.approval-config":"Auto-approve configuration","criterion.safe":"Safe/routine reversible","criterion.other":"Other (unsure)","sandbox.read-only":"Read-only","sandbox.workspace-write":"Workspace write","sandbox.danger-full-access":"Full access","source.web":"Web","verdict.keyword-allow":"Keyword allow","verdict.keyword-reject":"Keyword reject","verdict.keyword-human":"Keyword → human","verdict.criteria-reject":"Criteria reject","verdict.criteria-allow":"Criteria allow","verdict.criteria-human":"Criteria → human","verdict.judge-failed":"Judge failed → human","verdict.missing-payload":"Missing tool args → human","verdict.truncated-payload":"Truncated args → human","verdict.plugin-error":"Plugin error → human","verdict.human":"To human","verdict.cancelled":"Human cancel","verdict.unavailable":"Unavailable","path.keyword-reject":"Keyword reject","path.keyword-allow":"Keyword allow","path.keyword-human":"Keyword → human","path.criteria-reject":"Criteria reject","path.criteria-allow":"Criteria allow","path.criteria-human":"Criteria → human","path.judge-failed":"Judge failed → human","path.missing-payload":"Missing tool args → human","path.truncated-payload":"Truncated args → human","path.plugin-error":"Plugin error → human","notice.feedError":"Approval notices unavailable","notice.feedErrorTag":"Connection failed","notice.pendingTitle":"Waiting for human: {preview}","notice.pendingTag":"Human review","notice.webApproved":"Approved: {preview}","notice.webApprovedTag":"Approved","notice.rejectedTitle":"Rejected: {preview}","notice.rejectedTag":"Rejected","notice.cancelledTitle":"Cancelled: {preview}","notice.unavailableTitle":"Unavailable: {preview}","notice.autoTag":"Auto-allowed · {verdict}","notice.autoDefault":"Auto-allowed","notice.rejectedDefault":"Rejected","notice.hint":"Notice","notice.close":"Dismiss","notice.feedLoadFailed":"Approval notices failed to load; retrying","history.noSession":"No session selected","history.loadFailed":"Failed to load: {error}","history.loading":"Loading…","history.title":"Approvals","history.emptySub":"This session has no approval records yet","history.emptyHint":"Auto-allows and human escalations appear here","history.sub":"Newest first · expand for command and details","history.tagAuto":"Auto-allowed","history.tagPending":"To human","history.tagAllow":"Human allow","history.tagReject":"Human reject","history.tagCancel":"Human cancel","history.tagUnavailable":"Unavailable","history.unknownTool":"Tool","detail.request":"Request","detail.audit":"Review","detail.command":"Command","detail.path":"Path","detail.description":"Description","detail.old":"Original","detail.new":"Replacement","detail.content":"Write contents","detail.code":"Code","detail.url":"URL","detail.query":"Query","detail.script":"Script","detail.sql":"SQL","detail.prompt":"Prompt","detail.input":"Input","detail.text":"Text","detail.body":"Body","detail.message":"Message","detail.pattern":"Pattern","detail.selector":"Selector","detail.cwd":"Working directory","detail.workdir":"Command working directory","detail.empty":"(empty)","detail.sandbox":"Sandbox","detail.justification":"Model justification","detail.pipe":"Pipeline","detail.keyword":"Keyword","detail.judgeModel":"Judge model","detail.judgeCategory":"Category","detail.judgeAction":"Action","detail.judgeReason":"Judge reason","detail.judgeError":"Judge error","detail.judgeRaw":"Judge raw output","detail.source":"Source","detail.judgeFailed":"Incomplete (parse failure/timeout → human; does not run Other)","set.title":"Auto-approve","set.intro":"Actions that need approval are judged automatically. Allow and reject match clicking the Web buttons; uncertainty goes to the original human dialog.","set.allowlistCorrupt":"The rules file is corrupt. This process is using in-memory defaults and will not overwrite the disk. Repair allowlist.json, or Restore defaults to write shipped rules.","set.pluginCorrupt":"Plugin config is corrupt; saves are refused so the judge model is not wiped. Repair ~/.dsh/auto-approve/config.json, or ","set.pluginCorruptOverwrite":"Overwrite corrupt config","set.loading":"Loading…","set.loadFailed":"Failed to load: {error}","set.resetConfirm":"Click again to confirm restore","set.presetMissingTitle":"Permission preset","set.driftTitle":"Permission preset table needs updating","set.driftBody":"The shipped permission table has new presets: {keys}. This profile's permission row is written by this plugin, and a patch replaces that config wholesale, so they will not appear automatically. Update the plugin or merge that row by hand.","set.presetMissingSub":"Startup writes auto-approve. It was not detected; you can write it now.","set.presetWrite":"Write permission preset","set.presetWriteNote":"Restart dsh web after writing","set.presetWrote":"Written. Restart dsh web","set.modeTitle":"Auto-approve mode","set.modeWs":"Workspace write (recommended)","set.modeWsHint":"In-workspace writes skip approval; outside the workspace still goes through the judge.","set.modeRo":"Read-only","set.modeRoHint":"In-workspace writes also go through the judge.","set.modeHint":"Clicking a mode writes it. Then restart dsh web and re-select Auto-approve or start a new session.","set.save":"Save","set.hotOk":"Applied (live; no restart)","set.modeSaved":"Written. Restart dsh web and re-select Auto-approve or start a new session","set.overview":"Approval overview","set.overviewSub":"Keywords (reject > human > allow) → the judge classifies; the table decides. Parse failure → human.","set.stepKeywords":"Keywords","set.stepCriteria":"Criteria","set.stepJudge":"Judge model","set.counts":"rej {reject} · hum {human} · all {allow}","set.criteriaCount":"{n} rows","set.followDefault":"Follow default","set.unconfigured":"Not configured","set.kwSub":"Match command, path, and workdir. Reject/human also match the tool name; allow keywords do not, so bash/write is not allowed as a class.","set.empty":"None","set.presetTag":"Shipped","set.kwEditTitle":"Click to edit","set.kwPlaceholder":"New keyword","set.add":"Add","set.resetKeywords":"Restore default keywords","set.resetKeywordsOk":"Default keywords restored","set.confirm":"Confirm","set.delete":"Delete","set.criteriaSub":"The judge uses this table. Other cannot be deleted.","set.labelPlaceholder":"Label","set.descPlaceholder":"Description (goes into the judge prompt)","set.resetCriteria":"Restore default criteria ({lang})","set.resetCriteriaOk":"Restored {lang} default criteria","set.addCriterion":"Add criterion","set.criterionId":"id","set.judgeTitle":"Judge model","set.judgeSubLead":"Independent of the session model. Empty follows the deployment default","set.judgeSubFallback":" ({provider} / {model})","set.judgeSubNoFallback":" (no default to follow)","set.judgeSubTail":". With no usable route, that request goes to a human; the plugin will not guess a model. Prefer effort off.","set.followProvider":"Follow default provider","set.followModel":"Follow default model","set.modelDefaultEffort":"Model default","set.effortOff":"off (recommended)","set.judgeTimeoutMs":"Judge timeout (ms):","set.judgeSaved":"Judge settings saved","set.judgeLang":"Prompt language","set.judgeLangZh":"Chinese","set.judgeLangEn":"English","set.judgeLangHint":"Switches the judge prompt framework and card labels, not the current criteria table. The prompt below is edited per language; restore default criteria also uses this language.","set.judgePrompt":"Judge prompt","set.judgePromptHint":"Built-in default for the selected language. Use {{criteria}} to insert the current criteria table; if the placeholder is removed, the table is appended. Saved with the judge model and timeout.","set.judgePromptCustom":"Custom","set.judgePromptDefault":"Default","set.resetJudgePrompt":"Restore default prompt","set.resetJudgePromptOk":"Default prompt restored","set.overwriteOk":"Corrupt plugin config overwritten","err.missingPayload":"Tool arguments are incomplete; sending to human","err.missingPayloadUncaptured":"Tool arguments were not captured; sending to human","err.truncatedPayload":"Tool arguments were truncated; sending to human (no prefix auto-allow)","err.pluginError":"Plugin error; sending to human","err.allowlistCorrupt":"Rules file is corrupt; refusing to overwrite. Restore defaults or fix allowlist.json on disk.","err.allowlistWrite":"Failed to write allowlist","err.criterionNotFound":"Criterion not found","err.criterionNeedId":"id or label is required","err.criterionIdExists":"id already exists","err.criterionOtherLocked":"“Other” cannot be deleted","err.criteriaOp":"Criteria accept add / set / remove / reset","err.opMustSet":"{kind} only accepts set","err.invalidNumber":"Invalid number","err.keywordEmpty":"Keyword cannot be empty","err.keywordNotFound":"Keyword not found","err.keywordsOp":"Keywords accept add / set / remove / reset","err.valueEmpty":"Value cannot be empty","err.unknownKind":"Unknown rule kind: {kind}","err.unknownOp":"Unknown operation: {op}","err.ruleNotFound":"No matching rule","err.badBody":"Request body is not JSON","err.needSessionId":"sessionId is required","err.pluginCorrupt":"Plugin config is corrupt; refusing to overwrite. Fix the file on disk, or overwrite the corrupt config.","err.pluginWrite":"Failed to write plugin config","err.unknownEndpoint":"Unknown endpoint: {endpoint}","err.internal":"Internal error: {error}","err.catalog":"Could not list models: {error}","err.info":"Could not load model info: {error}","err.judgeUnconfigured":"Judge model is not configured","err.judgeEffort":"reasoningEffort {effort} is not supported","err.judgeTimeout":"Judge timed out ({ms}ms)","err.judgeRetryTimeout":"Judge retry timed out ({ms}ms)","err.judgeFailed":"Judge failed","err.judgeCall":"Judge call failed: {error}","err.judgeEmpty":"Judge output was empty","err.judgeParse":"Judge output could not be parsed","err.judgeUpstream":"Judge route failed: {error}","err.noPresetsKey":"The permission entry has no presets key; add it manually","err.preset":"Failed to write preset: {error}","err.presetSandboxMissing":"The preset has no sandbox line; cannot set the sandbox mode. Check the profile cordis.patch.yml","rpc.unavailable":"connection.rpc is unavailable","rpc.failed":"RPC failed"}`)

    function fillLocale(template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
      })
    }

    function tFrom(props) {
      if (props && typeof props.t === 'function') return props.t
      const sp = (props && props.slotsProps) || {}
      if (typeof sp.t === 'function') return sp.t
      return function (key, params) {
        return fillLocale(ZH[key] || key, params)
      }
    }

    function lookupLabel(t, prefix, id) {
      if (!id) return ''
      const key = prefix + '.' + id
      const v = t(key)
      return v === key ? '' : v
    }

    function verdictLabel(t, verdict) {
      if (!verdict) return t('notice.autoDefault')
      return lookupLabel(t, 'verdict', verdict) || lookupLabel(t, 'path', verdict) || String(verdict)
    }

    function pathLabel(t, path) {
      return lookupLabel(t, 'path', path) || lookupLabel(t, 'verdict', path) || (path ? String(path) : '')
    }

    function actionLabel(t, action) {
      return lookupLabel(t, 'action', action) || (action ? String(action) : '')
    }

    function criterionLabel(t, criterion, storedLabel) {
      return lookupLabel(t, 'criterion', criterion) || storedLabel || (criterion ? String(criterion) : '')
    }

    function sandboxLabel(t, mode) {
      return lookupLabel(t, 'sandbox', mode) || (mode ? String(mode) : '')
    }

    function sourceLabel(t, source) {
      return lookupLabel(t, 'source', source) || (source ? String(source) : '')
    }


    function countsLabel(t, reject, human, allow) {
      return t('set.counts', { reject: String(reject), human: String(human), allow: String(allow) })
    }

    function isAutoReject(verdict) {
      const v = String(verdict || '')
      return v === 'keyword-reject' || v === 'criteria-reject' || /-reject$/.test(v)
    }

    function eventPreview(ev) {
      const a = (ev && ev.args) || {}
      return a.command || a.file_path || a.path || a.code || a.url || a.script || a.sql || a.prompt || a.description || ev.justification || ev.reason || ''
    }

    function hasVal(value) {
      return value !== undefined && value !== null
    }

    function isLongVal(value) {
      const s = String(value)
      return s.length > 72 || s.indexOf('\n') !== -1
    }

    function Detail(label, value, emptyText) {
      if (!hasVal(value)) return null
      if (value === '' && !emptyText) return null
      const shown = value === '' ? emptyText : String(value)
      const long = isLongVal(shown)
      return [
        React.createElement('div', { className: 'ab-detail-k', key: label + '-k' }, label),
        React.createElement(long ? 'pre' : 'div', {
          className: 'ab-detail-v' + (long ? ' ab-detail-v-box' : ''),
          key: label + '-v',
        }, shown),
      ]
    }

    function DetailSection(title, items, emptyText) {
      const kids = []
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        if (!row) continue
        const node = Detail(row[0], row[1], emptyText)
        if (node) kids.push(node[0], node[1])
      }
      if (!kids.length) return null
      return React.createElement('div', { className: 'ab-detail-sec' },
        React.createElement('div', { className: 'ab-detail-h' }, title),
        React.createElement('div', { className: 'ab-detail-grid' }, kids),
      )
    }

    function sizeTextarea(el) {
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.max(72, el.scrollHeight) + 'px'
    }

    function fmtTime(iso) {
      if (!iso) return ''
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return ''
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      } catch (e) { return '' }
    }

    function GlyphCheck() {
      return React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        React.createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--dsw-alias-state-success-tertiary)' }),
        React.createElement('path', { d: 'M5 8.3L7.1 10.4L11 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function resolveFrame(sp) {
      if (!sp) return { sessionId: null }
      if (sp.sessionId) return { sessionId: sp.sessionId }
      if (sp.session && sp.session.id) return { sessionId: sp.session.id }
      return { sessionId: null }
    }

    function latestUnsettledPending(evs) {
      for (let i = evs.length - 1; i >= 0; i--) {
        const kind = evs[i].kind || ''
        if (kind === 'manual-approved' || kind === 'manual-rejected' || kind === 'manual-cancelled' || kind === 'manual-unavailable') return null
        if (kind === 'manual-pending') return evs[i]
      }
      return null
    }


    function formatErr(t, code, details) {
      if (!code) return ''
      const d = details && typeof details === 'object' ? details : {}
      const raw = String(code)
      const key = raw.indexOf('err.') === 0 || raw.indexOf('rpc.') === 0 ? raw : 'err.' + raw
      const v = t(key, d)
      if (v && v !== key) return v
      if (raw.indexOf('err.') !== 0 && raw.indexOf('rpc.') !== 0) {
        const direct = t(raw, d)
        if (direct && direct !== raw) return direct
      }
      if (d.error) return String(d.error)
      return raw
    }

    function codedText(t, text, details) {
      if (!text) return ''
      const s = String(text)
      if (s.indexOf('err.') === 0 || s.indexOf('rpc.') === 0) return formatErr(t, s, details || {}) || s
      return s
    }

    function makeRpc(connection, t) {
      const tr = typeof t === 'function' ? t : function (key) { return ZH[key] || key }
      return function rpc(endpoint, payload) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error(tr('rpc.unavailable')))
        }
        return connection.rpc.call('/api', 'dsh-auto-approve', {
          endpoint: endpoint,
          payload: payload || {},
        }).then(function (r) {
          if (!r || r.ok === false) {
            const err = r && r.error
            throw new Error(formatErr(tr, err && err.code, err && (err.details || {})) || (err && err.message) || tr('rpc.failed'))
          }
          return r.value
        })
      }
    }

    /** 输入框上方的自动放行 / 拒绝 / 等待人工条。 */
    function NoticeStrip(props) {
      const t = tFrom(props)
      const rpc = props.rpc
      const frame = resolveFrame(props.slotsProps || {})
      const sessionId = frame.sessionId
      const [notice, setNotice] = React.useState(null)
      const sinceRef = React.useRef(0)
      const lastShownIdRef = React.useRef(0)
      const hideTimerRef = React.useRef(null)

      React.useEffect(function () {
        let alive = true
        let timer = null
        sinceRef.current = 0
        lastShownIdRef.current = 0
        setNotice(null)
        if (!sessionId || !rpc) return

        const startPolling = function () {
          if (!alive) return
          timer = setInterval(function () {
            rpc('events', { sessionId: sessionId, since: sinceRef.current }).then(function (data) {
              if (!alive) return
              const evs = (data && data.events) || []
              if (evs.length === 0) return
              const last = evs[evs.length - 1]
              if (!last || last.id <= lastShownIdRef.current) return
              lastShownIdRef.current = last.id
              sinceRef.current = last.id
              const kind = last.kind || 'auto'
              setNotice(last)
              if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
              if (kind !== 'manual-pending') {
                const hold = kind === 'auto' ? 8000 : 4000
                hideTimerRef.current = setTimeout(function () { setNotice(null) }, hold)
              }
            }).catch(function () {
              if (!alive) return
              setNotice(function (cur) {
                if (cur && cur.kind && cur.kind !== 'feed-error') return cur
                return { kind: 'feed-error', code: 'notice.feedError' }
              })
            })
          }, 2000)
        }

        rpc('events', { sessionId: sessionId, since: 0 }).then(function (data) {
          if (!alive) return
          const evs = (data && data.events) || []
          if (evs.length > 0) {
            const last = evs[evs.length - 1]
            sinceRef.current = last.id
            lastShownIdRef.current = last.id
            const pending = latestUnsettledPending(evs)
            if (pending) setNotice(pending)
          }
          startPolling()
        }).catch(function () {
          if (!alive) return
          setNotice({ kind: 'feed-error', code: 'notice.feedLoadFailed' })
          startPolling()
        })

        return function () {
          alive = false
          if (timer) clearInterval(timer)
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        }
      }, [sessionId, rpc])

      if (!notice) return null
      const kind = notice.kind || 'auto'
      const isPending = kind === 'manual-pending'
      const isManual = kind === 'manual-approved' || kind === 'manual-rejected' || kind === 'manual-cancelled' || kind === 'manual-unavailable'
      let title = ''
      let tagText = ''
      let glyph = null
      if (kind === 'feed-error') {
        title = t(notice.code || 'notice.feedError')
        tagText = t('notice.feedErrorTag')
        glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '!')
      } else if (isPending) {
        title = t('notice.pendingTitle', { preview: eventPreview(notice) })
        tagText = t('notice.pendingTag')
        glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '◔')
      } else if (kind === 'manual-approved') {
        title = t('notice.webApproved', { preview: eventPreview(notice) })
        tagText = t('notice.webApprovedTag')
        glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '✓')
      } else if (kind === 'manual-cancelled') {
        title = t('notice.cancelledTitle', { preview: eventPreview(notice) })
        tagText = t('history.tagCancel')
        glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '✕')
      } else if (kind === 'manual-unavailable') {
        title = t('notice.unavailableTitle', { preview: eventPreview(notice) })
        tagText = t('history.tagUnavailable')
        glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '!')
      } else if (kind === 'manual-rejected' || isAutoReject(notice.verdict)) {
        title = t('notice.rejectedTitle', { preview: eventPreview(notice) })
        tagText = kind === 'manual-rejected'
          ? t('notice.rejectedTag')
          : (verdictLabel(t, notice.verdict) || t('notice.rejectedDefault'))
        glyph = React.createElement('span', { className: 'ab-notice-glyph-err' }, '✕')
      } else {
        title = eventPreview(notice)
        tagText = t('notice.autoTag', { verdict: verdictLabel(t, notice.verdict) || notice.verdict || t('notice.autoDefault') })
        glyph = React.createElement(GlyphCheck, null)
      }
      const autoReject = isAutoReject(notice.verdict)
      const isFeedErr = kind === 'feed-error'
      const cardCls = 'ab-notice-card' + (isPending ? ' ab-notice-card-pending' : isManual ? ' ab-notice-card-manual' : (autoReject || isFeedErr) ? ' ab-notice-card-err' : '')
      return React.createElement('div', { className: 'ab-notice' },
        React.createElement('div', { className: cardCls },
          React.createElement('span', { className: 'ab-notice-glyph' }, glyph),
          React.createElement('div', { className: 'ab-notice-body' },
            React.createElement('div', { className: 'ab-notice-head' },
              React.createElement('span', { className: 'ab-notice-tool' }, notice.tool || (kind === 'feed-error' ? t('notice.hint') : t('history.unknownTool'))),
              React.createElement('span', { className: 'ab-notice-text' }, title),
            ),
            React.createElement('div', { className: 'ab-notice-meta' },
              React.createElement('span', { className: isPending || kind === 'manual-approved' || kind === 'manual-cancelled' || kind === 'manual-unavailable' ? 'ab-tag-warn' : (kind === 'manual-rejected' || isAutoReject(notice.verdict) || kind === 'feed-error') ? 'ab-tag-err' : 'ab-tag' }, tagText),
              React.createElement('span', { className: 'ab-time' }, fmtTime(notice.ts)),
            ),
          ),
          React.createElement('button', {
            type: 'button', className: 'ab-notice-close', title: t('notice.close'), 'aria-label': t('notice.close'),
            onClick: function () { setNotice(null) },
          }, '✕'),
        ),
      )
    }

    /** 会话「审批」tab。行头可点，详情分组，方便选中文字。 */
    function HistoryView(props) {
      const t = tFrom(props)
      const rpc = props.rpc
      const sessionId = (props && props.sessionId) || resolveFrame(props.slotsProps || props).sessionId || null
      const [events, setEvents] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)

      React.useEffect(function () {
        let alive = true
        let timer = null
        setEvents(null)
        setError(null)
        setOpenId(null)
        if (!sessionId || !rpc) return
        const load = function () {
          rpc('events', { sessionId: sessionId, since: 0 }).then(function (data) {
            if (!alive) return
            const list = ((data && data.events) || []).slice().reverse()
            setEvents(list)
            setError(null)
          }).catch(function (e) {
            if (!alive) return
            setError(String((e && e.message) || e))
          })
        }
        load()
        timer = setInterval(load, 3000)
        return function () { alive = false; if (timer) clearInterval(timer) }
      }, [sessionId, rpc])

      if (!sessionId) return React.createElement('div', { className: 'ab-empty' }, t('history.noSession'))
      if (error) return React.createElement('div', { className: 'ab-empty' }, t('history.loadFailed', { error: error }))
      if (!events) return React.createElement('div', { className: 'ab-loading' }, t('history.loading'))
      if (events.length === 0) return React.createElement('div', { className: 'ab-view' },
        React.createElement('div', { className: 'ab-view-head' },
          React.createElement('div', { className: 'ab-view-title' }, t('history.title')),
          React.createElement('div', { className: 'ab-view-sub' }, t('history.emptySub')),
        ),
        React.createElement('div', { className: 'ab-empty' }, t('history.emptyHint')),
      )

      return React.createElement('div', { className: 'ab-view' },
        React.createElement('div', { className: 'ab-view-head' },
          React.createElement('div', { className: 'ab-view-title' }, t('history.title')),
          React.createElement('div', { className: 'ab-view-sub' }, t('history.sub')),
        ),
        React.createElement('div', { className: 'ab-list' },
          events.map(function (ev) {
            const kind = ev.kind || 'auto'
            let glyph = React.createElement(GlyphCheck, null)
            let tag = t('history.tagAuto')
            let tagCls = 'ab-tag'
            if (kind === 'manual-pending') {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '◔')
              tag = t('history.tagPending')
              tagCls = 'ab-tag-warn'
            } else if (kind === 'manual-approved') {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '✓')
              tag = t('history.tagAllow')
              tagCls = 'ab-tag-warn'
            } else if (kind === 'manual-rejected') {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-err' }, '✕')
              tag = t('history.tagReject')
              tagCls = 'ab-tag-err'
            } else if (kind === 'manual-cancelled') {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '✕')
              tag = t('history.tagCancel')
              tagCls = 'ab-tag-warn'
            } else if (kind === 'manual-unavailable') {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-warn' }, '!')
              tag = t('history.tagUnavailable')
              tagCls = 'ab-tag-warn'
            } else if (isAutoReject(ev.verdict)) {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-err' }, '✕')
              tag = verdictLabel(t, ev.verdict) || t('notice.rejectedDefault')
              tagCls = 'ab-tag-err'
            } else {
              tag = verdictLabel(t, ev.verdict) || t('history.tagAuto')
            }
            const open = openId === ev.id
            const args = ev.args || {}
            const j = ev.judge || {}
            return React.createElement('div', {
              className: 'ab-row' + (open ? ' ab-row-open' : ''),
              key: ev.id,
            },
              React.createElement('div', { className: 'ab-row-rail' },
                glyph,
                React.createElement('div', { className: 'ab-row-line' }),
              ),
              React.createElement('div', { className: 'ab-row-body' },
                React.createElement('button', {
                  type: 'button',
                  className: 'ab-row-head',
                  onClick: function () { setOpenId(open ? null : ev.id) },
                },
                  React.createElement('div', { className: 'ab-row-top' },
                    React.createElement('span', { className: 'ab-row-tool' }, ev.tool || t('history.unknownTool')),
                    React.createElement('span', { className: tagCls }, tag),
                    React.createElement('span', { className: 'ab-time' }, fmtTime(ev.ts)),
                    React.createElement('span', { className: 'ab-row-chev' }, '▾'),
                  ),
                  React.createElement('div', { className: 'ab-row-reason' }, eventPreview(ev)),
                ),
                open
                  ? React.createElement('div', { className: 'ab-details' },
                      DetailSection(t('detail.request'), [
                        [t('detail.command'), args.command],
                        [t('detail.path'), args.file_path != null ? args.file_path : args.path],
                        [t('detail.description'), args.description],
                        [t('detail.old'), args.old_string],
                        [t('detail.new'), args.new_string],
                        [t('detail.content'), args.content],
                        [t('detail.code'), args.code],
                        [t('detail.url'), args.url],
                        [t('detail.query'), args.query],
                        [t('detail.script'), args.script],
                        [t('detail.sql'), args.sql],
                        [t('detail.prompt'), args.prompt],
                        [t('detail.input'), args.input],
                        [t('detail.text'), args.text],
                        [t('detail.body'), args.body],
                        [t('detail.message'), args.message],
                        [t('detail.pattern'), args.pattern],
                        [t('detail.selector'), args.selector],
                        [t('detail.cwd'), ev.cwd],
                        [t('detail.workdir'), args.workdir && args.workdir !== ev.cwd ? args.workdir : undefined],
                        [t('detail.sandbox'), sandboxLabel(t, ev.mode)],
                        [t('detail.justification'), ev.justification || ev.reason],
                      ], t('detail.empty')),
                      DetailSection(t('detail.audit'), [
                        [t('detail.pipe'), pathLabel(t, ev.path) || ev.path],
                        [t('detail.keyword'), ev.keyword],
                        [t('detail.judgeModel'), [j.provider, j.model, j.effort].filter(Boolean).join(' / ')],
                        [t('detail.judgeCategory'), j.failed
                          ? t('detail.judgeFailed')
                          : criterionLabel(t, j.criterion || ev.category, j.label)],
                        [t('detail.judgeAction'), actionLabel(t, j.action) || j.action],
                        [t('detail.judgeReason'), codedText(t, j.reason || ev.judgeReason)],
                        [t('detail.judgeError'), formatErr(t, j.errorCode || j.error, { ms: j.errorMs || '', error: j.errorDetail || '', effort: j.errorEffort || '' })],
                        [t('detail.judgeRaw'), j.raw],
                        [t('detail.source'), sourceLabel(t, ev.source)],
                      ]),
                    )
                  : null,
              ),
            )
          }),
        ),
      )
    }

    /** 设置 → 自动审批。恢复默认需连点两次。 */
    function SettingsPage(props) {
      const t = tFrom(props)
      const rpc = props.rpc
      const rootRef = React.useRef(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [feedback, setFeedback] = React.useState(null)
      const [newKeyword, setNewKeyword] = React.useState('')
      const [newKeywordAction, setNewKeywordAction] = React.useState('human')
      const [newCriterion, setNewCriterion] = React.useState({ id: '', label: '', description: '', action: 'human' })
      const [timeoutMs, setTimeoutMs] = React.useState('20000')
      const [models, setModels] = React.useState([])
      const [efforts, setEfforts] = React.useState([])
      const [judgeProvider, setJudgeProvider] = React.useState('')
      const [judgeModel, setJudgeModel] = React.useState('')
      const [judgeEffort, setJudgeEffort] = React.useState('')
      const [judgePromptLang, setJudgePromptLang] = React.useState('zh')
      const [judgePromptDrafts, setJudgePromptDrafts] = React.useState({ zh: '', en: '' })
      const [presetSandbox, setPresetSandbox] = React.useState('workspace-write')
      const [foldOpen, setFoldOpen] = React.useState({ keywords: false, criteria: false })
      const [kwEdit, setKwEdit] = React.useState(null)
      const [resetArmed, setResetArmed] = React.useState(null)
      const feedbackTimerRef = React.useRef(null)
      const kwSkipBlurRef = React.useRef(false)
      React.useEffect(function () {
        return function () {
          if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
        }
      }, [])
      const load = function (opts) {
        const keepEdits = opts && opts.keepEdits
        rpc('snapshot').then(function (data) {
          setSnapshot(data)
          if (!keepEdits) {
            setTimeoutMs(String(data.config.judgeTimeoutMs))
            setJudgeProvider((data.plugin.judge && data.plugin.judge.provider) || '')
            setJudgeModel((data.plugin.judge && data.plugin.judge.model) || '')
            setJudgeEffort((data.plugin.judge && data.plugin.judge.reasoningEffort) || '')
            setJudgePromptLang((data.plugin && data.plugin.judgePromptLang) === 'en' ? 'en' : 'zh')
            setJudgePromptDrafts((function () {
              const shipped = (data.predefined && data.predefined.judgePrompts) || {}
              const custom = (data.plugin && data.plugin.judgePrompts) || {}
              const pick = function (lang) {
                const c = custom[lang]
                if (c && String(c).trim()) return String(c)
                return String(shipped[lang] || '')
              }
              return { zh: pick('zh'), en: pick('en') }
            })())
            setPresetSandbox((data.plugin && data.plugin.presetSandbox) === 'read-only' ? 'read-only' : 'workspace-write')
          }
          setError(null)
        }).catch(function (e) {
          setError(t('set.loadFailed', { error: String((e && e.message) || e) }))
        })
      }
      React.useEffect(function () { load() }, [])
      React.useEffect(function () {
        if (!resetArmed) return
        const disarm = setTimeout(function () { setResetArmed(null) }, 5000)
        return function () { clearTimeout(disarm) }
      }, [resetArmed])

      React.useEffect(function () {
        const provider = judgeProvider || (snapshot && snapshot.fallback && snapshot.fallback.provider)
        if (!provider || !rpc) return
        let alive = true
        rpc('judge-catalog', { provider: provider }).then(function (data) {
          if (!alive) return
          setModels(data.models || [])
        }).catch(function () { if (alive) setModels([]) })
        return function () { alive = false }
      }, [judgeProvider, snapshot, rpc])

      React.useEffect(function () {
        const provider = judgeProvider || (snapshot && snapshot.fallback && snapshot.fallback.provider)
        const model = judgeModel || (snapshot && snapshot.fallback && snapshot.fallback.model)
        if (!provider || !model || !rpc) { setEfforts([]); return }
        let alive = true
        rpc('judge-info', { provider: provider, model: model }).then(function (data) {
          if (!alive) return
          setEfforts(data.efforts || [])
        }).catch(function () { if (alive) setEfforts([]) })
        return function () { alive = false }
      }, [judgeProvider, judgeModel, snapshot, rpc])

      const showFeedback = function (msg, ok) {
        setFeedback({ msg: String(msg), ok: ok !== false })
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
        feedbackTimerRef.current = setTimeout(function () { setFeedback(null) }, 4000)
      }

      const run = function (endpoint, payload, okMsg, opts) {
        setBusy(true)
        return rpc(endpoint, payload).then(function (res) {
          load({ keepEdits: !(opts && opts.reload) })
          showFeedback(okMsg || t('set.hotOk'))
          return res
        }).catch(function (e) {
          showFeedback(String((e && e.message) || e), false)
        }).finally(function () { setBusy(false) })
      }

      if (!snapshot) {
        return React.createElement('div', { className: 'ab-set' },
          React.createElement('div', { className: error ? 'ab-set-err' : 'ab-set-ok' }, error || t('set.loading')))
      }

      const cfg = snapshot.config
      const setup = snapshot.setup || { configured: false }
      const predefined = snapshot.predefined || {}
      const preDeny = new Set(predefined.rejectKeywords || predefined.denyKeywords || [])
      const plugin = snapshot.plugin || {}
      const providers = snapshot.providers || []
      const fallback = snapshot.fallback || {}
      const judgeTimeoutLabel = Math.round((Number(cfg.judgeTimeoutMs) || 20000) / 1000) + 's'
      const judgeRoute = (judgeProvider && judgeModel)
        ? (judgeProvider + ' / ' + judgeModel)
        : (fallback.provider && fallback.model ? t('set.followDefault') : t('set.unconfigured'))
      const scrollToStage = function (id) {
        try {
          const root = rootRef.current
          const el = root && root.querySelector('[data-ab-stage="' + id + '"]')
          if (!el) return
          if (el.tagName === 'DETAILS') {
            setFoldOpen(function (prev) {
              const next = Object.assign({}, prev)
              next[id] = true
              return next
            })
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } catch (e) {}
      }

      const resetBtn = function (kind, idleLabel, okMsg, value) {
        const armed = resetArmed === kind
        return React.createElement('button', {
          type: 'button',
          className: 'ab-set-btn' + (armed ? ' ab-set-btn-danger' : ''),
          disabled: busy,
          onClick: function () {
            if (resetArmed !== kind) {
              setResetArmed(kind)
              return
            }
            setResetArmed(null)
            if (kind === 'judgePrompt') {
              const lang = judgePromptLang === 'en' ? 'en' : 'zh'
              const prompts = {}
              prompts[lang] = ''
              run('save-plugin', { judgePrompts: prompts }, okMsg, { reload: true })
              return
            }
            run('rule-op', { op: 'reset', kind: kind, value: value }, okMsg)
          },
        }, armed ? t('set.resetConfirm') : idleLabel)
      }

      const saveJudge = function () {
        const n = Number(timeoutMs)
        if (!Number.isFinite(n) || n <= 0) {
          showFeedback(t('err.invalidNumber'), false)
          return
        }
        run('save-plugin', {
          judgePromptLang: judgePromptLang,
          judge: { provider: judgeProvider, model: judgeModel, reasoningEffort: judgeEffort },
          judgeTimeoutMs: n,
          judgePrompts: (function () {
            const shipped = (snapshot.predefined && snapshot.predefined.judgePrompts) || {}
            const store = function (lang) {
              const draft = String((judgePromptDrafts && judgePromptDrafts[lang]) || '')
              const def = String(shipped[lang] || '')
              if (!draft.trim() || draft.trim() === def.trim()) return ''
              return draft
            }
            return { zh: store('zh'), en: store('en') }
          })(),
        }, t('set.judgeSaved'), { reload: true })
      }

      return React.createElement('div', { className: 'ab-set', ref: rootRef },
        React.createElement('h3', { className: 'ab-set-title' }, t('set.title')),
        React.createElement('p', { className: 'ab-set-intro' }, t('set.intro')),
        feedback
          ? React.createElement('div', { className: 'ab-set-flash ' + (feedback.ok ? 'ab-set-ok' : 'ab-set-err') }, feedback.msg)
          : null,
        (cfg && cfg.corrupt)
          ? React.createElement('div', { className: 'ab-set-err' }, t('set.allowlistCorrupt'))
          : null,
        snapshot.pluginCorrupt
          ? React.createElement('div', { className: 'ab-set-err' },
            t('set.pluginCorrupt'),
            React.createElement('button', {
              type: 'button', className: 'ab-set-btn ab-set-btn-danger', disabled: busy,
              onClick: function () { run('save-plugin', { overwriteCorrupt: true }, t('set.overwriteOk'), { reload: true }) },
            }, t('set.pluginCorruptOverwrite')),
          )
          : null,
        !setup.configured ? React.createElement('div', { className: 'ab-set-card' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.presetMissingTitle')),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.presetMissingSub'))),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('button', {
              type: 'button', className: 'ab-set-btn ab-set-btn-primary', disabled: busy,
              onClick: function () { run('setup', {}, t('set.presetWrote')) },
            }, t('set.presetWrite')),
            React.createElement('span', { className: 'ab-set-note' }, t('set.presetWriteNote')),
          ),
        ) : null,
        (setup.configured && setup.drift && setup.drift.baseKnown && (setup.drift.missing || []).length)
          ? React.createElement('div', { className: 'ab-set-card' },
            React.createElement('div', { className: 'ab-set-card-head' },
              React.createElement('div', { className: 'ab-set-card-title' }, t('set.driftTitle')),
              React.createElement('p', { className: 'ab-set-card-sub' },
                t('set.driftBody', { keys: (setup.drift.missing || []).join(' / ') }))),
          )
          : null,

        React.createElement('div', { className: 'ab-set-card' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.modeTitle'))),
          React.createElement('div', { className: 'ab-set-row ab-set-row-choices' },
            React.createElement('button', {
              type: 'button',
              className: 'ab-set-choice' + (presetSandbox === 'workspace-write' ? ' ab-set-choice-on' : ''),
              disabled: busy,
              onClick: function () {
                if (presetSandbox === 'workspace-write') return
                run('save-plugin', { presetSandbox: 'workspace-write' }, t('set.modeSaved')).then(function (res) {
                  if (res) setPresetSandbox('workspace-write')
                })
              },
            },
              React.createElement('span', { className: 'ab-set-choice-t' }, t('set.modeWs')),
              React.createElement('span', { className: 'ab-set-choice-d' }, t('set.modeWsHint')),
            ),
            React.createElement('button', {
              type: 'button',
              className: 'ab-set-choice' + (presetSandbox === 'read-only' ? ' ab-set-choice-on' : ''),
              disabled: busy,
              onClick: function () {
                if (presetSandbox === 'read-only') return
                run('save-plugin', { presetSandbox: 'read-only' }, t('set.modeSaved')).then(function (res) {
                  if (res) setPresetSandbox('read-only')
                })
              },
            },
              React.createElement('span', { className: 'ab-set-choice-t' }, t('set.modeRo')),
              React.createElement('span', { className: 'ab-set-choice-d' }, t('set.modeRoHint')),
            ),
          ),
          React.createElement('p', { className: 'ab-set-note' }, t('set.modeHint')),
        ),

        React.createElement('div', { className: 'ab-set-card' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.overview')),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.overviewSub'))),
          React.createElement('div', { className: 'ab-set-steps' },
            [
              {
                id: 'keywords', name: t('set.stepKeywords'),
                value: countsLabel(t, (cfg.rejectKeywords || []).length, (cfg.humanKeywords || cfg.denyKeywords || []).length, (cfg.allowKeywords || []).length),
              },
              { id: 'criteria', name: t('set.stepCriteria'), value: t('set.criteriaCount', { n: String((cfg.criteria || []).length) }) },
              { id: 'judge', name: t('set.stepJudge'), value: judgeRoute + ' · ' + judgeTimeoutLabel },
            ].map(function (s) {
              return React.createElement('button', {
                type: 'button', className: 'ab-set-step', key: s.id,
                onClick: function () { scrollToStage(s.id) },
              },
                React.createElement('div', { className: 'ab-set-step-k' }, s.name),
                React.createElement('div', { className: 'ab-set-step-v' }, s.value),
              )
            }),
          ),
          React.createElement('div', { className: 'ab-set-invs' },
            (cfg.criteria || []).map(function (c) {
              return React.createElement('span', {
                className: 'ab-set-inv ' + (c.action === 'reject' ? 'ab-set-inv-hard' : c.action === 'allow' ? 'ab-set-inv-ok' : 'ab-set-inv-mode'),
                key: c.id, title: c.id,
              }, (criterionLabel(t, c.id, c.label) || c.id) + ' · ' + (actionLabel(t, c.action) || c.action))
            }),
          ),
        ),

        React.createElement('details', {
          className: 'ab-set-card ab-set-fold', 'data-ab-stage': 'keywords',
          open: foldOpen.keywords,
          onToggle: function (e) {
            const open = e.currentTarget.open
            setFoldOpen(function (prev) { return Object.assign({}, prev, { keywords: open }) })
          },
        },
          React.createElement('summary', null,
            React.createElement('div', { className: 'ab-set-card-head' },
              React.createElement('div', { className: 'ab-set-card-title' },
                t('set.stepKeywords'),
                React.createElement('span', { className: 'ab-set-fold-chev' }, '▾')),
              React.createElement('p', { className: 'ab-set-card-sub' }, t('set.kwSub'))),
            React.createElement('div', { className: 'ab-set-fold-sum' },
              countsLabel(t, (cfg.rejectKeywords || []).length, (cfg.humanKeywords || cfg.denyKeywords || []).length, (cfg.allowKeywords || []).length))),
          React.createElement('div', { className: 'ab-set-fold-body' },
          React.createElement('div', { className: 'ab-set-list' },
            (function () {
              const rows = []
              ;(cfg.rejectKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'reject' }) })
              ;(cfg.humanKeywords || cfg.denyKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'human' }) })
              ;(cfg.allowKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'allow' }) })
              if (rows.length === 0) return React.createElement('p', { className: 'ab-set-empty' }, t('set.empty'))
              return rows.map(function (row) {
                const commitKw = function (text, action) {
                  const next = String(text || '').trim()
                  if (!next) return
                  if (next === row.text && action === row.action) return
                  run('rule-op', { op: 'set', kind: 'keywords', value: { from: row.text, text: next, action: action } })
                }
                const editKey = row.action + ':' + row.text
                return React.createElement('div', { className: 'ab-set-item ab-set-item-kw', key: editKey },
                  kwEdit === editKey
                    ? React.createElement('input', {
                        className: 'ab-set-input ab-set-input-grow',
                        defaultValue: row.text,
                        autoFocus: true,
                        onBlur: function (e) {
                          if (kwSkipBlurRef.current) {
                            kwSkipBlurRef.current = false
                            return
                          }
                          commitKw(e.target.value, row.action)
                          setKwEdit(null)
                        },
                        onKeyDown: function (e) {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') {
                            kwSkipBlurRef.current = true
                            setKwEdit(null)
                          }
                        },
                      })
                    : React.createElement('span', {
                        className: 'ab-set-kw-text',
                        title: t('set.kwEditTitle'),
                        onClick: function () { setKwEdit(editKey) },
                      }, row.text),
                  preDeny.has(row.text) ? React.createElement('span', { className: 'ab-set-tag ab-set-tag-blue' }, t('set.presetTag')) : null,
                  React.createElement('select', {
                    className: 'ab-set-select', value: row.action,
                    onChange: function (e) { commitKw(row.text, e.target.value) },
                  },
                    React.createElement('option', { value: 'human' }, t('action.human')),
                    React.createElement('option', { value: 'allow' }, t('action.allow')),
                    React.createElement('option', { value: 'reject' }, t('action.reject')),
                  ),
                  React.createElement('button', {
                    type: 'button',
                    className: 'ab-set-item-del' + (resetArmed === ('del-kw:' + row.text) ? ' ab-set-btn-danger' : ''),
                    title: t('set.delete'),
                    onClick: function () {
                      const key = 'del-kw:' + row.text
                      if (preDeny.has(row.text) && resetArmed !== key) {
                        setResetArmed(key)
                        return
                      }
                      setResetArmed(null)
                      run('rule-op', { op: 'remove', kind: 'keywords', value: { text: row.text } })
                    },
                  }, resetArmed === ('del-kw:' + row.text) ? t('set.confirm') : '✕'),
                )
              })
            })(),
          ),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-grow', placeholder: t('set.kwPlaceholder'),
              value: newKeyword, onChange: function (e) { setNewKeyword(e.target.value) },
            }),
            React.createElement('select', {
              className: 'ab-set-select', value: newKeywordAction,
              onChange: function (e) { setNewKeywordAction(e.target.value) },
            },
              React.createElement('option', { value: 'human' }, t('action.human')),
              React.createElement('option', { value: 'allow' }, t('action.allow')),
              React.createElement('option', { value: 'reject' }, t('action.reject')),
            ),
            React.createElement('button', {
              type: 'button', className: 'ab-set-btn', disabled: busy || !newKeyword.trim(),
              onClick: function () {
                const text = newKeyword.trim()
                run('rule-op', { op: 'add', kind: 'keywords', value: { text: text, action: newKeywordAction } }).then(function (res) {
                  if (res) setNewKeyword('')
                })
              },
            }, t('set.add')),
          ),
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            resetBtn('keywords', t('set.resetKeywords'), t('set.resetKeywordsOk')),
          ),
          ),
        ),

        React.createElement('details', {
          className: 'ab-set-card ab-set-fold', 'data-ab-stage': 'criteria',
          open: foldOpen.criteria,
          onToggle: function (e) {
            const open = e.currentTarget.open
            setFoldOpen(function (prev) { return Object.assign({}, prev, { criteria: open }) })
          },
        },
          React.createElement('summary', null,
            React.createElement('div', { className: 'ab-set-card-head' },
              React.createElement('div', { className: 'ab-set-card-title' },
                t('set.stepCriteria'),
                React.createElement('span', { className: 'ab-set-fold-chev' }, '▾')),
              React.createElement('p', { className: 'ab-set-card-sub' }, t('set.criteriaSub'))),
            React.createElement('div', { className: 'ab-set-fold-sum' },
              (function () {
                const rows = cfg.criteria || []
                const n = function (a) { return rows.filter(function (c) { return c.action === a }).length }
                return countsLabel(t, n('reject'), n('human'), n('allow'))
              })())),
          React.createElement('div', { className: 'ab-set-fold-body' },
          React.createElement('div', { className: 'ab-set-list ab-set-list-crit' },
            (cfg.criteria || []).map(function (c) {
              const commitCrit = function (patch) {
                run('rule-op', { op: 'set', kind: 'criteria', value: Object.assign({ id: c.id }, patch) })
              }
              return React.createElement('div', { className: 'ab-set-item ab-set-item-crit', key: c.id },
                React.createElement('div', { className: 'ab-set-crit-top' },
                  React.createElement('span', { className: 'ab-set-item-id', title: c.id }, criterionLabel(t, c.id) || c.id),
                  React.createElement('select', {
                    className: 'ab-set-select', value: c.action || 'human',
                    onChange: function (e) { commitCrit({ action: e.target.value }) },
                  },
                    React.createElement('option', { value: 'human' }, t('action.human')),
                    React.createElement('option', { value: 'allow' }, t('action.allow')),
                    React.createElement('option', { value: 'reject' }, t('action.reject')),
                  ),
                  c.id === 'other' ? null : React.createElement('button', {
                    type: 'button',
                    className: 'ab-set-item-del' + (resetArmed === ('del-c:' + c.id) ? ' ab-set-btn-danger' : ''),
                    onClick: function () {
                      const key = 'del-c:' + c.id
                      if (resetArmed !== key) {
                        setResetArmed(key)
                        return
                      }
                      setResetArmed(null)
                      run('rule-op', { op: 'remove', kind: 'criteria', value: { id: c.id } })
                    },
                  }, resetArmed === ('del-c:' + c.id) ? t('set.confirm') : '✕'),
                ),
                React.createElement('div', { className: 'ab-set-item-fields' },
                  React.createElement('input', {
                    key: c.id + ':label:' + (c.label || ''),
                    className: 'ab-set-input ab-set-input-ui',
                    defaultValue: c.label || '',
                    placeholder: t('set.labelPlaceholder'),
                    onBlur: function (e) {
                      const next = e.target.value.trim()
                      if (!next || next === c.label) return
                      commitCrit({ label: next })
                    },
                    onKeyDown: function (e) { if (e.key === 'Enter') e.currentTarget.blur() },
                  }),
                  React.createElement('textarea', {
                    key: c.id + ':desc:' + (c.description || ''),
                    className: 'ab-set-textarea',
                    defaultValue: c.description || '',
                    placeholder: t('set.descPlaceholder'),
                    rows: 3,
                    ref: sizeTextarea,
                    onInput: function (e) { sizeTextarea(e.currentTarget) },
                    onBlur: function (e) {
                      const next = e.target.value.trim()
                      if (next === (c.description || '')) return
                      commitCrit({ description: next })
                    },
                  }),
                ),
              )
            }),
          ),
          React.createElement('div', { className: 'ab-set-item ab-set-item-crit' },
            React.createElement('div', { className: 'ab-set-crit-top' },
              React.createElement('input', {
                className: 'ab-set-input ab-set-input-grow', placeholder: t('set.criterionId'),
                value: newCriterion.id,
                onChange: function (e) { setNewCriterion(Object.assign({}, newCriterion, { id: e.target.value })) },
              }),
              React.createElement('select', {
                className: 'ab-set-select', value: newCriterion.action,
                onChange: function (e) { setNewCriterion(Object.assign({}, newCriterion, { action: e.target.value })) },
              },
                React.createElement('option', { value: 'human' }, t('action.human')),
                React.createElement('option', { value: 'allow' }, t('action.allow')),
                React.createElement('option', { value: 'reject' }, t('action.reject')),
              ),
            ),
            React.createElement('div', { className: 'ab-set-item-fields' },
              React.createElement('input', {
                className: 'ab-set-input ab-set-input-ui', placeholder: t('set.labelPlaceholder'),
                value: newCriterion.label,
                onChange: function (e) { setNewCriterion(Object.assign({}, newCriterion, { label: e.target.value })) },
              }),
              React.createElement('textarea', {
                className: 'ab-set-textarea',
                placeholder: t('set.descPlaceholder'),
                rows: 2,
                value: newCriterion.description,
                onChange: function (e) { setNewCriterion(Object.assign({}, newCriterion, { description: e.target.value })) },
                ref: sizeTextarea,
                onInput: function (e) { sizeTextarea(e.currentTarget) },
              }),
            ),
            React.createElement('div', { className: 'ab-set-row ab-set-foot' },
              React.createElement('button', {
                type: 'button', className: 'ab-set-btn ab-set-btn-primary',
                disabled: busy || !(newCriterion.id || newCriterion.label),
                onClick: function () {
                  const row = newCriterion
                  run('rule-op', { op: 'add', kind: 'criteria', value: row }).then(function (res) {
                    if (res) setNewCriterion({ id: '', label: '', description: '', action: 'human' })
                  })
                },
              }, t('set.addCriterion')),
            ),
          ),
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            resetBtn(
              'criteria',
              t('set.resetCriteria', { lang: t(judgePromptLang === 'en' ? 'set.judgeLangEn' : 'set.judgeLangZh') }),
              t('set.resetCriteriaOk', { lang: t(judgePromptLang === 'en' ? 'set.judgeLangEn' : 'set.judgeLangZh') }),
              { lang: judgePromptLang },
            ),
          ),
          ),
        ),

        React.createElement('div', { className: 'ab-set-card', 'data-ab-stage': 'judge' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.judgeTitle')),
            React.createElement('p', { className: 'ab-set-card-sub' },
              t('set.judgeSubLead') +
              (fallback.provider && fallback.model
                ? t('set.judgeSubFallback', { provider: fallback.provider, model: fallback.model })
                : t('set.judgeSubNoFallback')) +
              t('set.judgeSubTail'))),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('select', {
              className: 'ab-set-select', value: judgeProvider,
              onChange: function (e) { setJudgeProvider(e.target.value); setJudgeModel(''); setJudgeEffort('') },
            },
              React.createElement('option', { value: '' }, t('set.followProvider')),
              providers.map(function (p) {
                return React.createElement('option', { value: p.id, key: p.id }, p.name || p.id)
              }),
            ),
            React.createElement('select', {
              className: 'ab-set-select', value: judgeModel,
              onChange: function (e) { setJudgeModel(e.target.value); setJudgeEffort('') },
            },
              React.createElement('option', { value: '' }, t('set.followModel')),
              models.map(function (m) {
                return React.createElement('option', { value: m.id, key: m.id }, m.name || m.id)
              }),
            ),
            React.createElement('select', {
              className: 'ab-set-select', value: judgeEffort,
              onChange: function (e) { setJudgeEffort(e.target.value) },
            },
              React.createElement('option', { value: '' }, t('set.modelDefaultEffort')),
              React.createElement('option', { value: 'off' }, t('set.effortOff')),
              efforts.filter(function (e) { return e.id !== 'off' }).map(function (e) {
                return React.createElement('option', { value: e.id, key: e.id }, e.name || e.id)
              }),
            ),
          ),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgeLang')),
            React.createElement('select', {
              className: 'ab-set-select', value: judgePromptLang,
              onChange: function (e) { setJudgePromptLang(e.target.value === 'en' ? 'en' : 'zh') },
            },
              React.createElement('option', { value: 'zh' }, t('set.judgeLangZh')),
              React.createElement('option', { value: 'en' }, t('set.judgeLangEn')),
            ),
            React.createElement('span', { className: 'ab-set-card-sub' }, t('set.judgeLangHint')),
          ),
          React.createElement('div', { className: 'ab-set-item-fields' },
            React.createElement('div', { className: 'ab-set-row' },
              React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgePrompt')),
              (function () {
                const shipped = String(((snapshot.predefined && snapshot.predefined.judgePrompts) || {})[judgePromptLang] || '')
                const draft = String((judgePromptDrafts && judgePromptDrafts[judgePromptLang]) || '')
                const custom = draft.trim() && draft.trim() !== shipped.trim()
                return React.createElement('span', { className: 'ab-set-tag ' + (custom ? 'ab-set-tag-warn' : 'ab-set-tag-blue') }, custom ? t('set.judgePromptCustom') : t('set.judgePromptDefault'))
              })(),
            ),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.judgePromptHint')),
            React.createElement('textarea', {
              key: 'judge-prompt:' + judgePromptLang,
              className: 'ab-set-textarea ab-set-textarea-prompt',
              value: (judgePromptDrafts && judgePromptDrafts[judgePromptLang]) || '',
              spellCheck: false,
              rows: 12,
              onChange: function (e) {
                const v = e.target.value
                const lang = judgePromptLang
                setJudgePromptDrafts(function (prev) {
                  const next = Object.assign({}, prev)
                  next[lang] = v
                  return next
                })
              },
            }),
          ),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgeTimeoutMs')),
            React.createElement('input', { className: 'ab-set-input ab-set-input-num', type: 'number', min: 1000, value: timeoutMs, onChange: function (e) { setTimeoutMs(e.target.value) } }),
          ),
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            resetBtn('judgePrompt', t('set.resetJudgePrompt'), t('set.resetJudgePromptOk')),
            React.createElement('button', {
              type: 'button', className: 'ab-set-btn ab-set-btn-primary', disabled: busy,
              onClick: saveJudge,
            }, t('set.save')),
          ),
        ),

      )
    }

    const AUTO_PRESET_LABEL = '自动审批'
    const ACCESS_GLYPH_CLASS = 'ab-access-glyph'
    const SHIELD_OUTLINE = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'
    const LETTER_A = 'M8.205 4.95 11.62 11.45H10.1l-.55-1.42H6.655l-.55 1.42H4.59L8.205 4.95Zm-.72 3.68h1.44L8.205 6.35 7.485 8.63Z'

    function accessGlyphSvg() {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      const shield = document.createElementNS(ns, 'path')
      shield.setAttribute('d', SHIELD_OUTLINE)
      shield.setAttribute('stroke', 'currentColor')
      shield.setAttribute('stroke-width', '1.31831')
      shield.setAttribute('stroke-linejoin', 'round')
      const letter = document.createElementNS(ns, 'path')
      letter.setAttribute('d', LETTER_A)
      letter.setAttribute('fill', 'currentColor')
      letter.setAttribute('fill-rule', 'evenodd')
      svg.appendChild(shield)
      svg.appendChild(letter)
      return svg
    }

    function isAccessTrigger(el) {
      if (!el || el.tagName !== 'BUTTON') return false
      const label = el.getAttribute('aria-label') || ''
      if (label.indexOf(AUTO_PRESET_LABEL) === -1) return false
      return label.indexOf('访问模式') === 0 || label.indexOf('Access mode') === 0
    }

    function isAccessMenuItem(el) {
      if (!el || typeof el.getAttribute !== 'function') return false
      if (el.getAttribute('role') !== 'menuitem') return false
      return String(el.textContent || '').replace(/\s+/g, '') === AUTO_PRESET_LABEL
    }

    function decorateAccess(el) {
      if (!el || el.querySelector('.' + ACCESS_GLYPH_CLASS)) return
      const span = document.createElement('span')
      span.className = ACCESS_GLYPH_CLASS
      span.setAttribute('aria-hidden', 'true')
      span.appendChild(accessGlyphSvg())
      el.insertBefore(span, el.firstChild)
    }

    /** 不再匹配的元素要摘掉徽标：切走「自动审批」后按钮是同一个 DOM 节点。 */
    function undecorateAccess(el) {
      if (!el || typeof el.querySelector !== 'function') return
      const glyph = el.querySelector('.' + ACCESS_GLYPH_CLASS)
      if (glyph && glyph.parentNode) glyph.parentNode.removeChild(glyph)
    }

    function matchesAccess(el) {
      return isAccessTrigger(el) || isAccessMenuItem(el)
    }

    function scanAccessGlyphs(root) {
      // 只处理元素/文档：MutationObserver 的 addedNodes 含文本节点，
      // 落到 document 兜底会让每次文本变化都做整篇 querySelectorAll。
      if (!root || (root.nodeType !== 1 && root.nodeType !== 9) || typeof root.querySelectorAll !== 'function') return
      const scope = root
      const buttons = scope.querySelectorAll('button[aria-label]')
      for (let i = 0; i < buttons.length; i++) {
        if (isAccessTrigger(buttons[i])) decorateAccess(buttons[i])
      }
      const items = scope.querySelectorAll('[role="menuitem"]')
      for (let i = 0; i < items.length; i++) {
        if (isAccessMenuItem(items[i])) decorateAccess(items[i])
      }
      // 反向清理：已经不匹配的元素（换预设 / 菜单关闭后 role 变化）必须摘掉徽标。
      const glyphs = scope.querySelectorAll('.' + ACCESS_GLYPH_CLASS)
      for (let i = 0; i < glyphs.length; i++) {
        const parent = glyphs[i].parentNode
        if (parent && !matchesAccess(parent)) undecorateAccess(parent)
      }
      if (root.nodeType === 1) {
        if (matchesAccess(root)) decorateAccess(root)
        else undecorateAccess(root)
      }
    }

    function mountAccessGlyphs() {
      scanAccessGlyphs(document)
      const obs = new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i++) {
          const rec = records[i]
          if (rec.type === 'attributes' && rec.target) {
            scanAccessGlyphs(rec.target)
            continue
          }
          // childList：React 先插入空按钮、再把标签塞进去时，那条记录的 target 是标签自己，
          // 只看 addedNodes 会让下拉里的「自动审批」永远拿不到徽标。这里只沿 target 向上找
          // 最近的触发器/menu 项重扫（不是扫整棵 target 子树，避免流式输出时每次变更都全量子树查询）。
          if (rec.target && rec.target.nodeType === 1 && typeof rec.target.closest === 'function') {
            const owner = rec.target.closest('button[aria-label], [role="menuitem"]')
            if (owner) scanAccessGlyphs(owner)
          }
          const nodes = rec.addedNodes
          for (let j = 0; j < nodes.length; j++) scanAccessGlyphs(nodes[j])
        }
      })
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      })
      return function () {
        obs.disconnect()
        const leftover = document.querySelectorAll('.' + ACCESS_GLYPH_CLASS)
        for (let i = 0; i < leftover.length; i++) {
          const n = leftover[i]
          if (n.parentNode) n.parentNode.removeChild(n)
        }
      }
    }

    const plugin = {
      inject: ['connection', 'slots', 'locale'],
      async apply(ctx) {
        const slots = ctx.slots
        const connection = ctx.connection
        ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }) })
        const t = ctx.locale.bind(NS)
        const rpc = makeRpc(connection, t)

        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'dsh-auto-approve')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch (e) {
          console.error('[dsh-auto-approve] 注入样式失败：' + String((e && e.message) || e))
        }
        ctx.effect(() => {
          return () => {
            if (styleEl && styleEl.parentNode) {
              try { styleEl.parentNode.removeChild(styleEl) } catch (e) {}
            }
          }
        })
        ctx.effect(function () {
          try {
            return mountAccessGlyphs()
          } catch (e) {
            console.error('[dsh-auto-approve] 访问模式图标失败：' + String((e && e.message) || e))
            return function () {}
          }
        })

        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'dsh-auto-approve.notice', order: 30, locale: NS, label: function () { return t('slot.notice') } },
            function (props) { return React.createElement(NoticeStrip, { slotsProps: props, rpc: rpc, t: t }) },
          )
        })

        slots.inject('conversation.view', function () {
          return slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-auto-approve.history',
              order: 20,
              locale: NS,
              label: function () { return t('slot.history') },
              inject: (sessionId) => ({ sessionId }),
            },
            function (props) { return React.createElement(HistoryView, { slotsProps: props, rpc: rpc, t: t }) },
          )
        })

        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'dsh-auto-approve.settings', order: 55, locale: NS, label: function () { return t('slot.settings') } },
            function (props) { return React.createElement(SettingsPage, { slotsProps: props, rpc: rpc, t: t }) },
          )
        })
      },
    }

    exports.apply = plugin.apply
    exports.inject = plugin.inject
    exports.name = '@dnalec/dsh-auto-approve'
    return module.exports
  },
})
