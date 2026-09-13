# dsh-auto-approve

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用**关键词**和**审核模型审核表**自动允许或拒绝工具调用。拿不准就交给原来的网页审批框。

## 安装

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.3.0
```

打 tag 发布后也可从 npm 安装：

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

重启 `dsh web`。首次启动会把「自动审批」权限预设写进当前 profile 的 `cordis.patch.yml`；写失败时日志会指出文件和原因。

## 设置

设置页 → **自动审批**：

1. **模式** — 工作区内不审批（`workspace-write`，推荐），或工作区也走判定（`read-only`）。点选即写入；然后重启 `dsh web`，再重新选择「自动审批」或开新会话。
2. 按需改**关键词**和**审核表**。两个「恢复默认」按钮各带语言（恢复中文/英文默认审核表、恢复中文/英文默认提示词），选中的语言同时决定提示词语言。
3. **审核模型** — 空则跟随部署默认。与提示词、超时一起保存。
4. **审核提示词** — 可改；恢复默认写回所选语言的出厂模板并把语言切过去。用 `{{criteria}}` 插入当前审核表。
5. 会话权限选 **自动审批**。

从 0.2.x 升级：审核表里的 `label` 字段会在下次写盘时自动消失（旧文案落进说明）；**关键词表大幅精简，但老文件里已有的词不会被自动删掉**，想让新出厂表生效请点一次「恢复默认关键词」；`other` 的说明从这一版起固定不可改（动作仍可改）。

## 怎么判定

仅当会话预设是「自动审批」时介入。`workspace-write` 下，工作区内写入不会进审批。`danger-full-access` 走同一条管道。缺参或字段被截断会转人工，禁止自动放行。

1. **关键词**（拒绝 > 人工 > 允许）。匹配工具名、命令、路径和工作目录。允许词不匹配工具名，也不匹配会话目录名。**出厂拒绝词只留三类「零上下文就确定灾难、不该让模型有发言权」的红线**：① 清根 `rm -rf /`（写法连 `rm -rf /*`、`sudo rm -rf /` 一起覆盖）；② 裸设备覆写与格式化（`of=/dev/`、`mkfs`、`wipefs`、`Format-Volume`、`Clear-Disk`、`diskutil eraseDisk`）；③ **门控自身的配置**（`.dsh/auto-approve`、`.dsh/profiles`、`.dsh/config.yml`、`cordis.patch.yml`、`auto-approve/allowlist`）与**私钥/云端凭据**（`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`、`.pem`/`.p12`/`.pfx`/`.jks`、`authorized_keys`、`.netrc`、`.git-credentials`、`.pypirc`、`~/.aws/credentials`、`~/.kube/config`）。公钥不算（`id_rsa.pub`），dd 写 `/dev/null` 这类伪设备不算。
**其余一律交给审核表按各行说明判**：递归删除（`rm -rf` 家族、`sudo rm`、`Remove-Item -Recurse -Force`、`rd /s /q`）、`chmod -R 777`、`git push --force`、`drop table`/`delete from`、`terraform destroy`、`docker system prune`/`volume rm`、关机重启，以及 `.env`/`.npmrc`/docker `config.json` 这类工具会自己改写的凭据文件——可再生成的目录与常规操作放行，删用户数据/源码、破坏生产或远端历史拒绝，拿不准转人工。被移出出厂表的词都在 `RETIRED_DEFAULT_KEYWORDS` 里留档，想恢复硬拒加回 `DEFAULT_DENY_KEYWORDS` 即可；自己的词也可以放**人工桶**（弹网页框问你，默认留空）。点文件按路径字段放宽匹配：`prod.env` 命中，命令里的 `process.env` 不误伤。
2. **审核表**。一行只有 **id + 说明**：说明写「什么情况下选这个 id」，模型只输出 id 和一句理由，动作（允许 / 拒绝 / 转人工）由程序按表执行。审核模型看到与网页工具卡片相同的字段（并明确标记为不可信数据）。解析失败或超时转人工；类别取**最后一个**「类别:」行，卡片回显不能覆盖结论。

默认审核表（id 是英文小写，会显示在审批历史里；说明与动作可改；**other** 是结构行——不能删除，说明也固定，只有动作可改）：

| id | 什么情况下选它 | 默认 |
|---|---|---|
| deletion | 删除/清空/截断/不可逆覆盖用户数据、数据库、备份、历史、未提交内容（单文件源码编辑不算；能确认是本地/临时开发库的常规改动也不算） | 拒绝 |
| credential | 改动密钥、token、证书私钥、`.env`、`authorized_keys`、`kubeconfig`、`~/.aws`、带 token 的 `.npmrc`、git/pypi 凭据 | 拒绝 |
| remote | 写远程主机/生产/数据库，ssh/kubectl/云 CLI 变更，云资源删除（`terraform destroy`、`s3 rb --force`）、强制推送改写远端历史、破坏性 SQL、发包或生产部署（只读查询、普通 push、**能确认是本地/临时开发库的操作**不算；连接目标不明确时仍按本行） | 拒绝 |
| system | 改 `/etc`、`/usr` 等系统目录、服务与防火墙、关机重启、用户与权限管理（含放宽到 777）、crontab、shell rc、系统级安装 | 拒绝 |
| bulk | 递归/通配/循环删除或覆盖用户数据、源码、配置、未提交内容，格式化、向块设备写 `dd`、`git reset --hard`、`git clean`、`rsync --delete`、销毁数据卷（可再生成的依赖/构建/缓存/临时目录不算） | 拒绝 |
| approval-config | 改插件自己的配置：allowlist、plugin config、profile patch（`cordis.patch.yml`，默认在 `~/.dsh` 下） | 拒绝 |
| safe | 能确认是常规可回补操作：源码/文档/测试改动、构建产物、装依赖、清日志或缓存、清临时目录、**本地/临时开发库的常规改动**、可撤销单文件编辑（发包/提权/外发数据/拿不准不要选） | 允许 |
| other | 风险行和常规可回补都不符合，或拿不准；看着无害但确认不了也选它（**说明固定，只能改动作**） | 人工 |

审核提示词语言没有独立开关：在「恢复中文/英文默认审核表」或「恢复中文/英文默认提示词」时选，选中的语言同时决定发给审核模型的框架、卡片文案和理由语言。恢复默认审核表只换表，不动自定义提示词；出厂中英包 id 与动作相同，**只有说明不同**。说明写清「什么情况下选这个 id」，它既是模型标准也是设置页文案。自定义提示词按语言分别保存，设置页编辑的是当前语言那一份。

## 数据

位于 `$DSH_HOME`（默认 `~/.dsh/`），不进 git：

| 路径 | 用途 |
|---|---|
| `auto-approve/allowlist.json` | 关键词、审核表、审核超时 |
| `auto-approve/config.json` | 审核模型、提示词语言/自定义提示词与插件配置 |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `OUTCOME` |
| `auto-approve/events.jsonl` | 审批 tab 事件 |

损坏文件不会被覆盖。卸载插件不会删除这个目录。

## 配置

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # 或 read-only
    judgePromptLang: zh              # 当前提示词语言：由设置页「恢复默认」时选择，一般不用手改
    judgePrompts:                    # 可选：按语言覆盖提示词模板；'' = 用出厂模板
      zh: ''
      en: ''
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
    # profilePatch: /home/me/.dsh/profiles/web/cordis.patch.yml   # 可选：显式指定 patch 文件
```

审核模型字段为空则跟随部署默认。没有可用路由时当次转人工。设置页「审核超时」写入 `allowlist.json`，运行时以此为准。

「自动审批」预设写进当前运行 profile 的 patch 文件（路径从 profile 目录 `ctx.baseUrl` 推导）；profile 不放在默认位置时可用 `profilePatch` 显式指定。

patch 是按 id **整块替换** `config` 的，所以这个 profile 用的权限表就是插件写进去的那份副本（出厂预设 + auto-approve）。DSH 升级后如果出厂预设表新增/改名，插件启动时会和 `@deepseek-ai/dsh-base` 的 patch 比对，把缺的名字打进日志，并在设置页显示一张提示卡片（更新插件或手工合并那一行）；插件不会自动改写你的文件。

## 开发

```sh
node --test tests/*.test.mjs
npm run check          # 语法检查 + 文案同步校验
npm run locales:sync   # 按 locales.mjs 重新生成 client.js 内联字典
```

见 [AGENTS.md](AGENTS.md) 与 [CHANGELOG.md](CHANGELOG.md)。

## 推荐搭配 [dsh-message-push](https://github.com/DNAlec/dsh-message-push)

本插件把绝大多数工具调用自己判掉了，只有拿不准的才会回到网页审批框或提问。**dsh-message-push 负责在这种时候把你叫回来**，长任务跑着你可以离开屏幕：会话停下（完成 / 中断 / 阻塞 / 出错 / 触顶 token）推一条，**待审批**和**待回答**则立即推，推到你配置的消息平台。

两者是刻意分开的：本插件负责回答审批（允许 / 拒绝，否则把请求交回原网页框），dsh-message-push 只旁路观察，不做任何决定，也不会把回复注入会话。它自己还对外提供 `messagePush` 服务，别的插件可以复用它的渠道。

```sh
dsh plugin --profile web add github:DNAlec/dsh-message-push
```

装完重启 `dsh web`，在设置页 → **消息推送**里至少连通一个渠道；支持哪些平台见它自己的 README。

## 许可证

[MIT](LICENSE)
