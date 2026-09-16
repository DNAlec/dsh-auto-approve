# dsh-auto-approve

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that auto-approves or rejects tool calls with **keywords** and a **judge model that returns a category plus a risk level**. Every category has three cells (low / medium / high), all yours to configure. Uncertainty goes to the original Web approval dialog.

## Install

```sh
dsh plugin --profile web add github:DNAlec/dsh-auto-approve
```

Or from npm, after a tagged release:

```sh
dsh plugin --profile web add @dnalec/dsh-auto-approve
```

> To pin a reproducible version, append `#vX.Y.Z` (the tag must match `package.json`, which the publish workflow checks).

Restart `dsh web`. The first start adds the **Auto-approve** permission preset to the current profile's `cordis.patch.yml`; if that write fails, the log line names the file and the reason.

## Setup

Settings → **Auto-approve**. Each control on the page carries one line of hint; the rules live here:

1. **Auto-approve mode** — in-workspace writes skip approval (`workspace-write`, recommended), or send them through the judge (`read-only`). Clicking a mode writes it; restart `dsh web`, then re-select **Auto-approve** or start a new session.
2. **Keywords** — three buckets: reject / human / allow. They match the **tool name, command, path, and working directory**, plus the values of custom-tool (MCP and friends) arguments with unrecognized names; they **never see written contents, code bodies, or numeric/boolean switches** (`{content:"rm -rf /"}`, `{recursive:true}` are judged by the model only). Reject/human words also match the tool name; allow words match neither the tool name nor the session directory, so `bash`/`write` is never allowed as a class.
3. **Criteria table** — a row is an English `id` + a description (state when to pick this id) + three cells (low/medium/high → action). The judge sees only the id and the description; the plugin runs the action in the **(row, level)** cell. `other` cannot be deleted, but its description and cells are editable. The id is what the approval history shows.
4. **Risk levels** — all three descriptions go into the prompt. **When the level is unreadable** (default `high`) also decides *which cell of that row* runs, so it decides the outcome: a `high` fallback rejects such calls, `medium` asks a human, `low` allows them.
5. **Judge model** — model, reasoning effort, judge timeout, the **judge request limit**, the **output budget (tokens)**, and whether a call that is **over the limit / hit the collection guard** goes to a human or is rejected (**arguments not captured are always rejected; not configurable** — see “How it works”). The same card holds the **judge prompt**: `{{criteria}}` inserts the criteria table and `{{levels}}` the level descriptions; a missing placeholder appends that block. It is editable, and restoring writes the shipped template of the language you pick and switches the language to it.
   The **output budget** (`judge.maxTokens`, default 8192, range 256-32768) caps how much the judge may write on its **first** attempt (reasoning tokens share that cap with the answer). A small cap breaks judgments: the model thinks by default, and locally it spent 3.7k-8.3k characters (≈2-5k tokens) on reasoning per call, so the old 1024 cap was always eaten by reasoning → empty answer → the plugin retried with a bigger budget, i.e. **every judgment paid a wasted model call** (double latency, tighter against the 20s timeout); the 2026-09-14 “every judgment goes to a human” outage was this chain at its extreme (the retry then was only 2048 and got eaten too). `maxTokens` is a **cap, not a reservation** — a model that does not think stops when done, so a generous value costs no extra time and only removes that doomed first call. It applies to routes that **may reason** (no effort configured but the route reports reasoning still counts); routes without reasoning stay at 256. The scene is visible in **Test judgment** and in the audit log.
6. **Model-initiated human review** (off by default) — when on, auto-rejections carry their reason and the model may escalate one operation to a human. The tool name is editable (restart to rename) and the notice language is Chinese or English. Enabling it turns the approval dialog into a channel the model can wake you through — including while it is being driven by untrusted content.
7. Set the session permission to **Auto-approve**.

Each restore button carries its own language (criteria, level descriptions, and prompt each ship in Chinese and English); the language you pick is written to the config and also sets the framework, card text, and reason language sent to the judge.

Upgrading: a criteria row went from one action to **three cells**. A legacy `action` is seeded into all three cells, and the `action` field disappears on the next write. **Since v22 the shipped cells are a risk scale: every row uses low = allow, medium = human, high = reject** — that is a **behaviour change** versus older versions (which shipped three rejects for risk rows, three allows for `safe`, three humans for `other`), so re-check the defaults and the fallback level after upgrading. A row whose cells you pulled apart yourself is never migrated. `other` is no longer special: it cannot be deleted, but its **description and all three cells are editable**, and it catches "output unparseable". The prompt gained `{{levels}}` and a third output line; **a custom template that never asks for a level makes every verdict use the configured fallback level** (default `high`).
**Since v23 two shipped texts were disambiguated** (again only texts still identical to the shipped wording are refreshed; anything you edited stays): the `system` row now says that scratch files under temp directories such as `/tmp` or `/var/tmp` are judged by what they actually do, not by the `/var` prefix, and the `low` level description was tightened from “this workspace **or scratch artifacts**” to “changes stay **inside this workspace** (including scratch artifacts created there)”. The old wording overlapped `medium`'s “files outside the workspace, caches” — the same out-of-workspace scratch write was measured landing on `low` (auto-allowed) once and on `medium` (human dialog) other times. The judge's **first-attempt output budget** also moved from 1024 to 8192 (configurable on the settings page); see item 5 above.

## How it works

Runs only when the session preset is Auto-approve. With `workspace-write`, in-workspace writes never reach approval. `danger-full-access` uses the same pipeline.

Pipeline: **reject keywords → “arguments not captured” is always rejected (no human dialog: a plugin-side capture failure, and the model is told to re-issue the same call) → human keywords → the “can we see it?” gate (collection guard hit / over the judge request limit: the action chosen on the **Judge model** card, a human by default) → allow keywords → judge (category + level) → the (row, level) cell**. Both halves matter: an explicit reject/human keyword also covers calls the gate catches, while an allow keyword can never let those through. Results outside the table split in two: a verdict the model **did** produce but that cannot be classified runs the **fallback row `other`'s cells**; a judgment that **never produced a result** (empty output, timeout, call failure, no usable route, plugin error) is not a verdict at all and **always goes to a human**, without consulting `other`'s cells. A cancelled request produces no verdict. **There is no “how much content” gate**: below the limit the card goes to the judge exactly as built — empty arguments, a lone `description`/`workdir`, pure numeric/boolean switches all included; the “nothing reviewable” switch has been removed outright (see CHANGELOG). **A custom tool (MCP and friends) whose argument names are unknown is not a missing payload**: its arguments reach the judge — key names included, nested paths like `params.command` too — and the keyword layer, and they are still recorded in the approval history. **Numeric and boolean arguments count as content**: switches such as `{recursive: true, force: true}` reach the judge card instead of being read as "no arguments".

**The judge either sees the operation complete or is not asked at all**: the card clips no field and has no entry cap; the limit measures the whole request (system prompt + card) against the **judge request limit** on the settings page (default 20000 characters, range 8192-1000000; the floor must cover the English shipped framework, about 5.8k characters). Over the limit the call follows the action chosen under **Judge model** (over the limit / collection guard hit) — choosing reject means no dialog, and the rejection reason travels back to the model as a closed-set note — and every trigger writes a log line and an audit row (`request=<actual>>budget`, or `oversize=collect>8388608` for the collection guard): a human escalation is never silent. The judge never receives a half-cut operation; `argsOmitted` in an event record is archive-layer only.

1. **Keywords** (when one call matches several buckets: reject > human > allow; the allow bucket only applies after the gate). Match tool name, command, path, working directory, and the request's `reason` text (that can only add matches, never remove them), **plus the values of custom-tool arguments with unrecognized names** (otherwise a call like `{cmd: 'rm -rf /'}` would walk around the red lines). **Keywords never see written contents, code bodies, or numeric/boolean switches** (`{content:"rm -rf /"}`, `{recursive:true}` — those are judged by the model only); they carry only the "catastrophic with zero context" red lines, so do not treat them as a catch-all and do not trim the criteria table on that assumption. The allow bucket only reads command/path/workdir: an unrecognized argument name never auto-allows. Allow words do not match the tool name or the session directory. **Shipped reject words are only the three classes that are catastrophic with zero context — the ones the model should not get a vote on**: (1) wiping the root, `rm -rf /` (which also covers `rm -rf /*` and `sudo rm -rf /`); (2) raw-device overwrite and formatting (`of=/dev/`, `mkfs`, `wipefs`, `Format-Volume`, `Clear-Disk`, `diskutil eraseDisk`); (3) the **gate's own config** (`.dsh/auto-approve`, `auto-approve/allowlist`, `auto-approve/config.json`, `.dsh/profiles`, `.dsh/config.yml`, `cordis.patch.yml`) and **private keys / cloud credentials** (`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, `.pem`/`.p12`/`.pfx`/`.jks`, `authorized_keys`, `.netrc`, `.git-credentials`, `.pypirc`, `~/.aws/credentials`, `~/.kube/config`). Public keys (`id_rsa.pub`) and pseudo-devices (`dd of=/dev/null`) do not match.
**Everything else goes to the judge and is decided by the row descriptions**: recursive deletes (`rm -rf` and friends, `sudo rm`, `Remove-Item -Recurse -Force`, `rd /s /q`), `chmod -R 777`, `git push --force`, `drop table`/`delete from`, `terraform destroy`, `docker system prune`/`volume rm`, shutdown/reboot, and credential files that tools rewrite themselves (`.env`, `.npmrc`, docker `config.json`). Regenerable directories and routine work are allowed; deleting user data or source, or damaging production or remote history, is rejected; uncertainty goes to a human. Every word pulled from the shipped table is recorded in `RETIRED_DEFAULT_KEYWORDS` — add it back to `DEFAULT_DENY_KEYWORDS` to restore a hard reject. Your own words can go to the **human** bucket (a Web dialog; empty by default). Dotfiles are matched loosely against path fields, so `prod.env` counts while `process.env` in a command does not.
2. **Judge model**. A row is just an **id + a description** that states when to pick that id. The judge returns the id, a risk level, and a one-sentence reason; the plugin runs the action in that **(row, level)** cell. Level descriptions are about reversibility and blast radius, and the level is judged independently of the category. When the model omits the level, returns a word outside the vocabulary, or a custom prompt never asks for one, the configured **fallback level** (default `high`) picks the cell. The model sees the same fields as the Web tool card **plus the custom tool's own argument names** (an MCP `cmd`, a nested `params.command`, appended as `Argument <key>: value`), fenced as untrusted data; the model's justification and the description are not the operation. The category must be **unique**: after stripping a card echoed back into the answer, exactly one table row may be readable — two different rows (including “one table row plus an unreadable label line”) fail closed to the fallback row. The level works the same way: contradictory levels are discarded and the **When the level is unreadable, use:** setting applies — echo never decides an allow. Unparseable output lands on `other` instead of going straight to a human — it runs `other`'s cells. A judgment that **never produced a result** (timeout, empty output, call failure, no route, plugin error) is different: those are not the model's verdict, so they **always go to a human**, regardless of `other`'s cells.

Default criteria (ids are lowercase English and are what the approval history shows; description and all three cells are editable; **every shipped row uses the same cells: low allows, medium asks a human, high rejects** — the level is the default risk scale; **other** cannot be deleted, but its description and cells are editable):

| id | When to pick it | Shipped cells (low/medium/high) |
|---|---|---|
| deletion | Deleting/emptying/truncating/irreversibly overwriting user data, databases, backups, history, or uncommitted work (single-file source edits, and routine changes to a clearly local or temporary dev database, do not count) | allow / human / reject |
| credential | Changing secrets, tokens, private keys, `.env`, `authorized_keys`, `kubeconfig`, `~/.aws`, `.npmrc` with tokens, git/pypi credentials | allow / human / reject |
| remote | Writing to remote hosts/production/databases, ssh/kubectl/cloud CLI mutations, cloud resource deletion (`terraform destroy`, `s3 rb --force`), force pushes that rewrite remote history, destructive SQL, publishing or production deploys (read-only queries, ordinary pushes, and **ops on a clearly local or temporary dev database** do not count; if the connection target is unclear, this row applies) | allow / human / reject |
| system | Changing `/etc`, `/usr` and other system paths, services and firewall, shutdown/reboot, user and permission management (including loosening to 777), crontab, shell rc, system-prefix installs | allow / human / reject |
| bulk | Recursive/glob/loop delete or overwrite of user data, source, config, or uncommitted work; format, `dd` onto a block device, `git reset --hard`, `git clean`, `rsync --delete`, volume destruction (regenerable dependency/build/cache/scratch dirs do not count) | allow / human / reject |
| approval-config | Changing the plugin's own config: allowlist, plugin config, profile patch (`cordis.patch.yml`, under `~/.dsh` by default) | allow / human / reject |
| safe | Confirmed routine reversible work: source/docs/test edits, build artifacts, installing dependencies, clearing logs or caches, cleaning scratch dirs, **routine changes to a clearly local or temporary dev database**, undoable single-file edits (do not pick for publishing, privilege escalation, sending data out, or when unsure) | allow / human / reject |
| other | None of the rows above fit, or it cannot be confirmed (it cannot be deleted, but its description and cells are editable like any other row) | allow / human / reject |

Risk levels ship as three fixed ids with editable descriptions:

| Level | Default description | Shipped action (same for every row) |
|---|---|---|
| low | Can be reverted as-is and its changes stay inside this workspace (including scratch and build artifacts created there) | allow |
| medium | Can be reverted but needs extra steps, or only touches local config, caches, or files outside the workspace | human |
| high | Cannot be reverted, or affects remote systems, production, other people, the OS, or credentials | reject |

**When the level is unreadable** is configurable (`levels.fallback`, default `high`): it is used when the model omits the line, returns a word outside the vocabulary (`critical`, `high-risk`), or a custom prompt never asks for a level.

There is no separate prompt-language switch: you pick the language when you click **Restore Chinese/English default criteria** or **Restore Chinese/English default prompt**, and that choice also sets the framework, card text, and reason language sent to the judge. Restoring default criteria only replaces the table and leaves custom prompts alone; the shipped Chinese and English packs share ids and actions and differ **only in the descriptions**. The description is both the model’s standard and the settings-page text. Custom prompts are stored per language, and the settings page edits the current language’s copy.

When a call is handed to a human, the **detail line in the approval dialog is rendered by this plugin**: the command first, otherwise path / content / argument summary (more than 4 arguments, or oversized content, always state the total — nothing is silently omitted). DSH’s own renderer only reads a top-level `command`, so `write`, `edit`, and MCP calls used to show nothing at all; now you can see what you are approving. Below it the plugin also writes a **Machine verdict:** line (the keyword that matched, or the criteria category and level): the headline belongs to the requester and cannot be changed, so this line is where the plugin explains why the call reached you. When the judge model really was asked, one more line follows — **Judge reason:**, the very `理由:` sentence that judgment produced (single line, 200 characters max, stating the total when it is cut; only 80 characters when the operation summary already fills its own 600-character budget). When the **judgment never ran** (empty output / timeout / call failed / no route / plugin error) that line is **not** written: what the event holds there is a closed-set `err.*` fact rather than the model's wording, the verdict line already says “judgment failed → human”, and the raw evidence is in the Approvals tab. Keyword-triggered escalation never asked the model at all, so it has no reason to show either.

## The judge model: “Model default” does not mean “do not think”

The Reasoning dropdown offers **Model default** (an empty value) plus whatever levels the route advertises. **Model default does not turn thinking off**: it is implemented as **leaving the reasoning option out of the request**. Saying nothing is not the same as saying “off” — the model falls back to its own default, and a model that thinks by default keeps thinking. Reasoning tokens and the answer **share the same output ceiling**, so when reasoning eats the budget you get `finish=max-tokens`, no text at all → the judgment fails → **it always asks a human** (safe, but you will see “why is everything popping a dialog?”).

The plugin handles this on its own, so you do not need to understand the above:

1. **The first attempt gets a real budget, and a failed one escalates by cause**: a route that may reason starts at **8192** (configurable as `judge.maxTokens`, range 256-32768) instead of the 1024 that reasoning always ate; if the answer is still empty, the `finish=max-tokens` retry gets `max(8192, first × 2)` — it must be **strictly larger than the first attempt**, since a fixed value stops being an escalation once the first attempt already is 8192. An empty answer with `finish=stop` still doubles: that is not a budget problem.
2. **The failure is visible and testable**: the **Judge model** card has a **Test judgment** button that runs one real call on a fixed small card and reports `category / text length / elapsed`, and on failure writes the scene out ( `err.judgeEmpty finish=max-tokens …` when it fails; if any judgment this run went to a human because the output was empty, the card shows a warning with counts (health is per process; restarting `dsh web` clears it).

If it still cannot judge, pick one of three:

| Option | How | Cost |
|---|---|---|
| **Use a model that does not think** (safest) | Settings → Judge model, pick a non-reasoning model | judgment quality depends on the model |
| Make it actually send “off” | if the route speaks pi-ai’s generic OpenAI format, give that model’s `reasoningEfforts.off` a string wire value (such as `none`; it is usually `null`) | depends on whether the gateway accepts it; if not you get a 400 → judgment fails → still safely asks a human |
| Pick a low level explicitly | set Reasoning to `minimal` / `low` (the level really is sent, unlike Model default) | it still thinks, just less |

The plugin **will not** touch your `~/.dsh/settings.yaml`: that file holds every route and API key, and how the level should be configured depends on your gateway. (The settings page used to offer an `off` option as well: it is the very same request as Model default, yet it had to pass the “level must be in the route's level table” check — on a route that does not list `off`, every judgment failed as a route error. A hand-written `off` in the config now reads as Model default.)

## After a rejection: the model learns why, and can ask you

On an auto-reject, DSH itself only tells the model `the user rejected tool "…"` — which is **the wrong attribution**: keyword red lines, criteria verdicts, and plugin errors all look like a human "no". This plugin attaches a note to that denied call saying it was a **machine verdict**, why (the matched keyword, the criteria row id and level, missing/truncated payload, the exact judge-failure source), and what to do next.

The reason is built only from **closed-set** facts: keywords from your own list, category ids from your own table. The judge model's prose `reason` is **never echoed back** — it carries command fragments and file contents, so re-injecting it would open an injection path.

A human denial, and "escalated but nobody answered", get their own wording too: DSH renders both as "the user rejected", and the model needs to know who actually said no.

### Model-initiated human review (off by default)

Once enabled in the settings page, every auto-reject notice offers the model one more route: **if it believes the step is required, it can escalate that one operation to a human decision.**

- Enabling this turns the approval dialog into a channel the model can trigger on its own — including while it is being driven by untrusted content. That is why it ships **off**.
- The escalation request is **always decided by a human**: it never goes through keywords, the criteria table, or the three cells. Otherwise "the escalation request itself gets auto-rejected" becomes a deadlock.
- An approval is good for **one retry with the same tool and identical arguments**. The retry passes; change the arguments and it goes through the full pipeline again. If the arguments contain fields dropped by the collection guard (a single value or the total exceeding 8 MB), the approval does **not** apply — that call goes through the gate, because those fields never reached the card or the record and you never saw them.
- **A human denial is terminal**: this session will not ask again for the same operation, and the model is told not to retry.
- The plugin builds the review dialog's sentence as one line: **Model-requested human review of "tool". Machine verdict: {verdict}. Operation: {summary}. Model's reason: {justification}**. The verdict (matched keyword, or criteria category and level) comes from the machine decision kept on file; the summary is condensed from the original call's arguments (oversized values keep head and tail and state the total; more than four arguments states that only the first four are listed); the reason is the model's own wording (it says "(truncated)" when cut to 300 characters). **These parts are joined with periods, never newlines**: DSH's dialog headline is a plain text node and collapses line breaks. On the native escalation path the plugin takes over the detail line and adds a **Machine verdict:** line of its own; DSH's built-in renderer only reads a top-level `command`, so `write`/MCP calls used to have no detail line at all.
- The tool name is configurable (default `request_human_approval`; renaming takes effect after a `dsh web` restart), and its notice language is independent of the judge prompt language.

## Data

Under `$DSH_HOME` (default `~/.dsh/`), never committed:

| Path | Purpose |
|---|---|
| `auto-approve/allowlist.json` | Keywords, criteria (three cells), risk-level descriptions and fallback, the action for over-limit / collection-guard hits, the **judge timeout** (written here by the settings page, authoritative at runtime) |
| `auto-approve/config.json` | Judge model, prompt language and custom prompts, the **judge request limit** (default 20000), model-initiated human review, and plugin settings such as the preset sandbox (`judge.timeoutMs` is only a default) |
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
