# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that auto-approves or rejects tool calls with **keywords** and a **judge-model criteria table**. Uncertainty goes to the original Web approval dialog.

## Install

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.2.0
```

Or from npm, after a tagged release:

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

Restart `dsh web`. The first start adds the **Auto-approve** permission preset.

## Setup

Settings → **Auto-approve**:

1. **Mode** — in-workspace writes skip approval (`workspace-write`, recommended), or send them through the judge (`read-only`). Save, restart `dsh web`, then re-select **Auto-approve** or start a new session.
2. **Keywords** and **criteria table** as needed. Restore default criteria loads the shipped pack for the selected judge-prompt language.
3. **Judge model** — empty follows the deployment default.
4. Set the session permission to **Auto-approve**.


## How it works

Runs only when the session preset is Auto-approve. With `workspace-write`, in-workspace writes never reach approval. `danger-full-access` uses the same pipeline. Missing or truncated tool args go to a human and are never auto-allowed.

1. **Keywords** (reject > human > allow). Match tool name, command, path, and working directory. Allow words do not match the tool name or the session directory. Shipped reject words cover disaster commands (`rm -rf`, `git push -f`, `drop table`, `dd of=`), approval-config paths, and credential paths such as `.env` / `id_rsa`.
2. **Criteria table**. The judge model sees the same fields as the Web tool card and outputs a category; the plugin runs that row’s action. Parse failure or timeout goes to a human.

Default criteria (actions are editable; **Other** cannot be deleted):

| id | Label | Default |
|---|---|---|
| deletion | Delete/overwrite irreplaceable data | reject |
| credential | Credentials/keys/auth changes | reject |
| remote | Remote/production/database | reject |
| system | System paths/config | reject |
| bulk | Bulk irreversible operations | reject |
| approval-config | Auto-approve configuration | reject |
| safe | Safe/routine reversible | allow |
| other | Other (unsure) | human |

Judge prompt language (Chinese or English) only changes the framework sent to the model, not the current table.

## Data

## Data

Under `$DSH_HOME` (default `~/.dsh/`), never committed:

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keywords, criteria, judge timeout |
| `auto-approve/config.json` | Judge model and plugin settings |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `OUTCOME` |
| `auto-approve/events.jsonl` | Approval tab events |

Corrupt files are not overwritten. Uninstalling the plugin does not delete this directory.

## Config

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # or read-only
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
```

Empty judge fields follow the deployment default. With no usable route, that request goes to a human. Settings “judge timeout” writes `allowlist.json` and wins at runtime.

## Development

```sh
node --test tests/*.test.mjs
npm run check
```

See [AGENTS.md](AGENTS.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
