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
.ab-approval-detail{white-space:pre-line}
.ab-detail-v-box{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform));border-radius:8px;padding:6px 8px;max-height:180px;overflow:auto}
.ab-detail-warn{border-radius:8px;padding:6px 8px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.ab-empty,.ab-loading{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ab-set{box-sizing:border-box;width:100%;max-width:720px;padding:0 0 28px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.ab-set-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.ab-set-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.ab-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.ab-set-fold{padding:0}
.ab-set-fold>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px}
.ab-set-fold>summary::-webkit-details-marker{display:none}
.ab-set-fold>summary:hover{background:var(--dsw-alias-interactive-bg-hover);border-radius:12px}
.ab-set-fold[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:12px 12px 0 0}
.ab-set-fold-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px}
.ab-set-fold-sum{flex:none;display:block;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:right;max-width:46%}
.ab-set-fold-chev{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.ab-set-fold[open]>summary .ab-set-fold-chev{transform:rotate(180deg)}
.ab-set-card-head{flex-direction:column;gap:4px;display:flex}
.ab-set-card-title{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;font-size:14px;font-weight:500;line-height:20px;display:flex}
.ab-set-card-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.ab-set-note{color:var(--dsw-alias-state-warn-label);margin:0;font-size:13px;line-height:20px}
.ab-set-ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:13px;line-height:20px}
.ab-set-muted{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
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
.ab-set-kw-text{flex:1 1 auto;min-width:0;cursor:text;color:var(--dsw-alias-label-primary);font:12px/18px var(--ds-font-family-code);word-break:break-all;background:transparent;border:none;padding:0;text-align:left}
.ab-set-kw-text:hover{color:var(--dsw-alias-state-business-primary)}
.ab-set-kw-text:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:4px}
.ab-set-textarea{box-sizing:border-box;width:100%;min-height:72px;resize:none;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/18px inherit;border-radius:8px;outline:none;padding:6px 10px}
.ab-set-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.ab-set-textarea-prompt{min-height:180px;max-height:360px;resize:vertical;overflow:auto;font-family:var(--ds-font-family-code);white-space:pre-wrap}
.ab-set-foot{justify-content:flex-end}
.ab-set-list-crit{gap:8px}
.ab-set-item-crit{flex-direction:column;align-items:stretch;gap:8px;padding:10px 12px}
.ab-set-crit-top{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.ab-set-cells{display:flex;flex:none;align-items:center;gap:6px}
.ab-set-cell{display:inline-flex;align-items:center;gap:4px}
.ab-set-cell-lv{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.ab-set-select-sm{height:28px;padding:0 6px;font-size:12px;min-width:64px}
.ab-set-item-fields{min-width:0;flex-direction:column;gap:6px;display:flex}
.ab-set-item-id{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;font-family:var(--ds-font-family-code);overflow-wrap:anywhere}
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
    /* 历史详情里已有专门一行的键。自定义工具（MCP）的通用参数不在这个表里，要单独列出来。 */
    const CARD_ARG_KEYS = ['command', 'file_path', 'path', 'description', 'old_string', 'new_string', 'content', 'code', 'url', 'query', 'script', 'sql', 'prompt', 'input', 'text', 'body', 'message', 'pattern', 'selector']
    /**
     * 详情里要单独成行的通用参数键。
     *
     * 专门行只覆盖一组里的**一个**键（`file_path` 优先于 `path`），所以「同组里落选的那个」
     * 必须在通用区出现：`{path:'/x', file_path:'/y'}` 两个都是用户要看的参数，
     * 早先的实现会让 `/x` 整条消失。
     */
    function detailExtraKeys(args) {
      const a = args || {}
      const consumed = new Set()
      const losers = new Set()
      const groups = [['command'], ['file_path', 'path'], ['description'], ['old_string'], ['new_string'], ['content']]
      for (const group of groups) {
        const present = group.filter((k) => a[k] !== undefined && a[k] !== null)
        if (!present.length) continue
        consumed.add(present[0])
        for (const k of present.slice(1)) losers.add(k)
      }
      return Object.keys(a)
        // 同组落选的键（`{file_path, path}` 里的 path）照常进通用区；
        // 组里选中的那个与其它有专门行的键都不重复列。
        .filter((k) => losers.has(k) || (!consumed.has(k) && isExtraArgKey(k)))
        .sort()
    }

    function isExtraArgKey(key) {
      if (key === 'workdir') return false
      // 带点号的键是宿主拍平出来的**嵌套**叶子（`params.command`、`args.file_path`）：
      // 上面那些专门行读的是**顶层**键，所以嵌套键必须自己成行——按尾段认成「已有专门行」
      // 会让它既进不了通用行、又没有被专门行覆盖，历史里整个参数消失。
      if (key.indexOf('.') !== -1) return true
      return CARD_ARG_KEYS.indexOf(key) === -1
    }
    const ZH = JSON.parse(String.raw`{"slot.notice":"自动放行提示","slot.history":"审批","slot.settings":"自动审批","action.reject":"拒绝","action.allow":"允许","action.human":"人工","src.strict":"模型分类","src.bare":"只给了 id","src.fuzzy":"模糊兜底","src.none":"认不出","src.empty":"输出为空","src.timeout":"超时","src.call":"调用失败","src.route":"无可用路由","src.plugin":"插件异常","src.truncated":"超过送审上限","src.uncaptured":"没采集到参数","src.oversize":"撞收集护栏","sandbox.read-only":"只读","sandbox.workspace-write":"工作区可写","sandbox.danger-full-access":"全权限","source.web":"网页","verdict.keyword-allow":"关键词允许","verdict.keyword-reject":"关键词拒绝","verdict.keyword-human":"关键词转人工","verdict.criteria-reject":"审核表拒绝","verdict.criteria-allow":"审核表允许","verdict.criteria-human":"审核表转人工","verdict.judge-failed":"判定失败转人工","verdict.truncated-payload":"内容超过送审上限","verdict.plugin-error":"插件异常","verdict.human":"转人工","verdict.cancelled":"人工取消","verdict.unavailable":"审批不可用","path.keyword-reject":"关键词拒绝","path.keyword-allow":"关键词允许","path.keyword-human":"关键词转人工","path.criteria-reject":"审核表拒绝","path.criteria-allow":"审核表允许","path.criteria-human":"审核表转人工","path.judge-failed":"判定失败转人工","path.truncated-payload":"内容超过送审上限","path.plugin-error":"插件异常","notice.feedError":"审批提示暂时不可用","notice.feedErrorTag":"连接失败","notice.pendingTitle":"等待人工审批：{preview}","notice.pendingTag":"人工审批中","notice.webApproved":"人工审批通过：{preview}","notice.webApprovedTag":"人工审批通过","notice.rejectedTitle":"已拒绝：{preview}","notice.rejectedTag":"已拒绝","notice.cancelledTitle":"已取消人工审批：{preview}","notice.unavailableTitle":"审批不可用：{preview}","notice.autoTag":"自动放行 · {verdict}","notice.autoDefault":"自动放行","notice.rejectedDefault":"已拒绝","notice.hint":"提示","notice.close":"关闭","notice.feedLoadFailed":"审批提示加载失败，将自动重试","history.noSession":"未选择会话","history.loadFailed":"加载失败：{error}","history.loading":"加载中…","history.title":"审批","history.emptySub":"当前会话还没有审批记录","history.emptyHint":"自动放行与转人工都会出现在这里","history.sub":"最新在上 · 点开看命令与详情","history.tagAuto":"自动放行","history.tagPending":"转人工","history.tagAllow":"人工批准","history.tagReject":"人工拒绝","history.tagCancel":"人工取消","history.tagUnavailable":"审批不可用","history.unknownTool":"工具","detail.request":"请求","detail.audit":"审核","detail.command":"命令","detail.path":"路径","detail.description":"描述","detail.old":"原文","detail.new":"改成","detail.content":"写入内容","detail.code":"代码","detail.url":"URL","detail.query":"查询","detail.script":"脚本","detail.sql":"SQL","detail.prompt":"提示词","detail.input":"输入","detail.text":"文本","detail.body":"正文","detail.message":"消息","detail.pattern":"模式","detail.selector":"选择器","detail.arg":"参数","detail.argsOmitted":"存档中略过的字段","detail.argsMore":"还有 {n} 个字段（点开前未逐条展开）","detail.cwd":"工作目录","detail.workdir":"命令工作目录","detail.empty":"(空)","detail.truncated":"（共 {n} 字；尾部：…{tail}）","detail.alsoArgs":"（另有 {n} 个参数：{list}{rest}）","detail.alsoMore":"；还有 {n} 个未列出","detail.alsoArgsHidden":"（另有 {n} 个参数未列出）","detail.argsFirst":"（共 {n} 个参数，仅列前 {shown} 个）","detail.depthCut":"（更深层参数未展开）","detail.leafCut":"（参数过多，未全部展开）","detail.nestedTooDeep":"（参数嵌套过深，未展开）","detail.argsUncaptured":"⚠ 未采集到这次调用的参数：插件没拿到参数，审批记录里没有可展示的操作内容——批准等于同意一次你没看到内容的操作。","detail.sandbox":"沙箱","detail.justification":"模型理由","detail.pipe":"管道","detail.keyword":"关键词","detail.judgeModel":"审核模型","detail.judgeCategory":"审核类别","detail.judgeAction":"执行动作","detail.judgeLevel":"风险等级","detail.levelFallback":"（兜底档）","detail.judgeSrc":"判定来源","detail.judgeReason":"审核理由","detail.judgeError":"审核失败","detail.judgeRaw":"审核结果原文","detail.source":"来源","detail.judgeFailed":"判定失败（没跑成 → 固定转人工）","approval.autoVerdict":"自动判定：","set.title":"自动审批","set.intro":"需要审批的调用交审核模型判定（允许 / 拒绝等同网页按钮），拿不准则交回原人工审批框。详细说明见 README。","set.allowlistCorrupt":"规则文件损坏，当前是内存默认，普通保存不会覆盖磁盘。请修好 allowlist.json，或点「恢复默认」写回出厂规则。","set.pluginCorrupt":"插件配置损坏，拒绝保存以免清空审核模型。请修好 ~/.dsh/auto-approve/config.json，或","set.pluginCorruptOverwrite":"覆盖损坏配置","set.loading":"加载中…","set.loadFailed":"加载失败：{error}","set.resetConfirm":"再点一次确认恢复","set.presetMissingTitle":"权限预设","set.driftTitle":"权限预设表需要更新","set.driftBody":"DSH 出厂权限预设表多了 {keys}；patch 整块替换 config，这些预设不会自动出现。请更新插件或手工合并该行。","set.presetMissingSub":"插件启动时会写入 auto-approve。当前未检测到，可手动补写。","set.presetWrite":"写入权限预设","set.presetWriteNote":"写入后需重启 dsh web","set.presetWrote":"已写入，请重启 dsh web","set.modeTitle":"自动审批模式","set.modeWs":"工作区可写（推荐）","set.modeWsHint":"工作区内直接放行，越出工作区需审核。","set.modeRo":"只读","set.modeRoHint":"工作区内写操作也需审核。","set.modeHint":"点选即写入；改完需重启 dsh web，并重新选择「自动审批」。","set.save":"保存","set.hotOk":"已生效（热更新，无需重启）","set.modeSaved":"已写入。请重启 dsh web，并重新选择「自动审批」或开新会话","set.overview":"审批总览","set.overviewSub":"顺序：拒绝关键词 → 参数没采集到（无条件拒绝）→ 人工关键词 → 闸门（看不见这次操作）→ 允许关键词 → 审核模型；判定没跑成固定转人工。","set.stepKeywords":"关键词","set.stepCriteria":"审核表","set.stepJudge":"审核模型","set.counts":"三格合计 拒 {reject} · 人 {human} · 允 {allow}","set.kwCounts":"拒 {reject} · 人 {human} · 允 {allow}","set.criteriaCount":"{n} 项","set.followDefault":"跟随默认","set.unconfigured":"未配置","set.kwSub":"匹配工具名、命令、路径、工作目录与自定义工具的参数值；看不到写入内容与数字/布尔开关，那几类只能靠审核模型。","set.empty":"暂无","set.presetTag":"预置","set.kwEditTitle":"点击修改","set.kwPlaceholder":"新关键词","set.add":"添加","set.resetKeywords":"恢复默认关键词","set.resetKeywordsOk":"已恢复默认关键词","set.confirm":"确认","set.delete":"删除","set.criteriaSub":"模型只看 id 与说明（说明写清什么情况下选这个 id）；id 用英文，会显示在审批历史里。","set.descPlaceholder":"说明（什么情况下选这个 id）","set.criterionOtherNote":"不能删除；说明与三格和其它行一样可改","set.resetCriteriaZh":"恢复中文默认审核表","set.resetCriteriaEn":"恢复英文默认审核表","set.resetCriteriaOk":"已恢复为{lang}默认审核表","set.addCriterion":"添加审核项","set.criteriaLangNote":"恢复默认会同时切换提示词语言","set.levelsTitle":"风险等级","set.levelsSub":"三档说明都会送进提示词。","set.levelFallback":"等级认不出时按：","set.levelFallbackHint":"模型没给等级或给了认不出的词时用它：兜底 high 直接拒绝，low 自动放行。","set.levelDescPlaceholder":"等级说明（什么情况算这一档）","set.resetLevelsZh":"恢复中文默认等级","set.resetLevelsEn":"恢复英文默认等级","set.resetLevelsOk":"已恢复为{lang}默认等级说明","set.truncatedAction":"超过送审上限 / 撞收集护栏：","set.humanReviewTitle":"模型转人工","set.humanReviewSub":"自动拒绝时把原因告诉模型，并允许它把这次操作转人工；批准只对同参数的一次重试有效。","set.humanReviewWarn":"开启后人工审批框成为模型可主动触发的通道（包括它被不可信内容驱动时）。默认关闭。","set.humanReviewEnable":"允许模型请求人工复核","set.humanReviewTool":"工具名：","set.humanReviewToolHint":"改完需重启 dsh web 才换名。","set.humanReviewLang":"提示语言：","set.humanReviewOn":"已开启","set.humanReviewOff":"已关闭","set.humanReviewSaved":"模型转人工设置已保存","denyReason.keyword":"关键词红线","denyReason.criterion":"审核表判定","denyReason.payload-truncated":"内容超过送审上限","denyReason.payload-uncaptured":"没采集到参数（插件侧采集故障）","denyReason.judge-empty":"审核模型没有输出","denyReason.judge-timeout":"审核模型超时","denyReason.judge-call":"审核模型调用失败","denyReason.judge-route":"没有可用审核路由","denyReason.judge-unparsed":"审核输出无法归类","denyReason.plugin-error":"审核插件异常","verdict.human-grant":"人工批准后重试放行","path.human-grant":"人工批准后重试放行","verdict.human-review":"模型请求人工复核","path.human-review":"模型请求人工复核","set.criterionId":"id","set.judgeTitle":"审核模型","set.judgeSubLead":"空则跟随部署默认","set.judgeSubFallback":"（{provider} / {model}）","set.judgeSubNoFallback":"（当前没有默认可跟随）","set.followProvider":"跟随默认提供方","set.followModel":"跟随默认模型","set.modelDefaultEffort":"模型默认","set.judgeProviderLabel":"提供方","set.judgeModelLabel":"模型","set.judgeEffortLabel":"思考强度","set.judgeTimeoutMs":"审核超时(ms)：","set.judgeRequestBudget":"送审内容上限(字符)：","set.judgeRequestBudgetHint":"量的是整条请求（提示词 + 卡片）；超了就按下面选的动作处理，不会切一半送审。","set.judgeMaxTokens":"输出预算(token)：","set.judgeMaxTokensHint":"会推理时的首轮输出上限，默认 8192；给少了推理会吃光预算 → 空输出 → 白跑一次重试。上限不是预扣，给足不会变慢；不推理的路由固定 256。","set.judgeSelftest":"测试判定","set.judgeSelftestBusy":"测试中…","set.judgeSelftestOk":"判定成功：{ms}ms · 类别 {category} · 正文 {chars} 字","set.judgeSelftestOkRetry":"换大预算后判定成功：{ms}ms · 类别 {category} · 正文 {chars} 字","set.judgeSelftestFail":"判定失败：{detail}","set.judgeHealthWarn":"本次运行 {n} 次判定因输出为空而转人工（推理吃光输出预算），换大预算救回 {ok} 次；仍然如此请换一个不思考的审核模型，详见 README。","err.judgeRequestBudgetRange":"送审内容上限需要在 8192 到 1000000 之间","err.judgeMaxTokensRange":"输出预算需要在 256 到 32768 之间","set.judgeSaved":"审核设置已保存","set.judgeLangZh":"中文","set.judgeLangEn":"English","set.judgePrompt":"审核提示词","set.judgePromptLang":"当前语言：{lang}","set.judgePromptHint":"{{criteria}} / {{levels}} 为插入点；与审核模型一起保存。","set.langByRestore":"语言只在「恢复默认」时选择。","set.judgePromptCustom":"已自定义","set.judgePromptUnsaved":"未保存","set.judgePromptDefault":"默认","set.resetJudgePromptZh":"恢复中文默认提示词","set.resetJudgePromptEn":"恢复英文默认提示词","set.resetJudgePromptOk":"已恢复{lang}默认提示词","set.overwriteOk":"已覆盖损坏的插件配置","err.missingPayloadUncaptured":"没拿到工具参数（未捕获）","err.truncatedPayload":"送审内容超过上限（禁止不看全就判定）","err.pluginError":"插件判定异常","err.allowlistCorrupt":"规则文件损坏，拒绝覆盖。请先「恢复默认」写回出厂规则，或修好磁盘上的 allowlist.json","err.allowlistWrite":"写入 allowlist 失败","err.criterionNotFound":"未找到该审核项","err.criterionNeedId":"需要英文 id（字母、数字、-、_）","err.criterionNeedDesc":"需要说明：写清什么情况下选这个 id","err.criterionIdExists":"id 已存在","err.criterionOtherLocked":"「其他」不可删除","err.criteriaOp":"审核表请用添加 / 修改 / 删除 / 恢复默认","err.criterionLevel":"三格动作只能是 允许 / 拒绝 / 人工","err.levelNeedDesc":"等级说明不能为空","err.levelFallback":"兜底档只能是 low / medium / high","err.levelNotFound":"未找到该风险等级","err.levelsOp":"风险等级请用修改 / 恢复默认","err.invalidAction":"只能是「转人工」或「拒绝」","err.opMustSet":"{kind} 只能用修改操作","err.invalidNumber":"无效数值","err.keywordEmpty":"关键词不能为空","err.keywordNotFound":"未找到该关键词","err.keywordsOp":"关键词请用添加 / 修改 / 删除 / 恢复默认","err.valueEmpty":"值不能为空","err.unknownKind":"未知规则类型：{kind}","err.unknownOp":"未知操作：{op}","err.ruleNotFound":"未找到匹配的规则","err.badBody":"请求体不是 JSON","err.needSessionId":"需要 sessionId","err.pluginCorrupt":"插件配置损坏，拒绝覆盖。请修好磁盘文件，或点「覆盖损坏配置」","err.pluginWrite":"写入配置失败","err.unknownEndpoint":"未知接口：{endpoint}","err.internal":"内部错误：{error}","err.catalog":"无法列出模型：{error}","err.info":"无法读取模型信息：{error}","err.judgeUnconfigured":"未配置审核模型","err.judgeEffort":"思考强度 {effort} 不受支持","err.judgeTimeout":"审核超时（{ms}ms）","err.judgeRetryTimeout":"审核重试超时（{ms}ms）","err.judgeFailed":"审核失败","err.judgeCall":"审核模型调用失败：{error}","err.judgeEmpty":"审核模型输出为空","err.judgePromptTooLong":"自定义提示词过长（{chars} / 上限 {max} 字符）。提示词不会被截断保存：请自己删到上限以内再保存，否则尾巴里的输出格式与等级要求会丢失。","err.judgeUpstream":"审核模型路由失败：{error}","err.noPresetsKey":"permission 条目缺少 presets 键，请手动添加","err.preset":"写入预设失败：{error}","err.presetSandboxMissing":"预设里没有 sandbox 行，无法写入沙箱模式；请检查 profile 的 cordis.patch.yml","err.presetSandbox":"沙箱模式只能是 read-only / workspace-write / danger-full-access（收到的值认不出）","rpc.unavailable":"connection.rpc 不可用","rpc.failed":"RPC 失败"}`)
    const EN = JSON.parse(String.raw`{"slot.notice":"Auto-approve notice","slot.history":"Approvals","slot.settings":"Auto-approve","action.reject":"Reject","action.allow":"Allow","action.human":"Human","src.strict":"judge category","src.bare":"bare id","src.fuzzy":"fuzzy match","src.none":"unparsed","src.empty":"empty output","src.timeout":"timeout","src.call":"call failed","src.route":"no route","src.plugin":"plugin error","src.truncated":"judge request over budget","src.uncaptured":"arguments not captured","src.oversize":"collection guard hit","sandbox.read-only":"Read-only","sandbox.workspace-write":"Workspace write","sandbox.danger-full-access":"Full access","source.web":"Web","verdict.keyword-allow":"Keyword allow","verdict.keyword-reject":"Keyword reject","verdict.keyword-human":"Keyword → human","verdict.criteria-reject":"Criteria reject","verdict.criteria-allow":"Criteria allow","verdict.criteria-human":"Criteria → human","verdict.judge-failed":"Judge failed → human","verdict.truncated-payload":"Judge request over budget","verdict.plugin-error":"Plugin error","verdict.human":"To human","verdict.cancelled":"Human cancel","verdict.unavailable":"Unavailable","path.keyword-reject":"Keyword reject","path.keyword-allow":"Keyword allow","path.keyword-human":"Keyword → human","path.criteria-reject":"Criteria reject","path.criteria-allow":"Criteria allow","path.criteria-human":"Criteria → human","path.judge-failed":"Judge failed → human","path.truncated-payload":"Judge request over budget","path.plugin-error":"Plugin error","notice.feedError":"Approval notices unavailable","notice.feedErrorTag":"Connection failed","notice.pendingTitle":"Waiting for human: {preview}","notice.pendingTag":"Human review","notice.webApproved":"Approved: {preview}","notice.webApprovedTag":"Approved","notice.rejectedTitle":"Rejected: {preview}","notice.rejectedTag":"Rejected","notice.cancelledTitle":"Cancelled: {preview}","notice.unavailableTitle":"Unavailable: {preview}","notice.autoTag":"Auto-allowed · {verdict}","notice.autoDefault":"Auto-allowed","notice.rejectedDefault":"Rejected","notice.hint":"Notice","notice.close":"Dismiss","notice.feedLoadFailed":"Approval notices failed to load; retrying","history.noSession":"No session selected","history.loadFailed":"Failed to load: {error}","history.loading":"Loading…","history.title":"Approvals","history.emptySub":"This session has no approval records yet","history.emptyHint":"Auto-allows and human escalations appear here","history.sub":"Newest first · expand for command and details","history.tagAuto":"Auto-allowed","history.tagPending":"To human","history.tagAllow":"Human allow","history.tagReject":"Human reject","history.tagCancel":"Human cancel","history.tagUnavailable":"Unavailable","history.unknownTool":"Tool","detail.request":"Request","detail.audit":"Review","detail.command":"Command","detail.path":"Path","detail.description":"Description","detail.old":"Original","detail.new":"Replacement","detail.content":"Write contents","detail.code":"Code","detail.url":"URL","detail.query":"Query","detail.script":"Script","detail.sql":"SQL","detail.prompt":"Prompt","detail.input":"Input","detail.text":"Text","detail.body":"Body","detail.message":"Message","detail.pattern":"Pattern","detail.selector":"Selector","detail.arg":"Argument","detail.argsOmitted":"Fields omitted from this archive record","detail.argsMore":"{n} more fields (not expanded one by one)","detail.cwd":"Working directory","detail.workdir":"Command working directory","detail.empty":"(empty)","detail.truncated":" ({n} chars total; tail: …{tail})","detail.alsoArgs":" (also {n} args: {list}{rest})","detail.alsoMore":"; +{n} not shown","detail.alsoArgsHidden":" ({n} more args not shown)","detail.argsFirst":" ({n} args total; first {shown} shown)","detail.depthCut":" (deeper arguments not expanded)","detail.leafCut":" (too many arguments; not all expanded)","detail.nestedTooDeep":"(arguments nested too deeply; not expanded)","detail.argsUncaptured":"⚠ Arguments for this call were NOT captured: the plugin never received them, so this record has no operation to show — approving means allowing an operation whose content you did not see.","detail.sandbox":"Sandbox","detail.justification":"Model justification","detail.pipe":"Pipeline","detail.keyword":"Keyword","detail.judgeModel":"Judge model","detail.judgeCategory":"Category","detail.judgeAction":"Action","detail.judgeLevel":"Risk level","detail.levelFallback":" (fallback)","detail.judgeSrc":"Verdict source","detail.judgeReason":"Judge reason","detail.judgeError":"Judge error","detail.judgeRaw":"Judge raw output","detail.source":"Source","detail.judgeFailed":"judgment failed (no verdict → always asks a human)","approval.autoVerdict":"Machine verdict: ","set.title":"Auto-approve","set.intro":"Calls that need approval go to the judge model (allow / reject match the Web buttons); anything uncertain goes back to the original human dialog. Full details are in the README.","set.allowlistCorrupt":"The rules file is corrupt. This process is using in-memory defaults and will not overwrite the disk. Repair allowlist.json, or Restore defaults to write shipped rules.","set.pluginCorrupt":"Plugin config is corrupt; saves are refused so the judge model is not wiped. Repair ~/.dsh/auto-approve/config.json, or ","set.pluginCorruptOverwrite":"Overwrite corrupt config","set.loading":"Loading…","set.loadFailed":"Failed to load: {error}","set.resetConfirm":"Click again to confirm restore","set.presetMissingTitle":"Permission preset","set.driftTitle":"Permission preset table needs updating","set.driftBody":"The shipped permission table has new presets: {keys}. A patch replaces the permission config wholesale, so they will not appear automatically. Update the plugin or merge that row by hand.","set.presetMissingSub":"Startup writes auto-approve. It was not detected; you can write it now.","set.presetWrite":"Write permission preset","set.presetWriteNote":"Restart dsh web after writing","set.presetWrote":"Written. Restart dsh web","set.modeTitle":"Auto-approve mode","set.modeWs":"Workspace write (recommended)","set.modeWsHint":"In-workspace writes skip approval; outside the workspace still goes through the judge.","set.modeRo":"Read-only","set.modeRoHint":"In-workspace writes also go through the judge.","set.modeHint":"Clicking a mode writes it; restart dsh web and re-select Auto-approve.","set.save":"Save","set.hotOk":"Applied (live; no restart)","set.modeSaved":"Written. Restart dsh web and re-select Auto-approve or start a new session","set.overview":"Approval overview","set.overviewSub":"Order: reject keywords → arguments not captured (always rejected) → human keywords → the gate (call not visible) → allow keywords → judge model; a judgment that never ran always asks a human.","set.stepKeywords":"Keywords","set.stepCriteria":"Criteria","set.stepJudge":"Judge model","set.counts":"3 cells: rej {reject} · hum {human} · all {allow}","set.kwCounts":"rej {reject} · hum {human} · all {allow}","set.criteriaCount":"{n} rows","set.followDefault":"Follow default","set.unconfigured":"Not configured","set.kwSub":"Matches tool name, command, path, workdir, and the arguments of custom tools; written contents and numeric/boolean switches are not visible — only the judge model sees those.","set.empty":"None","set.presetTag":"Shipped","set.kwEditTitle":"Click to edit","set.kwPlaceholder":"New keyword","set.add":"Add","set.resetKeywords":"Restore default keywords","set.resetKeywordsOk":"Default keywords restored","set.confirm":"Confirm","set.delete":"Delete","set.criteriaSub":"The judge sees only the id and description (state when to pick this id); use an English id — it is shown in the approval history.","set.descPlaceholder":"Description (when to pick this id)","set.criterionOtherNote":"Cannot be deleted; description and cells are editable like any other row","set.resetCriteriaZh":"Restore Chinese default criteria","set.resetCriteriaEn":"Restore English default criteria","set.resetCriteriaOk":"Restored {lang} default criteria","set.addCriterion":"Add criterion","set.criteriaLangNote":"Restoring defaults also switches the prompt language","set.levelsTitle":"Risk levels","set.levelsSub":"All three descriptions go into the prompt.","set.levelFallback":"When the level is unreadable, use:","set.levelFallbackHint":"Used when the model omits the level or returns a word outside the vocabulary: a high fallback rejects such calls, low allows them.","set.levelDescPlaceholder":"Level description (what counts as this level)","set.resetLevelsZh":"Restore Chinese default levels","set.resetLevelsEn":"Restore English default levels","set.resetLevelsOk":"Restored {lang} default level descriptions","set.truncatedAction":"Over the judge limit / guard hit:","set.humanReviewTitle":"Model-initiated human review","set.humanReviewSub":"Every auto-approve rejection tells the model why and lets it escalate that call to a human; an approval covers one retry with identical arguments.","set.humanReviewWarn":"Enabling this turns the approval dialog into a channel the model can trigger on its own (including while driven by untrusted content). Off by default.","set.humanReviewEnable":"Let the model request human review","set.humanReviewTool":"Tool name:","set.humanReviewToolHint":"Renaming takes effect after a dsh web restart.","set.humanReviewLang":"Notice language:","set.humanReviewOn":"Enabled","set.humanReviewOff":"Disabled","set.humanReviewSaved":"Human-review settings saved","denyReason.keyword":"red-line keyword","denyReason.criterion":"criteria table verdict","denyReason.payload-truncated":"the judge request exceeded its limit","denyReason.payload-uncaptured":"the arguments were not captured (plugin-side capture failure)","denyReason.judge-empty":"judge model produced no output","denyReason.judge-timeout":"judge model timed out","denyReason.judge-call":"judge model call failed","denyReason.judge-route":"no judge route available","denyReason.judge-unparsed":"judge output could not be classified","denyReason.plugin-error":"approval plugin errored","verdict.human-grant":"Retry allowed after approval","path.human-grant":"Retry allowed after approval","verdict.human-review":"Model-requested human review","path.human-review":"Model-requested human review","set.criterionId":"id","set.judgeTitle":"Judge model","set.judgeSubLead":"Empty follows the deployment default","set.judgeSubFallback":" ({provider} / {model})","set.judgeSubNoFallback":" (no default to follow)","set.followProvider":"Follow default provider","set.followModel":"Follow default model","set.modelDefaultEffort":"Model default","set.judgeProviderLabel":"Provider","set.judgeModelLabel":"Model","set.judgeEffortLabel":"Reasoning","set.judgeTimeoutMs":"Judge timeout (ms):","set.judgeRequestBudget":"Judge request limit (characters):","set.judgeRequestBudgetHint":"Measures the whole request (prompt + card); past it the call follows the action below — content is never cut in half for the judge.","set.judgeMaxTokens":"Output budget (tokens):","set.judgeMaxTokensHint":"First-attempt cap when the route may reason, default 8192; too small and reasoning eats the budget → empty output → one wasted retry. A cap is not a reservation, so a generous value costs no extra time; routes without reasoning stay at 256.","set.judgeSelftest":"Test judgment","set.judgeSelftestBusy":"Testing…","set.judgeSelftestOk":"Judged: {ms}ms · category {category} · {chars} chars of text","set.judgeSelftestOkRetry":"Judged after a bigger retry budget: {ms}ms · category {category} · {chars} chars of text","set.judgeSelftestFail":"Judgment failed: {detail}","set.judgeHealthWarn":"{n} judgments this run went to a human because the judge model produced no text (reasoning consumed the output budget); the bigger retry budget saved {ok} of the retries. If it keeps happening, switch to a judge model that does not think — see the README.","err.judgeRequestBudgetRange":"The judge request limit must be between 8192 and 1000000","err.judgeMaxTokensRange":"The output budget must be between 256 and 32768","set.judgeSaved":"Judge settings saved","set.judgeLangZh":"Chinese","set.judgeLangEn":"English","set.judgePrompt":"Judge prompt","set.judgePromptLang":"Current language: {lang}","set.judgePromptHint":"{{criteria}} / {{levels}} are the insertion points; saved with the judge model.","set.langByRestore":"The language is chosen when you restore defaults.","set.judgePromptCustom":"Custom","set.judgePromptUnsaved":"Unsaved","set.judgePromptDefault":"Default","set.resetJudgePromptZh":"Restore Chinese default prompt","set.resetJudgePromptEn":"Restore English default prompt","set.resetJudgePromptOk":"Restored {lang} default prompt","set.overwriteOk":"Corrupt plugin config overwritten","err.missingPayloadUncaptured":"Tool arguments were not captured","err.truncatedPayload":"Judge request exceeded its limit (never judge what was not fully seen)","err.pluginError":"Plugin error","err.allowlistCorrupt":"Rules file is corrupt; refusing to overwrite. Restore defaults or fix allowlist.json on disk.","err.allowlistWrite":"Failed to write allowlist","err.criterionNotFound":"Criterion not found","err.criterionNeedId":"An English id is required (letters, digits, -, _)","err.criterionNeedDesc":"A description is required: state when to pick this id","err.criterionIdExists":"id already exists","err.criterionOtherLocked":"“Other” cannot be deleted","err.criteriaOp":"Criteria accept add / set / remove / reset","err.criterionLevel":"A cell action must be allow, reject, or human","err.levelNeedDesc":"The level description cannot be empty","err.levelFallback":"The fallback level must be low, medium, or high","err.levelNotFound":"No such risk level","err.levelsOp":"Risk levels accept set / reset","err.invalidAction":"Must be human or reject","err.opMustSet":"{kind} only accepts set","err.invalidNumber":"Invalid number","err.keywordEmpty":"Keyword cannot be empty","err.keywordNotFound":"Keyword not found","err.keywordsOp":"Keywords accept add / set / remove / reset","err.valueEmpty":"Value cannot be empty","err.unknownKind":"Unknown rule kind: {kind}","err.unknownOp":"Unknown operation: {op}","err.ruleNotFound":"No matching rule","err.badBody":"Request body is not JSON","err.needSessionId":"sessionId is required","err.pluginCorrupt":"Plugin config is corrupt; refusing to overwrite. Fix the file on disk, or overwrite the corrupt config.","err.pluginWrite":"Failed to write plugin config","err.unknownEndpoint":"Unknown endpoint: {endpoint}","err.internal":"Internal error: {error}","err.catalog":"Could not list models: {error}","err.info":"Could not load model info: {error}","err.judgeUnconfigured":"Judge model is not configured","err.judgeEffort":"reasoningEffort {effort} is not supported","err.judgeTimeout":"Judge timed out ({ms}ms)","err.judgeRetryTimeout":"Judge retry timed out ({ms}ms)","err.judgeFailed":"Judge failed","err.judgeCall":"Judge call failed: {error}","err.judgeEmpty":"Judge output was empty","err.judgePromptTooLong":"Custom prompt is too long ({chars} / limit {max} characters). It is not saved truncated: trim it yourself, or the output-format and level requirements at the tail will be lost.","err.judgeUpstream":"Judge route failed: {error}","err.noPresetsKey":"The permission entry has no presets key; add it manually","err.preset":"Failed to write preset: {error}","err.presetSandboxMissing":"The preset has no sandbox line; cannot set the sandbox mode. Check the profile cordis.patch.yml","err.presetSandbox":"The sandbox mode must be read-only, workspace-write, or danger-full-access (the given value is unknown)","rpc.unavailable":"connection.rpc is unavailable","rpc.failed":"RPC failed"}`)

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

    /**
     * 判决标签。**空 verdict 返回空串**，由调用点决定怎么兜底（通知条/历史行各有各的默认词）。
     *
     * 曾经这里直接返回「自动放行」，于是两个**拒绝分支**里的 `|| t('notice.rejectedDefault')`
     * 成了死代码：一条没有 `verdict` 的自动拒绝行会按「已拒绝」渲染（红底 ✕、标题「已拒绝：…」），
     * 标签却写「自动放行」，自相矛盾（第 9 轮 DOM 走查的复现：`ab-notice-card-err` + 标签「自动放行」）。
     */
    function verdictLabel(t, verdict) {
      if (!verdict) return ''
      return lookupLabel(t, 'verdict', verdict) || lookupLabel(t, 'path', verdict) || String(verdict)
    }

    /** 闭集拒绝原因（与事件的 `denyReason`、回传模型的那句同源）。 */
    function denyReasonLabel(t, code) {
      return lookupLabel(t, 'denyReason', code) || ''
    }

    function pathLabel(t, path) {
      return lookupLabel(t, 'path', path) || lookupLabel(t, 'verdict', path) || (path ? String(path) : '')
    }

    function actionLabel(t, action) {
      return lookupLabel(t, 'action', action) || (action ? String(action) : '')
    }

    /**
     * 风险等级一律**原样显示 id**（`low` / `medium` / `high`），不做本地化。
     *
     * 等级 id 是**模型契约**的一部分：提示词里的定义行是 `- low：说明`、模型要输出 `风险等级: low`、
     * 审计行是 `level=low`、文件里是三格 `actions.low`。把它显示成「低」，用户改这一档说明时就得
     * 自己把「低」映射回 `low`，出问题看审计时还要再映射一次。
     * 动作 id（`allow`/`reject`/`human`）不一样：它只活在 allowlist 内部，从不进提示词、也不出现在
     * 模型输出里，所以本地化成「允许 / 拒绝 / 人工」没有代价（`actionLabel` 保持不变）。
     */
    function levelLabel(t, level) {
      return level ? String(level) : ''
    }

    function srcLabel(t, src) {
      return lookupLabel(t, 'src', src) || (src ? String(src) : '')
    }

    function sandboxLabel(t, mode) {
      return lookupLabel(t, 'sandbox', mode) || (mode ? String(mode) : '')
    }

    function sourceLabel(t, source) {
      return lookupLabel(t, 'source', source) || (source ? String(source) : '')
    }


    function countsLabel(t, reject, human, allow, key) {
      return t(key || 'set.counts', { reject: String(reject), human: String(human), allow: String(allow) })
    }

    // 动作下拉统一顺序：拒绝 > 人工 > 允许，与管道优先级和关键词列表的分组一致。
    // （两项的动作选择器如 truncatedAction 保持「默认项在前」，那是另一种语义。）
    function actionOptions(t) {
      return ['reject', 'human', 'allow'].map(function (a) {
        return React.createElement('option', { value: a, key: a }, t('action.' + a))
      })
    }

    /**
     * 这次自动判定是不是「拒绝」。**不能只看 verdict 后缀**：`truncated-payload`（超预算 /
     * 撞收集护栏）与 `plugin-error` 既可能拒绝也可能放行——按后缀判会把一次真拒绝渲染成绿色的
     * 「自动放行 · …」。事件的 `outcome` 是宿主显式落下的结局，`denyReason` 是闭集拒绝原因
     * （宿主只对拒绝类事件写它）；0.3.0 之前的记录没有这两个字段，才回落到后缀判据。
     */
    function isAutoReject(ev) {
      const e = ev && typeof ev === 'object' ? ev : { verdict: ev }
      if (e.outcome) return e.outcome === 'rejected'
      if (e.denyReason) return true
      const v = String(e.verdict || '')
      return v === 'keyword-reject' || v === 'criteria-reject' || /-reject$/.test(v)
    }

    function eventPreview(ev) {
      const a = (ev && ev.args) || {}
      const known = a.command || a.file_path || a.path || a.code || a.url || a.script || a.sql || a.prompt || a.description
      if (known) return known
      // 自定义工具（MCP）的参数名认不出：预览不能空着，否则条子上只剩理由一句话。
      const generic = Object.keys(a).filter(isExtraArgKey).sort().map((k) => a[k]).filter((v) => typeof v === 'string' && v)[0]
      return generic || ev.justification || ev.reason || ''
    }

    /**
     * 原生审批框那一行详情的内容。**本插件接管了这个槽位**（见 `apply` 里的注册）：
     * DSH 自带的 `ApprovalCommand` 只读那次调用的顶层 `args.command`，于是 `write` / `edit` /
     * MCP 这类没有 `command` 的越权审批，人只看到一句「某工具要审批」——路径、内容、参数
     * 一个都看不见，却要决定放不放行。
     *
     * 口径与宿主侧 `formatReviewOperation` 一致（两处不能 import，只能各自实现）：
     * 命令优先 → 没有命令就按参数名列出前几个；**截断必须说出来**（总字数 / 还剩几个参数）。
     * 解析不出对象就返回 null（渲染不出来就不渲染，别抛进别人的 UI）。
     */
    /**
     * 已知参数名的**显示顺序**：与宿主 `rules.mjs` 的 `TOOL_ARG_KEYS` 逐项同序（两处不能
     * 互相 import，只能各自维护，改一处要同步另一处）。宿主把投影按这个顺序拍平，所以
     * 客户端按同一顺序取「前 4 个」才对得上模型看到的卡片。
     */
    const DETAIL_KEY_ORDER = [
      'command', 'file_path', 'path', 'old_string', 'new_string', 'content', 'description', 'workdir',
      'code', 'url', 'query', 'script', 'sql', 'prompt', 'input', 'text', 'body', 'message', 'pattern', 'selector',
    ]

    function approvalDetailText(argsRaw, max, t) {
      const limit = Number(max) > 0 ? Number(max) : 600
      // 文案走字典（网页文案源是 locales.mjs）：英文界面下不能出现「（共 N 字；尾部：…）」。
      // 没传 `t` 时按 zh 渲染（测试与旧调用点）。
      const tr = typeof t === 'function' ? t : function (key, params) { return fillLocale(ZH[key] || key, params) }
      let args
      try {
        args = JSON.parse(String(argsRaw == null ? '' : argsRaw))
      } catch (e) {
        return null
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return null
      const oneLine = function (value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
      }
      const clipped = function (value, budget) {
        const cap = typeof budget === 'number' && budget > 0 ? budget : limit
        const text = oneLine(value)
        if (text.length <= cap) return text
        // 取整方式必须与宿主 `formatReviewOperation` 的 `clipped` 一致（`Math.floor`）：
        // `Math.round` 会让头/尾各差一个字符，同一份参数在原生详情行与复核框里显示不同文本
        //（2 万组随机对拍里 1017 组分歧，全是这个原因）。
        const head = text.slice(0, Math.max(1, Math.floor(cap * 0.6)))
        const tail = text.slice(-Math.max(1, Math.floor(cap * 0.2)))
        return head + '…' + tr('detail.truncated', { n: text.length, tail: tail })
      }
      /**
       * 本插件自己发的复核请求：那次调用的参数是 `{ tool, arguments, justification }` 包装层，
       * 详情行要显示的是**被复核的操作本身**，不是包装（否则是 `arguments.command:` 这种噪声，
       * 而 headline 已经写了「操作：…」）。判据收紧到「恰好这三个键」，免得误伤同形参数的普通工具。
       */
      const wrapped = args.arguments
      const wrapKeys = Object.keys(args)
      if (typeof args.tool === 'string'
        && wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
        && wrapKeys.length === 3
        && wrapKeys.indexOf('tool') !== -1 && wrapKeys.indexOf('arguments') !== -1 && wrapKeys.indexOf('justification') !== -1) {
        args = wrapped
      }
      // 命令优先。`justification` 是模型自己的说辞（不是操作本体），与宿主侧卡片同一口径排除。
      // 与宿主投影同一个口径：数字/布尔 `command` 在宿主那边已经被 `scalarToText` 收成文本进
      // 命令位（`{command:true}` → `true`），客户端拿的是**原始**参数，不补齐就会一边显示命令、
      // 另一边显示参数表（实测 470/20000 组输入不一致）。空/纯空白仍不算命令——`clipped('')`
      // 会返回空串，详情行整行消失（负 priority 遮蔽了 DSH 自带那一行，人什么都看不到）。
      const commandKind = typeof args.command === 'string'
        ? 'text'
        : ((typeof args.command === 'number' && Number.isFinite(args.command)) || typeof args.command === 'boolean' ? 'scalar' : 'none')
      const commandValue = commandKind === 'text' ? args.command : (commandKind === 'scalar' ? String(args.command) : '')
      // 顶层有命令位（哪怕为空）时宿主**不会**再提升嵌套的 `*.command`（它只按投影里那个
      // `command` 键取值）：客户端继续全树搜会把 `{command:'', script:{command:'325'}}` 压成
      // 「325」——同一份参数两种「操作」摘要，还把其它参数挤掉。
      const mayPromoteNested = commandKind === 'none'
      // 拍平嵌套（MCP 常把参数包在 params/arguments 里），叶子取标量。
      //
      // 叶子清单必须**先算**：命令位的「另有 N 个参数」披露要用同一份清单（含嵌套拍平），
      // 否则宿主披露 `path.aa: /p` 而客户端只披露顶层标量——同一份参数两种摘要。
      //
      // 深度上限是**护栏**而不是口径（宿主侧 `pickToolArgsDetailed` 没有上限、靠字节护栏）：
      // 超过就把省略**写出来**，绝不静默少印——`{query:{filter:{term}}}` 这类调用宁可多一行说明。
      const leaves = []
      const usedKeys = Object.create(null)
      let depthCut = false
      let leafCut = false
      // 叶子上限是**护栏**而不是口径，撞到就写出来（`detail.leafCut`），绝不静默少印。
      const MAX_LEAVES = 500
      const push = function (key, value, rank) {
        // 撞车键要带 `#2` 后缀另起一格（宿主投影是这么做的）：裸键名会让两行同名、读者分不清
        // 哪一行是哪个参数。
        // `__proto__` 与宿主投影同名（`keep()` 会改名成 `__proto__#raw`）：同一次调用
        // 两处显示同一个名字，人才不会以为是两个参数。
        let slot = key === '__proto__' ? '__proto__#raw' : key
        let n = 1
        while (usedKeys[slot]) { n += 1; slot = (key === '__proto__' ? '__proto__#raw' : key) + '#' + n }
        usedKeys[slot] = true
        leaves.push({ key: slot, value: value, rank: rank === undefined ? -1 : rank })
      }
      const walk = function (node, path, depth) {
        if (!node || typeof node !== 'object') return
        if (depth > 4) { depthCut = true; return }
        // 键序与宿主**投影**同源（两处不能互相 import）：顶层字符串键按 `TOOL_ARG_KEYS`
        // 的顺序在前，其余（嵌套叶子、未知键、非字符串值）按原始键序在后——只按自己的优先表
        // 排序会让「前 4 个」选中与卡片不同的参数。
        const keys = Object.keys(node)
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          if (key === 'justification') continue
          const value = node[key]
          const full = path ? path + '.' + key : key
          if (value && typeof value === 'object') { walk(value, full, depth + 1); continue }
          if (value === null || value === undefined || typeof value === 'function') continue
          if (leaves.length >= MAX_LEAVES) { leafCut = true; return }
          const rank = !path && typeof value === 'string' ? DETAIL_KEY_ORDER.indexOf(key) : -1
          push(full, String(value), rank)
        }
      }
      walk(args, '', 0)
      /**
       * 分两桶（与宿主投影一致）：顶层字符串键按 `TOOL_ARG_KEYS` 序、其余按原顺序。
       * 用稳定排序 + 原始下标做次级键，桶内保持 `Object.keys` 的顺序。
       */
      leaves.forEach(function (leaf, i) { leaf.i = i })
      leaves.sort(function (a, b) {
        const ra = a.rank === -1 ? Number.MAX_SAFE_INTEGER : a.rank
        const rb = b.rank === -1 ? Number.MAX_SAFE_INTEGER : b.rank
        return ra === rb ? a.i - b.i : ra - rb
      })
      /**
       * 命令 + **其余叶子全部交代**：凭证按完整参数投影签发，只印命令等于让人替看不见的字段签字
       * （实测 `{command:'echo ok', file_path:'/etc/shadow', content:'SECRET'}` 只显示「操作：echo ok」）。
       * 披露用的就是上面那份叶子清单（与参数表同一口径，含嵌套拍平）；命令让出小半预算，
       * 放不下时至少说出数量。`excludeKey` 是被提到命令位的那片叶子（顶层 `command` 或某个 `*.command`）。
       */
      const clip60 = function (value) {
        const text2 = oneLine(value)
        return text2.length > 60 ? text2.slice(0, 59) + '…' : text2
      }
      const withDisclosure = function (headText, excludeKey) {
        const others = leaves
          .filter(function (leaf) { return leaf.key !== excludeKey })
          .map(function (leaf) { return leaf.key + ': ' + clip60(leaf.value) })
        if (!others.length) return clipped(headText)
        const tailFor = function (count, restCount) {
          return count > 0
            ? tr('detail.alsoArgs', { n: others.length, list: others.slice(0, count).join('；'), rest: restCount > 0 ? tr('detail.alsoMore', { n: restCount }) : '' })
            : tr('detail.alsoArgsHidden', { n: others.length })
        }
        /**
         * **整条（命令 + 披露）必须 ≤ limit**：详情行是唯一的展示位，而披露在尾巴上——命令一长，
         * 被切掉的正好是「另有 N 个参数」这句（实测 595 字命令 + 2 个参数 = 608 字，尾巴被截掉），
         * 人就会以为命令之外没有别的参数。从「列出最多参数」往回收，取第一个放得下的组合。
         * 宿主 `formatReviewOperation` 同一形状、同一改法（两处不能互相 import）。
         */
        for (let count = others.length; count >= 0; count--) {
          const tail = tailFor(count, others.length - count)
          const room = limit - tail.length - 24
          if (room < 24) continue
          return (clipped(headText, room) + tail).replace(/[ \t]+$/, '')
        }
        return clipped(headText)
      }
      if (commandValue.trim() !== '') return withDisclosure(commandValue, 'command')
      // 嵌套里的命令也是命令：MCP 习惯把参数包一层（`params.command`），宿主侧
      // `formatReviewOperation` 明确做这个提升（两处口径必须一致），这里同样优先显示它，
      // 否则正文一长，命令就会被挤出「只列前 4 个」那一截——人看不到自己要批准的命令。
      // 只认**真正嵌套**的命令（`params.command` 这种），且按宿主同一个取法：键名排序取第一个
      // （`Object.keys(a).filter(k => k.endsWith('.command')).sort()[0]`）。顶层 `command` 在
      // 上面已经处理过——把它也算进来时，空串会被「提升」成空详情行，原生框里人什么都看不到。
      const nestedCommand = mayPromoteNested
        ? leaves
          .filter(function (leaf) { return /\.command$/.test(leaf.key) })
          .sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0) })[0]
        : undefined
      if (nestedCommand && nestedCommand.value.trim() !== '') return withDisclosure(nestedCommand.value, nestedCommand.key)
      if (!leaves.length) {
        return depthCut ? tr('detail.nestedTooDeep') : null
      }
      const shown = leaves.slice(0, 4)
      // 与宿主同一个口径：宿主把整串过 `oneLine`（折叠空白 + trim），所以 `key: ` 后面没有值时
      // 那行末尾不留空格；这里逐行去掉行尾空白（`white-space: pre-line` 下不可见，但两处文本要能逐字对拍）。
      const text = shown.map(function (leaf) {
        const value = oneLine(leaf.value)
        const cut = value.length > 80 ? value.slice(0, 79) + '…' : value
        // 空值的行印成 `key:`（不留行尾空格）——宿主对空值是同一个形状，两侧除分隔符外逐字一致。
        return (leaf.key + ': ' + cut).replace(/[ \t]+$/, '')
      }).join('\n')
      const more = leaves.length - shown.length
      const suffix = (more > 0 ? tr('detail.argsFirst', { n: leaves.length, shown: shown.length }) : '')
        + (depthCut ? tr('detail.depthCut') : '')
        + (leafCut ? tr('detail.leafCut') : '')
      // 注意：这里**不能**过 `clipped()`——它的 `oneLine` 会把换行折成空格，多行参数表就没了。
      // 每个值已经单独单行化并裁剪过，这里只在整体超长时按字裁并交代总量。
      // **披露先占预算**，剩下的才是参数表的：裁到哪儿、报多少字都必须与宿主逐字一致
      // （宿主在同一份换行连接的规范字符串上算，只是显示时把换行换成 ` · `）。
      const room = Math.max(0, limit - suffix.length)
      if (text.length > room) {
        const head = text.slice(0, Math.max(1, Math.floor(room * 0.6)))
        const tail = text.slice(-Math.max(1, Math.floor(room * 0.2)))
        return head + '…' + tr('detail.truncated', { n: text.length, tail: tail }) + suffix
      }
      return text + suffix
    }

    /**
     * 事件行 → 「自动判定：…」那一行（审批框里给**人**看的）。
     *
     * 人是在接手/覆盖一个机器决定，得知道机器为什么。原生越权那条路的标题由请求方给、
     * 插件不能改 `req`，所以这一行挂在详情行下：`keywords 转人工（命中的词）` /
     * `审核表转人工 · 中` / `判定失败转人工` / `内容超过送审上限`。
     * 事件里没有可用判定就返回空串（那就不写这一行，宁可少一句也不瞎写）。
     */
    function verdictLineFromEvent(t, ev) {
      const e = ev && typeof ev === 'object' ? ev : null
      if (!e) return ''
      const path = String(e.path || e.verdict || '')
      if (!path) return ''
      // 复核框（模型主动求的那次）没有「机器的判定」可言：它的标题已经写清是模型求的复核，
      // 再写一行「自动判定：模型请求人工复核」就是自指噪声。
      if (path === 'human-review') return ''
      // **判定压根没跑成**（src ∈ empty/timeout/call/route/plugin）时宿主走的仍是 criteria-human，
      // 只按 path 出标签会显示成「审核表转人工」——人就看不出「模型一个字都没答」。
      // 这条判据必须与宿主 `JUDGE_FAILURE_SRCS` 一致（两处不能互相 import，改一处要同步另一处）。
      const src = String(e.src || '')
      const failed = ['empty', 'timeout', 'call', 'route', 'plugin'].indexOf(src) !== -1
      const label = failed ? (verdictLabel(t, 'judge-failed') || path) : (verdictLabel(t, path) || path)
      // 等级可能在顶层（pending 行）或 `judge` 里（自动判定行）；历史行只有 `judge.level`。
      const level = failed ? '' : (e.level || (e.judge && e.judge.level) || '')
      const keyword = failed ? '' : String(e.keyword || '')
      return t('approval.autoVerdict') + label
        + (level ? ' · ' + levelLabel(t, level) : (keyword ? '（' + keyword + '）' : ''))
    }

    /**
     * `sessionId:callId` → 那一行（进程内缓存：审批框每次挂载只查一次；有界）。
     * **键必须带会话**：`callId` 只在会话内唯一，宿主自己的暂存映射也用
     * `sessionId:callId`（「避免多会话共用 call-0 互相覆盖」）；只按 callId 键控时，
     * 另一个会话出现同 id 就会把别人的旧判决显示成本次判定，而且命中缓存后不再发查询。
     */
    const approvalVerdictCache = new Map()
    const verdictCacheKey = function (sessionId, callId) {
      return String(sessionId || '') + ':' + String(callId || '')
    }

    /**
     * 原生审批框的详情行。注册在 `conversation.approval.detail` 上、priority 取负值
     * （同 priority 会报冲突，换 priority 则遮蔽，**越低越先渲染**），因此这里同时接管了
     * 原来由 ui-chat 渲染的 bash 命令那一行：查不到那次调用就返回 null（与原来一致的降级）。
     */
    function ApprovalDetail(props) {
      const sp = (props && props.slotsProps) || {}
      const callId = sp.callId
      const useChat = sp.useChat
      const rpc = props && props.rpc
      const t = props && props.t
      // 判决那一行：按 callId 查一次事件（宿主侧 `events` 接口支持 callId 过滤），存进缓存。
      // 查不到/失败就不写那一行——审批本身不受影响。
      const frame = resolveFrame(sp)
      const cacheKey = verdictCacheKey(frame.sessionId, callId)
      const [verdict, setVerdict] = React.useState(function () {
        return (callId && approvalVerdictCache.get(cacheKey)) || ''
      })
      React.useEffect(function () {
        if (!callId || typeof rpc !== 'function') return undefined
        if (approvalVerdictCache.has(cacheKey)) return undefined
        if (!frame.sessionId) return undefined
        let alive = true
        rpc('events', { sessionId: frame.sessionId, callId: callId }).then(function (data) {
          const rows = (data && data.events) || []
          const line = verdictLineFromEvent(t, rows[rows.length - 1])
          approvalVerdictCache.set(cacheKey, line)
          while (approvalVerdictCache.size > 32) {
            const oldest = approvalVerdictCache.keys().next()
            if (oldest.done) break
            approvalVerdictCache.delete(oldest.value)
          }
          if (alive) setVerdict(line)
        }).catch(function () { /* 查不到就不写那一行 */ })
        return function () { alive = false }
      }, [cacheKey, callId, rpc])
      // `useChat` 是会话级标准 props、审批框也只在 `callId` 存在时才渲染这个槽位，两者在一次挂载里
      // 不会忽有忽无；但 hook 的调用**必须**保持在同一条路径上（不能因为 `callId` 缺失就提前 return），
      // 否则同一实例两次渲染的 hooks 数量不同。判空一律放进选择器里。
      const text = (typeof useChat === 'function')
        ? useChat(function (snapshot) {
        if (!callId) return null
        try {
          const nodes = (snapshot && snapshot.nodes) || null
          if (!nodes || typeof nodes.values !== 'function') return null
          for (const node of nodes.values()) {
            if (!node || node.kind !== 'tool-call') continue
            const root = node.data && node.data.root
            if (!root || root.callId !== callId) continue
            if ('kind' in root) continue
            return approvalDetailText(root.argsRaw, 600, t)
          }
        } catch (e) {
          return null
        }
        return null
        })
        : null
      if (!text && !verdict) return null
      return React.createElement('span', { className: 'ab-approval-detail' },
        text || null,
        text && verdict ? '\n' : null,
        verdict || null,
      )
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

    /**
     * `notice` 是**整段**的说明（例如「这次调用的参数没采集到」），必须单独成行。
     * 曾经把它当 `emptyText` 传进来，于是它会被贴到**任何值为空字符串的那一行**上
     * （`Detail()` 里 `emptyText` 的语义是「这一格空着时显示什么」）——要么显示在
     * 「模型理由」这种不相干的标签下面，要么整条不显示。整段告警与单元格占位符是两件事。
     */
    function DetailSection(title, items, emptyText, notice) {
      const kids = []
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        if (!row) continue
        const node = Detail(row[0], row[1], emptyText)
        if (node) kids.push(node[0], node[1])
      }
      if (!kids.length && !notice) return null
      return React.createElement('div', { className: 'ab-detail-sec' },
        React.createElement('div', { className: 'ab-detail-h' }, title),
        notice ? React.createElement('div', { className: 'ab-detail-warn' }, notice) : null,
        kids.length ? React.createElement('div', { className: 'ab-detail-grid' }, kids) : null,
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
      } else if (kind === 'manual-rejected' || isAutoReject(notice)) {
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
      const autoReject = isAutoReject(notice)
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
              React.createElement('span', { className: isPending || kind === 'manual-approved' || kind === 'manual-cancelled' || kind === 'manual-unavailable' ? 'ab-tag-warn' : (kind === 'manual-rejected' || autoReject || kind === 'feed-error') ? 'ab-tag-err' : 'ab-tag' }, tagText),
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
            } else if (isAutoReject(ev)) {
              glyph = React.createElement('span', { className: 'ab-notice-glyph-err' }, '✕')
              tag = verdictLabel(t, ev.verdict) || t('notice.rejectedDefault')
              tagCls = 'ab-tag-err'
            } else {
              tag = verdictLabel(t, ev.verdict) || t('history.tagAuto')
            }
            const open = openId === ev.id
            const args = ev.args || {}
            const j = ev.judge || {}
            // 自定义工具（MCP）的参数名不在上面那张表里：只在下面另有专门行的键（`params.command`
            // 这类已知名的嵌套键）才跳过，其余通用键原样显示，否则历史里看不见判的是什么。
            // 通用参数行：条数不设「静默上限」——被吞掉的键在页面上没有任何痕迹，
            // 于是留一行「还有 N 个字段」（事件存档本身另有字符预算，见宿主 argsOmitted）。
            // 通用参数键由 `detailExtraKeys` 统一给（它知道哪一组里哪个键占了专门行、
            // 哪些落选的要补一行）。**别在这里内联判断**：内联逻辑只覆盖 file_path/path 一对，
            // 而且会让测试盯着的函数与真正渲染的代码分叉。
            const extraKeys = detailExtraKeys(args)
            const shownKeys = extraKeys.slice(0, 50)
            const hiddenCount = extraKeys.length - shownKeys.length
            const extraArgRows = shownKeys.map((k) => [t('detail.arg') + ' ' + k, args[k]])
            if (hiddenCount > 0) extraArgRows.push([t('detail.arg'), t('detail.argsMore', { n: String(hiddenCount) })])
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
                        // 专用「路径」行只表示一个参数：`file_path` 与 `path` **同时**存在时，
                        // 另一个要在通用参数区里出现（否则 `/x` 在页面上完全消失——与「消失的参数」同族）。
                        // 专用「路径」行只表示一个参数；同组落选的另一个（`path`）由
                        // `detailExtraKeys` 放进通用参数区，不在这里内联补行。
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
                      ].concat(extraArgRows).concat([
                        [t('detail.argsOmitted'), ev.argsOmitted],
                      ]), t('detail.empty'), ev.argsCaptured === false ? t('detail.argsUncaptured') : null),
                      DetailSection(t('detail.audit'), [
                        [t('detail.pipe'), [pathLabel(t, ev.path) || ev.path, denyReasonLabel(t, ev.denyReason)].filter(Boolean).join(' · ')],
                        [t('detail.keyword'), ev.keyword],
                        [t('detail.judgeModel'), [j.provider, j.model, j.effort].filter(Boolean).join(' / ')],
                        [t('detail.judgeCategory'), j.failed
                          ? t('detail.judgeFailed')
                          : (j.criterion || ev.category || '')],
                        [t('detail.judgeAction'), actionLabel(t, j.action) || j.action],
                        [t('detail.judgeLevel'), j.level
                          ? (levelLabel(t, j.level) + (j.levelSrc === 'fallback' ? t('detail.levelFallback') : ''))
                          : ''],
                        [t('detail.judgeSrc'), srcLabel(t, ev.src || j.src)],
                        [t('detail.judgeReason'), codedText(t, j.reason || ev.judgeReason)],
                        [t('detail.judgeError'), formatErr(t, j.errorCode, { ms: j.errorMs || '', error: j.errorDetail || '', effort: j.errorEffort || '' })],
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
      const [newCriterion, setNewCriterion] = React.useState({
        id: '', description: '', actions: { low: 'human', medium: 'human', high: 'human' },
      })
      const [timeoutMs, setTimeoutMs] = React.useState('20000')
      const [judgeBudget, setJudgeBudget] = React.useState('20000')
      // 首轮输出预算（`judge.maxTokens`）。默认值必须与服务端 JUDGE_MAX_TOKENS_REASONING 一致——
      // client bundle 拿不到 Host 常量，所以这里写死 8192（区间同样写死 256..32768）。
      const [judgeMaxTokens, setJudgeMaxTokens] = React.useState('8192')
      const [models, setModels] = React.useState([])
      const [efforts, setEfforts] = React.useState([])
      // 列表加载失败以前被 catch 吞掉，下拉里只剩「跟随默认模型」，看不出是失败还是真没有模型。
      const [catalogError, setCatalogError] = React.useState(null)
      const [modelInfoError, setModelInfoError] = React.useState(null)
      const [judgeProvider, setJudgeProvider] = React.useState('')
      const [judgeModel, setJudgeModel] = React.useState('')
      const [judgeEffort, setJudgeEffort] = React.useState('')
      const [judgePromptLang, setJudgePromptLang] = React.useState('zh')
      const [judgePromptDrafts, setJudgePromptDrafts] = React.useState({ zh: '', en: '' })
      // 自检结果：{ running } | { value }（宿主回显的 finish/正文/耗时）| { error }
      const [selftest, setSelftest] = React.useState(null)
      const [presetSandbox, setPresetSandbox] = React.useState('workspace-write')
      const [hrOn, setHrOn] = React.useState(false)
      const [hrTool, setHrTool] = React.useState('request_human_approval')
      const [hrLang, setHrLang] = React.useState('zh')
      const [foldOpen, setFoldOpen] = React.useState({ keywords: false, criteria: false, levels: false })
      const [kwEdit, setKwEdit] = React.useState(null)
      const [resetArmed, setResetArmed] = React.useState(null)
      const feedbackTimerRef = React.useRef(null)
      const kwSkipBlurRef = React.useRef(false)
      React.useEffect(function () {
        return function () {
          if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
        }
      }, [])
      // 从快照播种本地编辑态。reseed 决定播哪一组：
      //   'all'   首次加载、覆盖损坏配置（服务端成了唯一真相）
      //   'judge' 保存审核设置 / 恢复默认提示词之后（服务端值刚被改写）
      //   'human' 模型转人工卡片写入之后（那三行控件靠快照回填）
      //   'none'  其余写入：只刷新快照，**绝不碰审核模型卡片里没保存的草稿**
      // 旧实现拿 keepEdits=false 表达「重载」，于是改一句提示词、再去点「模型转人工」的下拉
      // （或让工具名输入框失焦），没保存的提示词草稿会静默消失。
      const promptDraftsOf = function (data) {
        const shipped = (data.predefined && data.predefined.judgePrompts) || {}
        const custom = (data.plugin && data.plugin.judgePrompts) || {}
        const pick = function (lang) {
          const c = custom[lang]
          if (c && String(c).trim()) return String(c)
          return String(shipped[lang] || '')
        }
        return { zh: pick('zh'), en: pick('en') }
      }
      const seedJudge = function (data, onlyLang) {
        setTimeoutMs(String(data.config.judgeTimeoutMs))
        setJudgeBudget(String((data.plugin && data.plugin.judgeRequestBudget) || 20000))
        setJudgeMaxTokens(String((data.plugin && data.plugin.judge && data.plugin.judge.maxTokens) || 8192))
        setJudgeProvider((data.plugin.judge && data.plugin.judge.provider) || '')
        setJudgeModel((data.plugin.judge && data.plugin.judge.model) || '')
        setJudgeEffort((data.plugin.judge && data.plugin.judge.reasoningEffort) || '')
        const drafts = promptDraftsOf(data)
        // 只重播种指定的那一种语言：恢复英文默认提示词不该把没保存的中文草稿一起冲掉。
        setJudgePromptDrafts(function (prev) {
          if (!onlyLang) return drafts
          const next = Object.assign({}, prev)
          next[onlyLang] = drafts[onlyLang]
          return next
        })
      }
      const seedHumanReview = function (data) {
        const hr = (data.plugin && data.plugin.humanReview) || {}
        setHrOn(hr.enabled === true)
        setHrTool(String(hr.toolName || 'request_human_approval'))
        setHrLang(hr.noticeLang === 'en' ? 'en' : 'zh')
      }
      const seedSandbox = function (data) {
        setPresetSandbox((data.plugin && data.plugin.presetSandbox) === 'read-only' ? 'read-only' : 'workspace-write')
      }
      const load = function (opts) {
        const reseed = (opts && opts.reseed) || 'none'
        rpc('snapshot').then(function (data) {
          setSnapshot(data)
          if (reseed === 'all' || reseed === 'judge') seedJudge(data, opts && opts.reseedLang)
          if (reseed === 'all') seedSandbox(data)
          if (reseed === 'all' || reseed === 'human') seedHumanReview(data)
          // 提示词语言是服务端状态（设置页没有开关），任何一次刷新都跟随；
          // 中英草稿分开存，所以切语言不会丢掉另一份。
          setJudgePromptLang((data.plugin && data.plugin.judgePromptLang) === 'en' ? 'en' : 'zh')
          setError(null)
        }).catch(function (e) {
          setError(t('set.loadFailed', { error: String((e && e.message) || e) }))
        })
      }
      React.useEffect(function () { load({ reseed: 'all' }) }, [])
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
          setCatalogError(null)
        }).catch(function (e) {
          if (!alive) return
          setModels([])
          setCatalogError(String((e && e.message) || e))
        })
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
          setModelInfoError(null)
        }).catch(function (e) {
          if (!alive) return
          setEfforts([])
          setModelInfoError(String((e && e.message) || e))
        })
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
          load({ reseed: (opts && opts.reseed) || 'none', reseedLang: opts && opts.reseedLang })
          showFeedback(okMsg || t('set.hotOk'))
          return res
        }).catch(function (e) {
          showFeedback(String((e && e.message) || e), false)
        }).finally(function () { setBusy(false) })
      }

      if (!snapshot) {
        return React.createElement('div', { className: 'ab-set' },
          React.createElement('div', { className: error ? 'ab-set-err' : 'ab-set-muted' }, error || t('set.loading')))
      }

      const cfg = snapshot.config
      const setup = snapshot.setup || { configured: false }
      const predefined = snapshot.predefined || {}
      // 出厂词标记：拒绝桶与人工桶都算「预置」（恢复默认会写回，所以删除要二次确认）。
      const preShipped = new Set((predefined.rejectKeywords || []).concat(predefined.humanKeywords || []))
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

      const levelsCfg = cfg.levels || {}
      const levelsFallback = levelsCfg.fallback || 'high'
      const langName = function (lang) { return t(lang === 'en' ? 'set.judgeLangEn' : 'set.judgeLangZh') }
      const resetBtn = function (kind, idleLabel, onConfirm) {
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
            onConfirm()
          },
        }, armed ? t('set.resetConfirm') : idleLabel)
      }
      // 语言选项已取消：只有在「恢复默认」时选语言，选中的语言同时决定框架/卡片语言。
      const restoreCriteria = function (lang) {
        const ok = t('set.resetCriteriaOk', { lang: langName(lang) })
        return resetBtn('criteria-' + lang, t(lang === 'en' ? 'set.resetCriteriaEn' : 'set.resetCriteriaZh'),
          function () { run('rule-op', { op: 'reset', kind: 'criteria', value: { lang: lang } }, ok) })
      }
      const restoreLevels = function (lang) {
        const ok = t('set.resetLevelsOk', { lang: langName(lang) })
        return resetBtn('levels-' + lang, t(lang === 'en' ? 'set.resetLevelsEn' : 'set.resetLevelsZh'),
          function () { run('rule-op', { op: 'reset', kind: 'levels', value: { lang: lang } }, ok) })
      }
      const restorePrompt = function (lang) {
        const prompts = {}
        prompts[lang] = ''
        const ok = t('set.resetJudgePromptOk', { lang: langName(lang) })
        return resetBtn('judgePrompt-' + lang, t(lang === 'en' ? 'set.resetJudgePromptEn' : 'set.resetJudgePromptZh'),
          function () { run('save-plugin', { judgePromptLang: lang, judgePrompts: prompts }, ok, { reseed: 'judge', reseedLang: lang }) })
      }

      /**
       * 自检：让宿主拿固定的小卡片真跑一次判定。
       * 装插件的人第一个问题就是「我这套审核模型行不行」——等一次真实判定失败（然后弹人工框）
       * 才知道太晚了。这一步**不写入任何配置**，只是把 finish/正文/耗时回显出来。
       */
      const runSelftest = function () {
        setSelftest({ running: true })
        rpc('judge-selftest', {}).then(function (value) {
          setSelftest({ value: value || {} })
        }).catch(function (e) {
          setSelftest({ error: String((e && e.message) || e) })
        })
      }
      const selftestText = (function () {
        if (!selftest) return ''
        if (selftest.running) return t('set.judgeSelftestBusy')
        if (selftest.error) return t('set.judgeSelftestFail', { detail: selftest.error })
        const v = selftest.value || {}
        if (!v.ran || !v.ok) {
          const detail = [v.code || '', v.detail || ''].filter(Boolean).join(' ')
          return t('set.judgeSelftestFail', { detail: detail || t('err.judgeFailed') })
        }
        return t(v.retried ? 'set.judgeSelftestOkRetry' : 'set.judgeSelftestOk', {
          ms: String(v.ms === undefined ? '' : v.ms),
          category: String(v.category || ''),
          chars: String(v.bodyChars === undefined ? 0 : v.bodyChars),
        })
      })()
      const selftestState = selftest
        ? (selftest.running ? 'muted' : ((selftest.value && selftest.value.ok) ? 'ok' : 'fail'))
        : ''

      const saveJudge = function () {
        const n = Number(timeoutMs)
        if (!Number.isFinite(n) || n <= 0) {
          showFeedback(t('err.invalidNumber'), false)
          return
        }
        // 全局送审预算：8192..1000000，与服务端 JUDGE_REQUEST_BUDGET_MIN/MAX 同一区间。
        // 下限必须覆盖**英文**出厂框架（约 5.8k 字符，中文约 2.2k），否则每次判定都撞上限、
        // 审核模型一次都不会被调用；这里写死与服务端相同的数字（client bundle 拿不到 Host 常量）。
        const b = Number(judgeBudget)
        if (!Number.isFinite(b) || b < 8192 || b > 1000000) {
          showFeedback(t('err.judgeRequestBudgetRange'), false)
          return
        }
        // 首轮输出预算：256..32768，与服务端 JUDGE_MAX_TOKENS_MIN/MAX 同一区间。
        // 给少了推理会吃光预算 → 空输出 → 白跑一次重试（上限不是预扣，给足不会变慢）。
        const m = Number(judgeMaxTokens)
        if (!Number.isFinite(m) || m < 256 || m > 32768) {
          showFeedback(t('err.judgeMaxTokensRange'), false)
          return
        }
        // 不带 judgePromptLang：语言只由两个「恢复默认」动作决定，保存设置不该动它。
        run('save-plugin', {
          judge: { provider: judgeProvider, model: judgeModel, reasoningEffort: judgeEffort, maxTokens: Math.floor(m) },
          judgeTimeoutMs: n,
          judgeRequestBudget: Math.floor(b),
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
        }, t('set.judgeSaved'), { reseed: 'judge' })
      }

      return React.createElement('div', { className: 'ab-set', ref: rootRef },
        React.createElement('h3', { className: 'ab-set-title' }, t('set.title')),
        React.createElement('p', { className: 'ab-set-intro' }, t('set.intro')),
        // 刷新失败也要显示：`error` 以前只在「还没有快照」那条分支渲染，于是首次加载成功之后
        // 的每一次失败都被静默吞掉——页面继续显示旧快照 + 上一次的成功提示，用户以为一切正常。
        error
          ? React.createElement('div', { className: 'ab-set-err' }, error)
          : null,
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
              onClick: function () { run('save-plugin', { overwriteCorrupt: true }, t('set.overwriteOk'), { reseed: 'all' }) },
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
              'aria-pressed': presetSandbox === 'workspace-write',
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
              'aria-pressed': presetSandbox === 'read-only',
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
              // 芯片顺序 = 真实管道顺序：关键词 → 审核表 → 审核模型 → 模型转人工。
              // 「闸门」（参数没采集到 / 超预算 / 撞收集护栏）没有独立卡片：它唯一的开关
              // （truncatedAction）在审核模型卡片里，紧挨着「送审内容上限」。
              {
                id: 'keywords', name: t('set.stepKeywords'),
                value: countsLabel(t, (cfg.rejectKeywords || []).length, (cfg.humanKeywords || []).length, (cfg.allowKeywords || []).length, 'set.kwCounts'),
              },
              { id: 'criteria', name: t('set.stepCriteria'), value: t('set.criteriaCount', { n: String((cfg.criteria || []).length) }) },
              { id: 'judge', name: t('set.stepJudge'), value: judgeRoute + ' · ' + judgeTimeoutLabel },
              { id: 'humanReview', name: t('set.humanReviewTitle'), value: hrOn ? t('set.humanReviewOn') : t('set.humanReviewOff') },
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
            React.createElement('span', { className: 'ab-set-card-head' },
              React.createElement('span', { className: 'ab-set-card-title' },
                t('set.stepKeywords'),
                React.createElement('span', { className: 'ab-set-fold-chev' }, '▾'))),
            React.createElement('span', { className: 'ab-set-fold-sum' },
              countsLabel(t, (cfg.rejectKeywords || []).length, (cfg.humanKeywords || []).length, (cfg.allowKeywords || []).length, 'set.kwCounts'))),
          React.createElement('div', { className: 'ab-set-fold-body' },
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.kwSub')),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-grow', placeholder: t('set.kwPlaceholder'),
              'aria-label': t('set.kwPlaceholder'),
              value: newKeyword, onChange: function (e) { setNewKeyword(e.target.value) },
            }),
            React.createElement('select', {
              className: 'ab-set-select', value: newKeywordAction,
              'aria-label': t('set.add'),
              onChange: function (e) { setNewKeywordAction(e.target.value) },
            },
              actionOptions(t),
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
          React.createElement('div', { className: 'ab-set-list' },
            (function () {
              const rows = []
              ;(cfg.rejectKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'reject' }) })
              ;(cfg.humanKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'human' }) })
              ;(cfg.allowKeywords || []).forEach(function (k) { rows.push({ text: k, action: 'allow' }) })
              if (rows.length === 0) return React.createElement('p', { className: 'ab-set-empty' }, t('set.empty'))
              return rows.map(function (row, idx) {
                const commitKw = function (text, action) {
                  const next = String(text || '').trim()
                  if (!next) return
                  if (next === row.text && action === row.action) return
                  run('rule-op', { op: 'set', kind: 'keywords', value: { from: row.text, text: next, action: action } })
                }
                // key 里带序号：手改 allowlist.json 放同桶重复词时，`action+':'+text` 会撞车
                // （React 会说 "two children with the same key"，而且编辑态会串行）。
                const editKey = row.action + ':' + row.text + ':' + String(idx)
                return React.createElement('div', { className: 'ab-set-item ab-set-item-kw', key: editKey },
                  kwEdit === editKey
                    ? React.createElement('input', {
                        className: 'ab-set-input ab-set-input-grow',
                        defaultValue: row.text,
                        autoFocus: true,
                        'aria-label': t('set.kwEditTitle') + '：' + row.text,
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
                    : React.createElement('button', {
                        type: 'button',
                        className: 'ab-set-kw-text',
                        title: t('set.kwEditTitle'),
                        'aria-label': t('set.kwEditTitle') + '：' + row.text,
                        onClick: function () {
                          // Escape 之后那个「跳过 blur」标记可能还留着：浏览器在**移除聚焦元素**时
                          // 不保证发 blur（Firefox 不发，标准也已移除该行为），残留的 true 会把
                          // 下一次编辑的 blur 当成「刚被取消的那一次」静默吞掉——不提交、编辑器不关。
                          kwSkipBlurRef.current = false
                          setKwEdit(editKey)
                        },
                      }, row.text),
                  preShipped.has(row.text) ? React.createElement('span', { className: 'ab-set-tag ab-set-tag-blue' }, t('set.presetTag')) : null,
                  React.createElement('select', {
                    className: 'ab-set-select', value: row.action,
                    'aria-label': t('set.stepKeywords') + '：' + row.text,
                    onChange: function (e) { commitKw(row.text, e.target.value) },
                  },
                    actionOptions(t),
                  ),
                  React.createElement('button', {
                    type: 'button',
                    className: 'ab-set-item-del' + (resetArmed === ('del-kw:' + row.text) ? ' ab-set-btn-danger' : ''),
                    title: t('set.delete'),
                    'aria-label': t('set.delete') + '：' + row.text,
                    onClick: function () {
                      const key = 'del-kw:' + row.text
                      if (preShipped.has(row.text) && resetArmed !== key) {
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
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            resetBtn('keywords', t('set.resetKeywords'), function () {
              run('rule-op', { op: 'reset', kind: 'keywords', value: null }, t('set.resetKeywordsOk'))
            }),
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
            React.createElement('span', { className: 'ab-set-card-head' },
              React.createElement('span', { className: 'ab-set-card-title' },
                t('set.stepCriteria'),
                React.createElement('span', { className: 'ab-set-fold-chev' }, '▾'))),
            React.createElement('span', { className: 'ab-set-fold-sum' },
              (function () {
                const rows = cfg.criteria || []
                const n = function (a) {
                  return rows.reduce(function (acc, c) {
                    const acts = c.actions || {}
                    return acc + ['low', 'medium', 'high'].filter(function (lv) { return acts[lv] === a }).length
                  }, 0)
                }
                return countsLabel(t, n('reject'), n('human'), n('allow'))
              })())),
          React.createElement('div', { className: 'ab-set-fold-body' },
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.criteriaSub')),
          React.createElement('div', { className: 'ab-set-list ab-set-list-crit' },
            (cfg.criteria || []).map(function (c) {
              const commitCrit = function (patch) {
                run('rule-op', { op: 'set', kind: 'criteria', value: Object.assign({ id: c.id }, patch) })
              }
              const acts = c.actions || {}
              const cellOf = function (level) {
                return React.createElement('span', { className: 'ab-set-cell', key: level },
                  React.createElement('span', { className: 'ab-set-cell-lv' }, level),
                  React.createElement('select', {
                    className: 'ab-set-select ab-set-select-sm',
                    value: acts[level] || 'human',
                    'aria-label': c.id + ' · ' + level,
                    onChange: function (e) {
                      const patch = {}
                      patch[level] = e.target.value
                      commitCrit({ actions: patch })
                    },
                  },
                    actionOptions(t),
                  ))
              }
              return React.createElement('div', { className: 'ab-set-item ab-set-item-crit', key: c.id },
                React.createElement('div', { className: 'ab-set-crit-top' },
                  React.createElement('span', { className: 'ab-set-item-id', title: c.id }, c.id),
                  React.createElement('div', { className: 'ab-set-cells' },
                    cellOf('low'), cellOf('medium'), cellOf('high')),
                  c.id === 'other' ? null : React.createElement('button', {
                    type: 'button',
                    className: 'ab-set-item-del' + (resetArmed === ('del-c:' + c.id) ? ' ab-set-btn-danger' : ''),
                    title: t('set.delete') + ' ' + c.id,
                    'aria-label': t('set.delete') + ' ' + c.id,
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
                  // `other` 不能删除，但说明与三格都可改；这行提示它承接哪些情况。
                  c.id === 'other'
                    ? React.createElement('span', { className: 'ab-set-item-meta' }, t('set.criterionOtherNote'))
                    : null,
                  React.createElement('textarea', {
                    key: c.id + ':desc:' + (c.description || ''),
                    className: 'ab-set-textarea',
                    defaultValue: c.description || '',
                    placeholder: t('set.descPlaceholder'),
                    'aria-label': c.id + ' · ' + t('set.descPlaceholder'),
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
                'aria-label': t('set.criterionId'),
                value: newCriterion.id,
                onChange: function (e) { setNewCriterion(Object.assign({}, newCriterion, { id: e.target.value })) },
              }),
              React.createElement('div', { className: 'ab-set-cells' },
                ['low', 'medium', 'high'].map(function (level) {
                  return React.createElement('span', { className: 'ab-set-cell', key: level },
                    React.createElement('span', { className: 'ab-set-cell-lv' }, level),
                    React.createElement('select', {
                      className: 'ab-set-select ab-set-select-sm',
                      value: (newCriterion.actions && newCriterion.actions[level]) || 'human',
                      'aria-label': level,
                      onChange: function (e) {
                        const actions = Object.assign({}, newCriterion.actions)
                        actions[level] = e.target.value
                        setNewCriterion(Object.assign({}, newCriterion, { actions: actions }))
                      },
                    },
                      actionOptions(t),
                    ))
                })),
            ),
            React.createElement('div', { className: 'ab-set-item-fields' },
              React.createElement('textarea', {
                className: 'ab-set-textarea',
                placeholder: t('set.descPlaceholder'),
                'aria-label': t('set.descPlaceholder'),
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
                disabled: busy || !newCriterion.id || !newCriterion.description.trim(),
                onClick: function () {
                  const row = newCriterion
                  run('rule-op', { op: 'add', kind: 'criteria', value: row }).then(function (res) {
                    if (res) setNewCriterion({ id: '', description: '', actions: { low: 'human', medium: 'human', high: 'human' } })
                  })
                },
              }, t('set.addCriterion')),
            ),
          ),
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.criteriaLangNote')),
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            restoreCriteria('zh'),
            restoreCriteria('en'),
          ),
          ),
        ),

        React.createElement('details', {
          className: 'ab-set-card ab-set-fold', 'data-ab-stage': 'levels',
          open: foldOpen.levels,
          onToggle: function (e) {
            const open = e.currentTarget.open
            setFoldOpen(function (prev) { return Object.assign({}, prev, { levels: open }) })
          },
        },
          React.createElement('summary', null,
            React.createElement('span', { className: 'ab-set-card-head' },
              React.createElement('span', { className: 'ab-set-card-title' },
                t('set.levelsTitle'),
                React.createElement('span', { className: 'ab-set-fold-chev' }, '▾'))),
            React.createElement('span', { className: 'ab-set-fold-sum' },
              levelLabel(t, levelsFallback))),
          React.createElement('div', { className: 'ab-set-fold-body' },
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.levelsSub')),
            React.createElement('div', { className: 'ab-set-list ab-set-list-crit' },
              ['low', 'medium', 'high'].map(function (level) {
                const text = (levelsCfg.descriptions && levelsCfg.descriptions[level]) || ''
                return React.createElement('div', { className: 'ab-set-item ab-set-item-crit', key: level },
                  React.createElement('div', { className: 'ab-set-crit-top' },
                    React.createElement('span', { className: 'ab-set-item-id' }, levelLabel(t, level))),
                  React.createElement('div', { className: 'ab-set-item-fields' },
                    React.createElement('textarea', {
                      key: level + ':desc:' + text,
                      className: 'ab-set-textarea',
                      defaultValue: text,
                      placeholder: t('set.levelDescPlaceholder'),
                      'aria-label': levelLabel(t, level) + ' · ' + t('set.levelDescPlaceholder'),
                      rows: 2,
                      ref: sizeTextarea,
                      onInput: function (e) { sizeTextarea(e.currentTarget) },
                      onBlur: function (e) {
                        const next = e.target.value.trim()
                        if (next === text) return
                        const patch = {}
                        patch[level] = next
                        run('rule-op', { op: 'set', kind: 'levels', value: { descriptions: patch } })
                      },
                    })),
                )
              })),
            React.createElement('div', { className: 'ab-set-row' },
              React.createElement('label', { className: 'ab-set-item-meta' }, t('set.levelFallback')),
              React.createElement('select', {
                className: 'ab-set-select', value: levelsFallback,
                'aria-label': t('set.levelFallback'),
                onChange: function (e) {
                  run('rule-op', { op: 'set', kind: 'levels', value: { fallback: e.target.value } })
                },
              },
                React.createElement('option', { value: 'low', key: 'low' }, 'low'),
                React.createElement('option', { value: 'medium', key: 'medium' }, 'medium'),
                React.createElement('option', { value: 'high', key: 'high' }, 'high'),
              )),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.levelFallbackHint')),
            React.createElement('div', { className: 'ab-set-row ab-set-foot' },
              restoreLevels('zh'),
              restoreLevels('en'),
            ),
          ),
        ),

        React.createElement('div', { className: 'ab-set-card', 'data-ab-stage': 'humanReview' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.humanReviewTitle')),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.humanReviewSub'))),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('label', { className: 'ab-set-item-meta' }, t('set.humanReviewEnable')),
            React.createElement('select', {
              className: 'ab-set-select', value: hrOn ? 'on' : 'off',
              'aria-label': t('set.humanReviewEnable'),
              onChange: function (e) { run('save-plugin', { humanReview: { enabled: e.target.value === 'on' } }, t('set.humanReviewSaved'), { reseed: 'human' }) },
            },
              React.createElement('option', { value: 'off', key: 'off' }, t('set.humanReviewOff')),
              React.createElement('option', { value: 'on', key: 'on' }, t('set.humanReviewOn')),
            )),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('label', { className: 'ab-set-item-meta' }, t('set.humanReviewTool')),
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-grow',
              'aria-label': t('set.humanReviewTool'),
              value: hrTool,
              onChange: function (e) { setHrTool(e.target.value) },
              onBlur: function () {
                // 只提交 toolName：mergePluginConfig 逐键取值，不会把 enabled 冲掉。
                run('save-plugin', { humanReview: { toolName: hrTool } }, t('set.humanReviewSaved'), { reseed: 'human' })
              },
            })),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('label', { className: 'ab-set-item-meta' }, t('set.humanReviewLang')),
            React.createElement('select', {
              className: 'ab-set-select', value: hrLang,
              'aria-label': t('set.humanReviewLang'),
              onChange: function (e) { run('save-plugin', { humanReview: { noticeLang: e.target.value } }, t('set.humanReviewSaved'), { reseed: 'human' }) },
            },
              React.createElement('option', { value: 'zh', key: 'zh' }, t('set.judgeLangZh')),
              React.createElement('option', { value: 'en', key: 'en' }, t('set.judgeLangEn')),
            )),
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.humanReviewToolHint')),
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.humanReviewWarn')),
        ),

        React.createElement('div', { className: 'ab-set-card', 'data-ab-stage': 'judge' },
          React.createElement('div', { className: 'ab-set-card-head' },
            React.createElement('div', { className: 'ab-set-card-title' }, t('set.judgeTitle')),
            React.createElement('p', { className: 'ab-set-card-sub' },
              t('set.judgeSubLead') +
              (fallback.provider && fallback.model
                ? t('set.judgeSubFallback', { provider: fallback.provider, model: fallback.model })
                : t('set.judgeSubNoFallback')))),
          // 判定一直判不出来时，第一眼就要看见：失败只出现在 audit.log 与「怎么又弹人工框」里
          // 是这次故障最难查的地方。健康度是进程内的，重启清零。
          (snapshot.judgeHealth && snapshot.judgeHealth.empty > 0)
            ? React.createElement('p', { className: 'ab-set-note' },
              t('set.judgeHealthWarn', {
                n: String(snapshot.judgeHealth.empty),
                ok: String(snapshot.judgeHealth.recovered || 0),
              }))
            : null,
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('select', {
              className: 'ab-set-select', value: judgeProvider,
              'aria-label': t('set.judgeProviderLabel'), title: t('set.judgeProviderLabel'),
              onChange: function (e) { setJudgeProvider(e.target.value); setJudgeModel(''); setJudgeEffort('') },
            },
              React.createElement('option', { value: '', key: '' }, t('set.followProvider')),
              providers.map(function (p) {
                return React.createElement('option', { value: p.id, key: p.id }, p.name || p.id)
              }),
            ),
            React.createElement('select', {
              className: 'ab-set-select', value: judgeModel,
              'aria-label': t('set.judgeModelLabel'), title: t('set.judgeModelLabel'),
              onChange: function (e) { setJudgeModel(e.target.value); setJudgeEffort('') },
            },
              React.createElement('option', { value: '', key: '' }, t('set.followModel')),
              models.map(function (m) {
                return React.createElement('option', { value: m.id, key: m.id }, m.name || m.id)
              }),
            ),
            React.createElement('select', {
              className: 'ab-set-select', value: judgeEffort,
              'aria-label': t('set.judgeEffortLabel'), title: t('set.judgeEffortLabel'),
              onChange: function (e) { setJudgeEffort(e.target.value) },
            },
              // 只有「模型默认」一个「不表态」选项：`off` 与它在适配层是同一个请求
              // （见 `normalizeJudgeEffort`），多列一个等价项只会让人以为它们有区别，
              // 而且 `off` 会走档位校验、在路由没列它时报 err.judgeEffort。
              React.createElement('option', { value: '', key: '' }, t('set.modelDefaultEffort')),
              // 路由自己把 `off` 列进档位表时也不要列出来：那个语义就是「模型默认」这一项。
              efforts.filter(function (e) { return e.id !== 'off' }).map(function (e) {
                return React.createElement('option', { value: e.id, key: e.id }, e.name || e.id)
              }),
            ),
          ),
          catalogError
            ? React.createElement('p', { className: 'ab-set-note' }, t('err.catalog', { error: catalogError }))
            : null,
          modelInfoError
            ? React.createElement('p', { className: 'ab-set-note' }, t('err.info', { error: modelInfoError }))
            : null,
          React.createElement('div', { className: 'ab-set-item-fields' },
            React.createElement('div', { className: 'ab-set-row' },
              React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgePrompt')),
              React.createElement('span', { className: 'ab-set-card-sub' }, t('set.judgePromptLang', { lang: langName(judgePromptLang) })),
              (function () {
                // 三态：草稿与已保存值不一致 → 「未保存」。这是整个卡片里唯一能提示
                // 「改了还没点保存」的地方（快照刷新不再清草稿，所以更需要这个标记）。
                const shipped = String(((snapshot.predefined && snapshot.predefined.judgePrompts) || {})[judgePromptLang] || '')
                const savedRaw = String(((snapshot.plugin && snapshot.plugin.judgePrompts) || {})[judgePromptLang] || '')
                const saved = savedRaw.trim() ? savedRaw : shipped
                const draft = String((judgePromptDrafts && judgePromptDrafts[judgePromptLang]) || '')
                if (draft.trim() !== saved.trim()) {
                  return React.createElement('span', { className: 'ab-set-tag ab-set-tag-warn' }, t('set.judgePromptUnsaved'))
                }
                return React.createElement('span', { className: 'ab-set-tag ab-set-tag-blue' },
                  savedRaw.trim() ? t('set.judgePromptCustom') : t('set.judgePromptDefault'))
              })(),
            ),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.judgePromptHint')),
            React.createElement('p', { className: 'ab-set-card-sub' }, t('set.langByRestore')),
            React.createElement('textarea', {
              key: 'judge-prompt:' + judgePromptLang,
              className: 'ab-set-textarea ab-set-textarea-prompt',
              'aria-label': t('set.judgePrompt'),
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
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-num', type: 'number', min: 1000,
              'aria-label': t('set.judgeTimeoutMs'),
              value: timeoutMs, onChange: function (e) { setTimeoutMs(e.target.value) },
            }),
          ),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgeRequestBudget')),
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-num', type: 'number', min: 8192, max: 1000000,
              'aria-label': t('set.judgeRequestBudget'),
              value: judgeBudget, onChange: function (e) { setJudgeBudget(e.target.value) },
            }),
          ),
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.judgeRequestBudgetHint')),
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('span', { className: 'ab-set-item-meta' }, t('set.judgeMaxTokens')),
            React.createElement('input', {
              className: 'ab-set-input ab-set-input-num', type: 'number', min: 256, max: 32768,
              'aria-label': t('set.judgeMaxTokens'),
              value: judgeMaxTokens, onChange: function (e) { setJudgeMaxTokens(e.target.value) },
            }),
          ),
          React.createElement('p', { className: 'ab-set-card-sub' }, t('set.judgeMaxTokensHint')),
          // 闸门（超预算 / 撞收集护栏）的动作跟它的触发条件放在一起；「参数没采集到」不吃这个开关。
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('label', { className: 'ab-set-item-meta' }, t('set.truncatedAction')),
            React.createElement('select', {
              className: 'ab-set-select', value: cfg.truncatedAction || 'human',
              'aria-label': t('set.truncatedAction'),
              onChange: function (e) {
                run('rule-op', { op: 'set', kind: 'truncatedAction', value: e.target.value })
              },
            },
              React.createElement('option', { value: 'human', key: 'human' }, t('action.human')),
              React.createElement('option', { value: 'reject', key: 'reject' }, t('action.reject')),
            )),
          // 自检：真跑一次判定，把结果回显在同一张卡片里（成功/失败都显示依据，不只是「失败了」）。
          React.createElement('div', { className: 'ab-set-row' },
            React.createElement('button', {
              type: 'button', className: 'ab-set-btn',
              disabled: busy || (selftest && selftest.running),
              onClick: runSelftest,
            }, t('set.judgeSelftest')),
          ),
          selftestText
            ? React.createElement('p', {
              className: selftestState === 'fail' ? 'ab-set-note' : (selftestState === 'ok' ? 'ab-set-ok' : 'ab-set-muted'),
            }, selftestText)
            : null,
          React.createElement('div', { className: 'ab-set-row ab-set-foot' },
            restorePrompt('zh'),
            restorePrompt('en'),
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
          // characterData：React 原地改写文本（commitTextUpdate）走的是这条，不是 childList。
          // 菜单项/触发器的文案在 **span** 里（DSH 的 Menu / PermissionSelect 都是
          // `<button><span>文案</span></button>`），只扫 `parentNode` 会漏掉真正带
          // `[role=menuitem]` / `aria-label` 的祖先 —— 文案从「自动审批」换成别的时徽标摘不掉。
          if (rec.type === 'characterData' && rec.target) {
            const node = rec.target.parentNode
            if (!node || node.nodeType !== 1) continue
            const owner = typeof node.closest === 'function'
              ? node.closest('button[aria-label], [role="menuitem"]')
              : null
            scanAccessGlyphs(owner || node)
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
        // 文案原地改写（React commitTextUpdate）只有这条能看见。
        characterData: true,
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

        /**
         * 接管原生审批框的详情行。
         *
         * 为什么抢别人的槽位：DSH 的 `ApprovalCommand` 只渲染顶层 `command`，而 `write`/MCP 的
         * 越权审批没有这个字段——人看不到自己要批准什么。槽位是 `single`，规则是「同 priority
         * 冲突、换 priority 遮蔽、越低越渲染」，ui-chat 用默认 0，所以这里用 -10。
         * 代价（认下来）：bash 那条也归我们渲染（`ApprovalDetail` 复刻了它的查找逻辑），
         * 且 DSH 若改了 ChatNode 形状，这一行会整体失效——降级成「没有详情行」，不抛错。
         */
        slots.inject('conversation.approval.detail', function () {
          try {
            return slots.register(
              { name: 'conversation.approval.detail', priority: -10 },
              function (props) { return React.createElement(ApprovalDetail, { slotsProps: props, rpc: rpc, t: t }) },
            )
          } catch (error) {
            // 接管别人槽位是**越权**动作：DSH 将来也用 -10、或本插件被挂两次时会抛
            // 「single slot ... already has a registration」。这一抛会顺着 slot reconcile
            // 冒到客户端插件装载，把设置页/提示条/盾牌一起带走——所以只 warn 降级，
            // 详情行退回 DSH 自带的那一版（少一行提示，别的都还在）。
            console.warn('[dsh-auto-approve] 接管审批框详情行失败，退回 DSH 自带渲染', error)
            return undefined
          }
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
    /**
     * 纯函数出口，只给 node 侧单测用（`tests/client.test.mjs` 造一个假 loader 把 factory
     * 取出来）。浏览器里没人读它——client bundle 不能 import，所以判定/映射这类逻辑只能
     * 靠这个口子被测试盯住；**不要**在这里放任何需要 DOM 或 ctx 的东西。
     */
    exports.__test = {
      isAutoReject,
      // 与宿主 `rules.mjs` 的 TOOL_ARG_KEYS 必须逐项同序（两处不能 import），
      // 测试拿它对拍，单侧调序会红。
      DETAIL_KEY_ORDER: DETAIL_KEY_ORDER,
      approvalDetailText,
      verdictLineFromEvent,
      ApprovalDetail,
      isExtraArgKey,
      detailExtraKeys,
      Detail,
      DetailSection,
      eventPreview,
      formatErr,
      codedText,
      verdictLabel,
      pathLabel,
      denyReasonLabel,
      actionLabel,
      levelLabel,
      srcLabel,
    }
    return module.exports
  },
})
