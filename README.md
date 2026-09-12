# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Cordis plugin: judge-model auto-approval and a settings page on the `approval/request` waterfall. The settings UI calls the model the **judge model** (审核模型).

What needs approval is decided by the Auto-approve preset sandbox (in-workspace writes skip approval, or they also enter the judge pipeline). Keyword and criteria-table actions are configurable; out-of-workspace `danger-full-access` **does not short-circuit on the mode name**.

This plugin is an answerer, not a replacement of the approval stack. `allowed-once` / `rejected` match clicking the Web buttons. Uncertainty calls `next()` and the original human dialog appears. Downstream plugins that wait on `approval.request()` or listen to `approval/asked` + `approval/decided` see the same outcomes.

**0.2.0** drops QQ / WeChat / Feishu / Telegram. Human review is Web-only.

## Install

Pin a release tag (recommended). `main` is for published commits; in-progress work lives on other branches.

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.2.0
```

From npm, after a tagged release:

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

A local checkout is fine while developing:

```sh
dsh plugin --profile web add /path/to/this-repo
```

Restart `dsh web`. The first start writes the `auto-approve` permission preset into the profile patch (the preset table cannot be extended at runtime).

## Setup

In Settings → **Auto-approve**:

1. Under **Auto-approve mode**, choose in-workspace writes without approval (preset sandbox `workspace-write`, recommended) or send them through the judge (`read-only`). After saving, restart `dsh web` and re-select **Auto-approve** or start a new session.
2. Set keywords and the criteria table if you need to. Restore defaults uses the selected judge-prompt language.
3. Set the judge model (empty follows the deployment default).
4. Set the session permission preset to **Auto-approve**. If it is missing after the first start, restart once more so the live patch reload can pick it up.

Uninstall (`dsh plugin --profile web remove @dnalec/dsh-auto-approve`) drops this plugin from the bundle stack after a restart. The `auto-approve` preset may remain in the profile patch: without the plugin it is ordinary `workspace-write` or `read-only` + `ask`. Rules and audit logs under `~/.dsh/auto-approve/` are not deleted.

## Behavior

| Situation | Result |
|---|---|
| Preset sandbox `workspace-write`, in-workspace write | No approval (sandbox already allows it) |
| Keyword or criteria action is reject | Immediate `rejected`; no dialog |
| Keyword or criteria action is allow | No dialog; green strip + `ALLOW` audit |
| Keyword/criteria human, or judge failure | Original Web approval dialog via `next()` |
| `danger-full-access` (outside workspace) | Same judge pipeline; does not short-circuit on the mode name |
| Judge model misconfigured / judge failure | That request goes to a human (`FAILED`); does not switch to the session model |
| Missing tool args (no command/path/content/code) | Human (`missing-payload`); never auto-allow |
| Captured fields truncated | Keyword reject still allowed; never auto-allow (`truncated-payload`) |
| Preset is not `auto-approve` | Does not answer (unless `onlyAutoApprovePreset` is off) |

Do not abort `req.signal` to close the Web dialog: that turns the whole request into `cancelled`.

## Pipeline

Intervenes only when `permissionPresets.current(session) === 'auto-approve'` (unless “only this preset” is off). The preset sandbox is a floor, not a pipeline step: with `workspace-write`, in-workspace writes never reach approval.

1. Keywords (reject > human > allow). Reject/human match **tool name + command + path + workdir** (including the session working directory `session.header.cwd`; relative `file_path`/`path` are joined onto cwd/workdir). Allow words do not match the tool name or the session directory name. Do not match model justification, `description`, or file body. Empty write/edit bodies are still shown on the judge card as `(empty)`. Shipped words default to reject, including disaster command shapes (`rm -rf`, `git push -f`, `drop table`, `dd of=`), approval-config paths, and credential paths such as `.env` / `id_rsa`. Misses go to the next step. Truncated captured fields can still keyword-reject; keyword-allow and model `safe` are forbidden, so it goes to a human.
2. Criteria table: the judge model sees the same fields as the Web tool card (command, path, original/replacement, write contents, code/url/sql, …) and only outputs a category id + reason; the program runs allow / reject / human from the table. Parse failure or timeout goes to a human and does **not** run the “Other” action. Risk rows default to reject; “safe” defaults to allow; “Other” defaults to human.

Default criteria (actions are editable; “Other” cannot be deleted):

| id | Label | Default action |
|---|---|---|
| deletion | Delete/overwrite irreplaceable data | reject |
| credential | Credentials/keys/auth changes | reject |
| remote | Remote/production/database | reject |
| system | System paths/config | reject |
| bulk | Bulk irreversible operations | reject |
| approval-config | Auto-approve configuration | reject |
| safe | Safe/routine reversible | allow |
| other | Other (unsure) | human |

Risk rows default to reject. Only confirmed-safe work goes through `safe` auto-allow; uncertainty goes to “Other” then a human. If the model puts a dangerous operation in `safe`, it will be auto-allowed.

Settings can set the **judge prompt language** to Chinese or English (default Chinese). That only swaps the framework and card labels sent to the model; it does **not** rewrite the current table. “Restore default criteria” loads the shipped pack for the selected language. Reasons use the same language as the framework.

Host API uses authenticated `connection.rpc` (`/api/dsh-auto-approve`), not unauthenticated HTTP.

Other plugins may listen to `auto-approve/decision` for leaf fields of the pipeline (`sessionId`, `tool`, `path`, `verdict`, …). That event is informational; it cannot change the outcome. Official results remain `approval/asked` + `approval/decided`.

## Data

Under `$DSH_HOME` (default `~/.dsh/`), never committed.

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keyword buckets / criteria / judge timeout (`0600`) |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `OUTCOME` (`0600`) |
| `auto-approve/events.jsonl` | UI events (including `sessionId`; over ~2MB keep last 2000, `0600`) |
| `auto-approve/config.json` | Judge model and plugin settings (`0600`) |

If `auto-approve/config.json` is missing and `approval-bridge/config.json` from 0.1.x is readable, only judge / preset / language fields are copied. A corrupt file is not overwritten.

No audit line = this plugin did not handle that request.

## Config

```yaml
- id: dsh-auto-approve
  config:
    onlyAutoApprovePreset: true
    presetSandbox: workspace-write   # or read-only: workspace writes also go through the judge
    judge:
      provider: ''
      model: ''
      reasoningEffort: ''
      timeoutMs: 20000
```

Empty judge fields follow the deployment default model. With no default to follow and no manual config, or a bad route, that request goes to a human. The plugin will not guess a model. The settings “judge timeout” writes `judgeTimeoutMs` in `allowlist.json` (that value wins at runtime); yaml `judge.timeoutMs` is only the default before an allowlist exists.

JSON read failure (corrupt) uses in-memory defaults for this process and **does not overwrite disk**. The settings page will not write a bad allowlist except “restore defaults / overwrite corrupt config”; corrupt plugin config needs an explicit overwrite.

## Development

```sh
node --test tests/*.test.mjs
npm run check
```

Layout: `src/index.mjs` (host), `src/rules.mjs`, `src/preset-patch.mjs`, `src/util.mjs`, `client.js` (Web half; React via `createElement`, no JSX), `locales.mjs` (Web zh/en dictionaries). Web copy follows the DSH language setting.

For agents working in this repository, follow [AGENTS.md](AGENTS.md).

## Releasing

See [CHANGELOG.md](CHANGELOG.md) for what landed in each tag.

1. Set `package.json` `version` (for example `0.2.0`) and merge to `main`.

2. On npmjs.com, add a Trusted Publisher for this GitHub repo, workflow file `publish.yml` (once).
3. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The tag must match `package.json` version. The workflow runs tests, then `npm publish`. The first publish of the package name may need a local `npm login` and `npm publish --access public` once; later tags are enough.

## License

[MIT](LICENSE)
