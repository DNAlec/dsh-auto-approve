# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that auto-approves or rejects tool calls with **keywords** and a **judge-model criteria table**. Uncertainty goes to the original Web approval dialog.

## Install

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.2.1
```

Or from npm, after a tagged release:

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

Restart `dsh web`. The first start adds the **Auto-approve** permission preset to the current profile's `cordis.patch.yml`; if that write fails, the log line names the file and the reason.

## Setup

Settings → **Auto-approve**:

1. **Mode** — in-workspace writes skip approval (`workspace-write`, recommended), or send them through the judge (`read-only`). Clicking a mode writes it; restart `dsh web`, then re-select **Auto-approve** or start a new session.
2. **Keywords** and **criteria table** as needed. Restore default criteria loads the shipped pack for the selected judge-prompt language.
3. **Judge model** — empty follows the deployment default. Saved together with the prompt and timeout.
4. **Judge prompt** — language-specific built-in default, editable; restore default writes that language’s shipped template. Use `{{criteria}}` to insert the current criteria table.
5. Set the session permission to **Auto-approve**.


## How it works

Runs only when the session preset is Auto-approve. With `workspace-write`, in-workspace writes never reach approval. `danger-full-access` uses the same pipeline. Missing or truncated tool args go to a human and are never auto-allowed.

1. **Keywords** (reject > human > allow). Match tool name, command, path, and working directory. Allow words do not match the tool name or the session directory. Shipped reject words cover disaster commands (`rm -rf`, `git push -f`, `drop table`, `dd of=`), approval-config paths, and credential paths such as `.env` / `id_rsa`. Dotfiles are matched loosely against path fields, so `prod.env` counts while `process.env` in a command does not; `id_rsa.pub` is not treated as a credential.
2. **Criteria table**. The judge model sees the same fields as the Web tool card, fenced as untrusted data; it outputs a category and the plugin runs that row’s action. Parse failure or timeout goes to a human. The category is read from the **last** `Category:` line, so a tool card echoed back into the answer cannot override the verdict.

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

Judge prompt language (Chinese or English) only changes the framework, card labels, and that language’s default prompt, not the current table. The shipped prompt is generic classify rules and does not name default category ids; table-specific exceptions live in row descriptions. Custom prompts are stored per language.

## Data

Under `$DSH_HOME` (default `~/.dsh/`), never committed:

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keywords, criteria, judge timeout |
| `auto-approve/config.json` | Judge model, prompt language/custom prompts, and plugin settings |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `OUTCOME` |
| `auto-approve/events.jsonl` | Approval tab events |

Corrupt files are not overwritten. Uninstalling the plugin does not delete this directory.

## Config

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # or read-only
    judgePromptLang: zh              # or en: prompt framework, card labels, shipped pack
    judgePrompts:                    # optional per-language template override; '' = shipped
      zh: ''
      en: ''
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
    # profilePatch: /home/me/.dsh/profiles/web/cordis.patch.yml   # optional explicit override
```

Empty judge fields follow the deployment default. With no usable route, that request goes to a human. Settings “judge timeout” writes `allowlist.json` and wins at runtime.

The auto-approve preset is written into the running profile's patch file, resolved from the profile directory (`ctx.baseUrl`); `profilePatch` pins it explicitly when a deployment keeps profiles elsewhere.

A patch replaces a row's whole `config`, so the permission table this profile uses is the copy the plugin wrote (the shipped presets plus `auto-approve`). If a DSH upgrade adds or renames a shipped preset, startup compares against `@deepseek-ai/dsh-base`'s patch, logs the missing names, and the settings page shows a card telling you to update the plugin or merge that row by hand. The plugin never rewrites your file on its own.

## Development

```sh
node --test tests/*.test.mjs
npm run check          # syntax + locale sync check
npm run locales:sync   # regenerate client.js inline dictionaries from locales.mjs
```

See [AGENTS.md](AGENTS.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
