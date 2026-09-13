# dsh-auto-approve

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用**关键词**和**审核模型审核表**自动允许或拒绝工具调用。拿不准就交给原来的网页审批框。

## 安装

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.2.1
```

打 tag 发布后也可从 npm 安装：

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

重启 `dsh web`。首次启动会把「自动审批」权限预设写进当前 profile 的 `cordis.patch.yml`；写失败时日志会指出文件和原因。

## 设置

设置页 → **自动审批**：

1. **模式** — 工作区内不审批（`workspace-write`，推荐），或工作区也走判定（`read-only`）。点选即写入；然后重启 `dsh web`，再重新选择「自动审批」或开新会话。
2. 按需改**关键词**和**审核表**。恢复默认会按所选审核提示词语言加载出厂包。
3. **审核模型** — 空则跟随部署默认。与提示词、超时一起保存。
4. **审核提示词** — 按语言内置默认文案，可改；恢复默认写回该语言出厂模板。用 `{{criteria}}` 插入当前审核表。
5. 会话权限选 **自动审批**。

## 怎么判定

仅当会话预设是「自动审批」时介入。`workspace-write` 下，工作区内写入不会进审批。`danger-full-access` 走同一条管道。缺参或字段被截断会转人工，禁止自动放行。

1. **关键词**（拒绝 > 人工 > 允许）。匹配工具名、命令、路径和工作目录。允许词不匹配工具名，也不匹配会话目录名。预置拒绝词覆盖灾难命令（`rm -rf`、`git push -f`、`drop table`、`dd of=`）、审批配置路径，以及 `.env` / `id_rsa` 等凭据路径。点文件按路径字段放宽匹配：`prod.env` 命中，命令里的 `process.env` 不误伤；`id_rsa.pub`（公钥）不算凭据。
2. **审核表**。审核模型看到与网页工具卡片相同的字段（并明确标记为不可信数据），只输出类别；程序按该行动作执行。解析失败或超时转人工。类别取**最后一个**「类别:」行，卡片回显不能覆盖结论。

默认审核表（动作可改；**其他**不能删除）：

| id | 标签 | 默认 |
|---|---|---|
| deletion | 删除/覆盖不可再生数据 | 拒绝 |
| credential | 凭据/密钥/授权修改 | 拒绝 |
| remote | 远程系统/生产环境/数据库 | 拒绝 |
| system | 系统级路径/配置 | 拒绝 |
| bulk | 批量不可回补操作 | 拒绝 |
| approval-config | 自动审批配置 | 拒绝 |
| safe | 安全/常规可回补 | 允许 |
| other | 其他（拿不准） | 人工 |

审核提示词语言（中文 / English）只换框架、卡片标签和该语言的默认提示词，不改当前审核表。出厂提示词是通用归类规则，不绑死默认类别；表相关特例写在各行说明里。自定义提示词按语言分别保存。

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
    judgePromptLang: zh              # 或 en：提示词框架、卡片标签、出厂审核表
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

## 许可证

[MIT](LICENSE)
