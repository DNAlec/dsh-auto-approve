# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Cordis plugin: judge-model auto-approval, QQ official Bot human approval, and a settings page — on one `approval/request` waterfall. The settings UI calls the model the **judge model** (审核模型).

What needs approval is decided by the Auto-approve preset sandbox (in-workspace writes skip approval, or they also enter the judge pipeline). Keyword and criteria-table actions are configurable; out-of-workspace `danger-full-access` **does not short-circuit on the mode name**. Requests that need a human appear on both the Web UI and a configured QQ chat; **the first answer wins**.

Scope is approval only. The QQ bot is a notify-and-reply channel, not an agent chat.

## Install

Pin a release tag (recommended). `main` is for published commits; in-progress work lives on other branches.

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve#v0.1.2
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

1. Click **Scan to create bot**, then scan with mobile QQ (official Open Platform flow). Or paste AppID / AppSecret and save.
2. Friend the bot and send it any message. Pick the chat under **Recent incoming** (private chat recommended). Group chats must @ the bot and set `userId`. Scanning may prefill the scanner’s openid as `chatId` if none is set. This plugin is for a **private bot**: if no `chatId` is bound yet, any C2C reply of `是` / `确认` / `用作审批` / `yes` / `ok` binds that chat as the approval target. Do not add the bot where strangers can DM it.
3. Under **Auto-approve mode**, choose in-workspace writes without approval (preset sandbox `workspace-write`, recommended) or send them through the judge (`read-only`). After saving, restart `dsh web` and re-select **Auto-approve** or start a new session.
4. Set the session permission preset to **Auto-approve**. If it is missing after the first start, restart once more so the live patch reload can pick it up.

Credentials are stored only in `~/.dsh/approval-bridge/qqbot.json` (`0600`). Do not commit them.

Uninstall (`dsh plugin --profile web remove @dnalec/dsh-auto-approve`) drops this plugin from the bundle stack after a restart. The `auto-approve` preset may remain in the profile patch: without the plugin it is ordinary `workspace-write` or `read-only` + `ask`. Rules, audit logs, and QQ credentials under `~/.dsh/auto-approve/` and `~/.dsh/approval-bridge/` are not deleted.

## Behavior

| Situation | Result |
|---|---|
| Preset sandbox `workspace-write`, in-workspace write | No approval (sandbox already allows it) |
| Keyword or criteria action is reject | Immediate `rejected`; no dialog, no QQ |
| Keyword or criteria action is allow | No dialog, no QQ; green strip + `ALLOW` audit |
| Keyword/criteria human, or judge failure | QQ gets `#N`; reply `批准 N` to continue |
| `danger-full-access` (outside workspace) | Same judge pipeline; does not short-circuit on the mode name |
| Web UI and QQ both prompt | First outcome wins; QQ answering first dismisses the Web dialog (forked signal, not `req.signal`) |
| QQ wait timeout (default 120s) | Web dialog stays open; QQ says continue in the browser |
| No credentials / not connected | Auto-approval still runs; humans only on the Web UI (`PUSH_SKIP`) |
| Judge model misconfigured / judge fails | Escalate to human (`FAILED`); do not fall back to the session model |
| Tool args missing (no command/path/content/code, …) | Human (`missing-payload`); never auto-allow |
| Captured field truncated | Keyword reject still applies; never auto-allow (`truncated-payload`) |
| Preset is not `auto-approve` | Do not answer, do not push (unless `onlyAutoApprovePreset` is off) |

QQ approval pushes include Allow / Reject buttons (custom keyboard in C2C and group chats). Text still works: `批准 17` / `#17 批准` / `yes 17` allow; `拒绝 17` rejects once. A bare `批准` / `拒绝` is allowed only when exactly one ticket is pending.

Do not abort `req.signal` to dismiss the Web dialog: that cancels the whole request.

## Pipeline

Only when `permissionPresets.current(session) === 'auto-approve'` (unless that restriction is disabled). The preset sandbox is a gate, not a pipeline step: with `workspace-write`, in-workspace writes never reach approval.

1. Keywords (reject > human > allow). Reject/human match **tool name + command + path + workdir**; allow keywords do not match the tool name. They do not match the model justification, `description`, or file bodies. Shipped phrases default to reject: catastrophic command shapes, auto-approve config paths, and credential paths (`.env`, `id_rsa`, …). Anything missed goes to the next step. If a captured field is truncated, keyword reject still applies; keyword allow and judge-safe do not — that request goes to a human.
2. Criteria table: the judge model sees the same fields as the Web tool card (command, path, old/new text, write content, code/url/sql, …) and emits only a category id + reason; the program applies allow / reject / human. Parse failure or timeout → human and does **not** run `other.action`. Risk rows default to reject; `safe` defaults to allow; `other` defaults to human.

Default criteria (actions are editable; `other` cannot be deleted):

| id | Label | Default |
|---|---|---|
| deletion | Destructive delete/overwrite | reject |
| credential | Credentials / secrets / auth | reject |
| remote | Remote / production / database | reject |
| system | System paths / config | reject |
| bulk | Bulk irreversible ops | reject |
| approval-config | Auto-approve config | reject |
| safe | Safe / routine reversible | allow |
| other | Uncertain / none of the above | human |

Risk rows default to reject. Auto-allow only when the model can confirm `safe`. Uncertainty goes to `other` (human). Mis-filing a dangerous op as `safe` is still auto-allowed.

Settings can set **judge prompt language** to Chinese or English (default Chinese). That switches only the prompt framework and card labels; it does **not** rewrite the current criteria table. Restore default criteria loads the shipped pack for the selected language. The reason line uses the same language as the framework.

Host APIs use authenticated `connection.rpc` (`/api/dsh-auto-approve`), not unauthenticated HTTP.

## Data

Under `$DSH_HOME` (default `~/.dsh/`). None of this belongs in git.

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keyword buckets / criteria / judge timeout (`0600`) |
| `auto-approve/audit.log` | `ALLOW` / `REJECT` / `HUMAN` / `FAILED` / `PUSH` / `PUSH_SKIP` / `PUSH_FAIL` / `OUTCOME` (`0600`) |
| `auto-approve/events.jsonl` | UI events (`ticket`, `sessionId`; trimmed to last 2000 lines after ~2MB, `0600`) |
| `approval-bridge/qqbot.json` | AppID / AppSecret, `0600` |
| `approval-bridge/config.json` | Judge model, notify target, and other plugin config (`0600`) |

No audit line means this plugin did not handle that request.

## Configuration

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
    notify:
      enabled: true
      chatId: ''
      userId: ''
      timeoutSecs: 120
```

Empty judge fields follow the deployment default model. If there is no default and nothing is configured, or the route is invalid, that request goes to a human. There is no hardcoded fallback model. The settings **Judge timeout** writes `judgeTimeoutMs` in `allowlist.json` (that is what runtime uses); yaml `judge.timeoutMs` is only a default when allowlist does not exist yet.

If a JSON file cannot be parsed, this process uses in-memory defaults and **does not overwrite the file**. Settings will not write a corrupt allowlist except Restore defaults; a corrupt plugin config needs an explicit overwrite; corrupt QQ credentials need a re-save or QR scan.

## Development

```sh
node --test tests/*.test.mjs
npm run check
```

Layout: `src/index.mjs` (host), `src/rules.mjs`, `src/tickets.mjs`, `src/qqbot.mjs`, `src/provisioning.mjs` (official QR), `src/preset-patch.mjs`, `src/util.mjs`, `client.js` (Web UI; React via `createElement`, no JSX), `locales.mjs` (zh/en Client copy). The Web UI follows the DSH language setting; QQ push text and audit logs stay Chinese. QR login uses `@tencent-connect/qqbot-connector` (optional) and generates the image locally with `qrcode`.

For agents working in this repository, follow [AGENTS.md](AGENTS.md).

## Releasing

1. Set `package.json` `version` (for example `0.1.2`) and merge to `main`.
2. On npmjs.com, add a Trusted Publisher for this GitHub repo, workflow file `publish.yml` (once).
3. Tag and push: `git tag v0.1.2 && git push origin v0.1.2`.

The tag must match `package.json` version. The workflow runs tests, then `npm publish`. The first publish of the package name may need a local `npm login` and `npm publish --access public` once; later tags are enough.

## License


[MIT](LICENSE)
