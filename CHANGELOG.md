# Changelog

## 0.2.0

### Breaking

- Human review is **Web-only**. QQ / WeChat / Feishu / Telegram channels are removed.
- Plugin config lives in `~/.dsh/auto-approve/config.json`. A readable 0.1.x `~/.dsh/approval-bridge/config.json` is migrated once (judge / preset / language only). QQ credentials are unused.

### Pipeline

- Keyword reject/human hay includes `session.header.cwd` (not `session.cwd`) and joins relative `file_path`/`path` onto cwd/workdir. Allow keywords still do not match the tool name or the session directory.
- Empty write/edit bodies are kept and shown on the judge card as `(empty)` / `(空)`. Missing payload still goes to a human.
- Connection RPC failures always include `{ code, message, details }` (`rpcFail`), matching the host `ConnectionRpcFailure` contract.
- Settings criteria label/description remount when the snapshot changes, so restore-defaults is not undone on blur.

### 中文

- **破坏性**：人工只走网页；去掉 QQ / 微信 / 飞书 / Telegram。插件配置改到 `~/.dsh/auto-approve/config.json`（可读的 0.1.x `approval-bridge/config.json` 会迁一次判定字段）。
- 关键词拒绝/人工干草含 `session.header.cwd`，相对路径会拼到 cwd/workdir；允许桶不含工具名和会话目录名。
- 空写入/替换仍进审核卡片（`(空)` / `(empty)`）。RPC 失败带 `message`。审核表恢复默认后输入框会随 snapshot 重挂。
