# dsh-auto-approve

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件：把审核模型自动审批、QQ 官方 Bot 人工审批和设置页做在同一条 `approval/request` 瀑布上。

需要审批的行为（由「自动审批」预设沙箱决定：工作区内不审批，或工作区也走判定）进入同一条判定管道。关键词和审核表的动作都可配置；越出工作区的 `danger-full-access` **不因模式名短路**。必须人工的请求同时出现在网页和配置的 QQ 聊天，**谁先答谁赢**。

范围仅限审批。QQ 机器人是通知和批复通道，不是 agent 聊天。

## 安装

请钉死发行 tag（推荐）。`main` 只放已发布的提交，开发走其他分支。

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.1.0
```

自己开发可以用本地路径：

```sh
dsh plugin --profile web add /path/to/this-repo
```

重启 `dsh web`。首次启动会把 `auto-approve` 权限预设写入 profile patch（预设表冻结，不能运行时扩展）。

## 设置

设置页 → **自动审批**：

1. 点「扫码接入机器人」，用手机 QQ 扫码（腾讯官方开放平台流程）；也可以手动填 AppID / AppSecret 后保存连接。
2. 加好友后给机器人发任意一句，在「最近来信」点选审批聊天（推荐私聊）。群必须 @机器人，并另配 `userId`。若尚未选定聊天，扫码者的 openid 会预填为 `chatId`。本插件按**私人 bot** 设计：未绑定 `chatId` 时，任意私聊回复「是」「确认」「用作审批」「yes」「ok」会把该聊天设为审批目标。不要把 bot 加到别人也能私聊的环境。
3. 在「自动审批模式」里选择：工作区内不审批（预设沙箱 `workspace-write`，推荐），或工作区也走判定（`read-only`）。保存后重启 `dsh web`，并重新选择「自动审批」或开新会话。
4. 会话权限选「自动审批」。若首次启动后下拉里还没有，再重启一次让 live patch 生效。

凭据只存在 `~/.dsh/approval-bridge/qqbot.json`（`0600`），不要提交。

卸载（`dsh plugin --profile web remove dsh-auto-approve`）后重启，插件随 bundle 层消失。`auto-approve` 预设可能仍留在 profile patch 里：没有本插件时它只是普通的 `workspace-write` 或 `read-only` + `ask`。`~/.dsh/auto-approve/` 与 `~/.dsh/approval-bridge/` 里的规则、审计和 QQ 凭据不会删除。

## 行为

| 情况 | 结果 |
|---|---|
| 预设沙箱 `workspace-write`，工作区内写入 | 不进审批（沙箱已允许） |
| 关键词命中拒绝 / 审核表动作为拒绝 | 直接 `rejected`，无框、无 QQ |
| 关键词命中允许 / 审核表动作为允许 | 无框、无 QQ；绿条 + `ALLOW` 审计 |
| 关键词命中人工、审核表人工、判定失败 | QQ 收到 `#N`；回复 `批准 N` 后工具继续 |
| `danger-full-access`（越出工作区） | 进入同一条判定管道，不因模式名短路 |
| 网页与 QQ 同时亮 | 先到的 outcome 生效；QQ 先答会关掉网页框（只 abort 网页用的 fork signal，不碰 `req.signal`） |
| QQ 等待超时（默认 120s） | 网页框仍在；QQ 提示到网页继续 |
| 未配凭据 / 未连接 | 自动审批照常；人工只走网页（`PUSH_SKIP`） |
| 审核模型配错 / 判定失败 | 当次转人工（`FAILED`）；不改用会话模型 |
| 未捕获工具参数（无命令/路径/内容/code 等） | 转人工（`missing-payload`），禁止自动放行 |
| 捕获字段被截断 | 仍可关键词拒绝；禁止自动放行（`truncated-payload`） |
| 预设不是 `auto-approve` | 不抢答、不推送（除非关闭 `onlyAutoApprovePreset`） |

QQ 审批推送带「批准 / 拒绝」按钮（单聊、群聊自定义按钮）。也可回复：`批准 17` / `#17 批准` / `yes 17` 放行；`拒绝 17` 只拒这一次。仅 1 条 pending 时允许裸 `批准` / `拒绝`。

不要 abort `req.signal` 来关网页框：那会把整单变成 `cancelled`。

## 判定管道

仅当 `permissionPresets.current(session) === 'auto-approve'` 时介入（除非关闭「仅该预设」）。预设沙箱是底线、不是管道步骤：`workspace-write` 时工作区内写入根本进不了审批。

1. 关键词（拒绝 > 人工 > 允许）。拒绝/人工匹配 **工具名 + command + 路径 + workdir**；允许词不匹配工具名。不匹配模型理由、`description`、文件正文。预置词默认拒绝，含灾难命令形态（`rm -rf`、`git push -f`、`drop table`、`dd of=` 等）、审批配置路径，以及 `.env` / `id_rsa` 等凭据路径。漏掉的交给下一步。捕获字段被截断时仍可关键词拒绝，禁止关键词允许或模型标 safe，转人工。
2. 审核表：审核模型看到与网页工具卡片相同的字段（含命令、路径、原文/改成、写入内容、code/url/sql 等），只输出类别 id + 理由；程序按表执行允许 / 拒绝 / 人工。解析失败或超时转人工，**不**执行「其他」的动作。风险类默认拒绝；「安全」默认允许；「其他」默认人工。

默认审核表（动作均可改；「其他」不能删除）：

| id | 标签 | 默认动作 |
|---|---|---|
| deletion | 删除/覆盖不可再生数据 | 拒绝 |
| credential | 凭据/密钥/授权修改 | 拒绝 |
| remote | 远程系统/生产环境/数据库 | 拒绝 |
| system | 系统级路径/配置 | 拒绝 |
| bulk | 批量不可回补操作 | 拒绝 |
| approval-config | 自动审批配置 | 拒绝 |
| safe | 安全/常规可回补 | 允许 |
| other | 其他（拿不准） | 人工 |

风险类默认拒绝。只有模型能确认安全才走 `safe` 自动放行；拿不准走「其他」转人。模型若把危险操作归进 `safe`，会被自动放行。

设置里可把**审核提示词语言**设为中文或 English（默认中文）。这只换发给模型的框架和卡片标签，**不会**改当前审核表。点「恢复默认审核表」才按所选语言加载出厂包。理由与框架同语言。

Host API 走已鉴权的 `connection.rpc`（`/api/dsh-auto-approve`），不上无鉴权 HTTP。

## 数据

位于 `$DSH_HOME`（默认 `~/.dsh/`），均不进 git。

| 路径 | 用途 |
|---|---|
| `auto-approve/allowlist.json` | 关键词三桶 / 审核表 / 审核超时（`0600`） |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `PUSH` / `PUSH_SKIP` / `PUSH_FAIL` / `OUTCOME`（`0600`） |
| `auto-approve/events.jsonl` | UI 事件（含 `ticket`、`sessionId`；超约 2MB 只留最后 2000 条，`0600`） |
| `approval-bridge/qqbot.json` | AppID / AppSecret，`0600` |
| `approval-bridge/config.json` | 审核模型、推送目标等插件配置（`0600`） |

没有 audit 行 = 本插件没有处理该请求。

## 配置

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # 或 read-only：工作区写入也走判定
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
    notify:
      enabled: true
      chatId: ''
      userId: ''
      timeoutSecs: 120
```

审核模型字段为空则跟随部署默认模型。没有默认可跟随、也没手动配置，或路由配错，则当次转人工。不会再猜一个模型。设置页「审核超时」写入 `allowlist.json` 的 `judgeTimeoutMs`（运行时以此为准）；yaml 里的 `judge.timeoutMs` 只在尚未生成 allowlist 时作缺省。

JSON 读失败（损坏）时本进程用内存默认，**不覆盖磁盘**。设置页除「恢复默认 / 覆盖损坏配置」外不会写坏 allowlist；插件配置损坏需明确覆盖；QQ 凭据损坏需重新保存或扫码。

## 开发

```sh
node --test tests/*.test.mjs
npm run check
```

结构：`src/index.mjs`（宿主）、`src/rules.mjs`、`src/tickets.mjs`、`src/qqbot.mjs`、`src/provisioning.mjs`（官方扫码）、`src/preset-patch.mjs`、`src/util.mjs`、`client.js`（网页半；React 用 `createElement`，无 JSX）、`locales.mjs`（网页 zh/en 字典）。网页文案跟随 DSH 语言设置；QQ 推送和审计日志仍为中文。扫码依赖可选包 `@tencent-connect/qqbot-connector`，二维码由本机 `qrcode` 生成。

在本仓库改代码的 agent 请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
