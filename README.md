# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that auto-approves or rejects tool calls with **keywords** and a **judge model that returns a category plus a risk level**. Every category has three cells (low / medium / high), all yours to configure. Uncertainty goes to the original Web approval dialog.

## Install

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.3.0
```

Or from npm, after a tagged release:

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

Restart `dsh web`. The first start adds the **Auto-approve** permission preset to the current profile's `cordis.patch.yml`; if that write fails, the log line names the file and the reason.

## Setup

Settings → **Auto-approve**:

1. **Mode** — in-workspace writes skip approval (`workspace-write`, recommended), or send them through the judge (`read-only`). Clicking a mode writes it; restart `dsh web`, then re-select **Auto-approve** or start a new session.
2. **Keywords**, the **criteria table** (three cells per row: low/medium/high → action), **Risk levels** (three descriptions plus which level to use when the level is unreadable) and **When nothing can judge** (missing args / truncated args: human or reject) as needed. Each restore button carries its own language (criteria, level descriptions, and prompt each ship in Chinese and English); the language you pick also sets the judge-prompt language.
3. **Judge model** — empty follows the deployment default. Saved together with the prompt and timeout.
4. **Judge prompt** — editable; restoring writes the shipped template of the language you pick and switches the language to it. Use `{{criteria}}` to insert the current criteria table.
5. Set the session permission to **Auto-approve**.

Upgrading: a criteria row went from one action to **three cells**. A legacy `action` is seeded into all three cells, so **behaviour is byte-for-byte identical to the old version** until you pull the cells apart yourself; the `action` field disappears on the next write. `other` is no longer special: it cannot be deleted, but its **description and all three cells are editable**, and it now also catches "output unparseable" and "judgment never ran". The prompt gained `{{levels}}` and a third output line; **a custom template that never asks for a level makes every verdict use the configured fallback level** (default `high`).

## How it works

Runs only when the session preset is Auto-approve. With `workspace-write`, in-workspace writes never reach approval. `danger-full-access` uses the same pipeline.

Pipeline: **keywords → missing/truncated switch → judge (category + level) → the (row, level) cell**. Anything that is not a table result (unparsed output, empty output, timeout, call failure, no usable route, plugin error) runs the **fallback row `other`'s cells**; a cancelled request produces no verdict. **A custom tool (MCP and friends) whose argument names are unknown is not a missing payload**: its arguments reach the judge — key names included, nested paths like `params.command` too — and the keyword layer. Only a tool that gave no string argument at all, or a truncated field, follows the two switches under **When nothing can judge** (human by default, never auto-allowed).

1. **Keywords** (reject > human > allow). Match tool name, command, path, and working directory, **plus the values of custom-tool arguments with unrecognized names** (otherwise a call like `{cmd: 'rm -rf /'}` would walk around the red lines). The allow bucket only reads command/path/workdir: an unrecognized argument name never auto-allows. Allow words do not match the tool name or the session directory. **Shipped reject words are only the three classes that are catastrophic with zero context — the ones the model should not get a vote on**: (1) wiping the root, `rm -rf /` (which also covers `rm -rf /*` and `sudo rm -rf /`); (2) raw-device overwrite and formatting (`of=/dev/`, `mkfs`, `wipefs`, `Format-Volume`, `Clear-Disk`, `diskutil eraseDisk`); (3) the **gate's own config** (`.dsh/auto-approve`, `.dsh/profiles`, `.dsh/config.yml`, `cordis.patch.yml`, `auto-approve/allowlist`) and **private keys / cloud credentials** (`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, `.pem`/`.p12`/`.pfx`/`.jks`, `authorized_keys`, `.netrc`, `.git-credentials`, `.pypirc`, `~/.aws/credentials`, `~/.kube/config`). Public keys (`id_rsa.pub`) and pseudo-devices (`dd of=/dev/null`) do not match.
**Everything else goes to the judge and is decided by the row descriptions**: recursive deletes (`rm -rf` and friends, `sudo rm`, `Remove-Item -Recurse -Force`, `rd /s /q`), `chmod -R 777`, `git push --force`, `drop table`/`delete from`, `terraform destroy`, `docker system prune`/`volume rm`, shutdown/reboot, and credential files that tools rewrite themselves (`.env`, `.npmrc`, docker `config.json`). Regenerable directories and routine work are allowed; deleting user data or source, or damaging production or remote history, is rejected; uncertainty goes to a human. Every word pulled from the shipped table is recorded in `RETIRED_DEFAULT_KEYWORDS` — add it back to `DEFAULT_DENY_KEYWORDS` to restore a hard reject. Your own words can go to the **human** bucket (a Web dialog; empty by default). Dotfiles are matched loosely against path fields, so `prod.env` counts while `process.env` in a command does not.
2. **Judge model**. A row is just an **id + a description** that states when to pick that id. The judge returns the id, a risk level, and a one-sentence reason; the plugin runs the action in that **(row, level)** cell. Level descriptions are about reversibility and blast radius, and the level is judged independently of the category. When the model omits the level, returns a word outside the vocabulary, or a custom prompt never asks for one, the configured **fallback level** (default `high`) picks the cell. The model sees the same fields as the Web tool card **plus the custom tool's own argument names** (an MCP `cmd`, a nested `params.command`, appended as `Argument <key>: value`), fenced as untrusted data; the model's justification and the description are not the operation. The category is read from the **last** `Category:` line and the level from the last recognizable value, so a tool card echoed back into the answer cannot override the verdict. Unparseable output lands on `other` instead of going straight to a human — it runs `other`'s cells.

Default criteria (ids are lowercase English and are what the approval history shows; description and all three cells are editable; shipped cells are all equal and **no loosening cell ships**; **other** cannot be deleted, but its description and cells are editable):

| id | When to pick it | Shipped cells (low/medium/high, all equal) |
|---|---|---|
| deletion | Deleting/emptying/truncating/irreversibly overwriting user data, databases, backups, history, or uncommitted work (single-file source edits, and routine changes to a clearly local or temporary dev database, do not count) | reject |
| credential | Changing secrets, tokens, private keys, `.env`, `authorized_keys`, `kubeconfig`, `~/.aws`, `.npmrc` with tokens, git/pypi credentials | reject |
| remote | Writing to remote hosts/production/databases, ssh/kubectl/cloud CLI mutations, cloud resource deletion (`terraform destroy`, `s3 rb --force`), force pushes that rewrite remote history, destructive SQL, publishing or production deploys (read-only queries, ordinary pushes, and **ops on a clearly local or temporary dev database** do not count; if the connection target is unclear, this row applies) | reject |
| system | Changing `/etc`, `/usr` and other system paths, services and firewall, shutdown/reboot, user and permission management (including loosening to 777), crontab, shell rc, system-prefix installs | reject |
| bulk | Recursive/glob/loop delete or overwrite of user data, source, config, or uncommitted work; format, `dd` onto a block device, `git reset --hard`, `git clean`, `rsync --delete`, volume destruction (regenerable dependency/build/cache/scratch dirs do not count) | reject |
| approval-config | Changing the plugin's own config: allowlist, plugin config, profile patch (`cordis.patch.yml`, under `~/.dsh` by default) | reject |
| safe | Confirmed routine reversible work: source/docs/test edits, build artifacts, installing dependencies, clearing logs or caches, cleaning scratch dirs, **routine changes to a clearly local or temporary dev database**, undoable single-file edits (do not pick for publishing, privilege escalation, sending data out, or when unsure) | allow |
| other | Neither a risk row nor routine reversible work fits, or you are unsure; also for harmless-looking work whose reversibility cannot be confirmed (fallback row: cannot be deleted; it also catches unparsed output and failed judgments) | human |

Risk levels ship as three fixed ids with editable descriptions:

| Level | Default description | Shipped cells |
|---|---|---|
| low | Can be reverted as-is and only affects this workspace or scratch artifacts | each row's shipped action |
| medium | Can be reverted but needs extra steps, or only touches local config, caches, or files outside the workspace | same |
| high | Cannot be reverted, or affects remote systems, production, other people, the OS, or credentials | same |

**When the level is unreadable** is configurable (`levels.fallback`, default `high`): it is used when the model omits the line, returns a word outside the vocabulary (`critical`, `high-risk`), or a custom prompt never asks for a level.

There is no separate prompt-language switch: you pick the language when you click **Restore Chinese/English default criteria** or **Restore Chinese/English default prompt**, and that choice also sets the framework, card text, and reason language sent to the judge. Restoring default criteria only replaces the table and leaves custom prompts alone; the shipped Chinese and English packs share ids and actions and differ **only in the descriptions**. The description is both the model’s standard and the settings-page text. Custom prompts are stored per language, and the settings page edits the current language’s copy.

## Data

Under `$DSH_HOME` (default `~/.dsh/`), never committed:

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keywords, criteria (three cells), risk-level descriptions and fallback, missing/truncated switches, judge timeout |
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
    judgePromptLang: zh              # current prompt language: chosen by the settings-page Restore actions
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

## Recommended: [dsh-message-push](https://github.com/DNAlec/dsh-message-push)

This plugin decides the bulk of tool calls on its own; only the uncertain ones come back as a Web dialog or a question. **dsh-message-push is what tells you when that happens**, so you can leave the screen while a long session runs: it pushes to your configured messaging platforms when a session stops (completed / interrupted / blocked / failed / token limit) and immediately when an **approval** or an **answer** is needed.

The two are deliberately split: this plugin answers approvals (allow / reject, otherwise it hands the request to the original dialog), while dsh-message-push only observes them, never decides anything and never injects a reply back into a session. It carries a `messagePush` service too, so other plugins can reuse its channels.

```sh
dsh plugin --profile web add github:DNAlec/dsh-message-push
```

Then restart `dsh web` and connect at least one channel under Settings → **Message push**; its README lists the platforms it currently supports.

## License

[MIT](LICENSE)
