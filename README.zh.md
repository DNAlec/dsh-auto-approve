# dsh-auto-approve

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用**关键词**和**审核模型审核表**自动允许或拒绝工具调用。拿不准就交给原来的网页审批框。

## 安装

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.2.0
```

打 tag 发布后也可从 npm 安装：

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

重启 `dsh web`。首次启动会写入「自动审批」权限预设。

## 设置

设置页 → **自动审批**：

1. **模式** — 工作区内不审批（`workspace-write`，推荐），或工作区也走判定（`read-only`）。保存后重启 `dsh web`，再重新选择「自动审批」或开新会话。
2. 按需改**关键词**和**审核表**。恢复默认会按所选审核提示词语言加载出厂包。
3. **审核模型** — 空则跟随部署默认。
4. 会话权限选 **自动审批**。

## 怎么判定

仅当会话预设是「自动审批」时介入。`workspace-write` 下，工作区内写入不会进审批。`danger-full-access` 走同一条管道。缺参或字段被截断会转人工，禁止自动放行。

1. **关键词**（拒绝 > 人工 > 允许）。匹配工具名、命令、路径和工作目录。允许词不匹配工具名，也不匹配会话目录名。预置拒绝词覆盖灾难命令（`rm -rf`、`git push -f`、`drop table`、`dd of=`）、审批配置路径，以及 `.env` / `id_rsa` 等凭据路径。
2. **审核表**。审核模型看到与网页工具卡片相同的字段，只输出类别；程序按该行动作执行。解析失败或超时转人工。

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

审核提示词语言（中文 / English）只换发给模型的框架，不改当前审核表。

## 数据

位于 `$DSH_HOME`（默认 `~/.dsh/`），不进 git：

| 路径 | 用途 |
|---|---|
| `auto-approve/allowlist.json` | 关键词、审核表、审核超时 |
| `auto-approve/config.json` | 审核模型与插件配置 |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `OUTCOME` |
| `auto-approve/events.jsonl` | 审批 tab 事件 |

损坏文件不会被覆盖。卸载插件不会删除这个目录。

## 配置

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # 或 read-only
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
```

审核模型字段为空则跟随部署默认。没有可用路由时当次转人工。设置页「审核超时」写入 `allowlist.json`，运行时以此为准。

## 开发

```sh
node --test tests/*.test.mjs
npm run check
```

见 [AGENTS.md](AGENTS.md) 与 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
