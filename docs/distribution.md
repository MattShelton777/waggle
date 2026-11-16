# Distributing the Waggle skill

Checked against the Claude Code and Claude help docs on 2026-11-16.

## What updates for everyone, and what doesn't
- **Server-side (updates on deploy, for every account):** tool descriptions, `waggle_get_rules` (rules text and version), the blueprint content and `notices`. Anything that changes often belongs here.
- **MCP server instructions:** sent on initialize, but the docs don't say whether Claude puts them in the model's context, so don't rely on them alone. Tool descriptions and `waggle_get_rules` are the dependable channel.
- **The skill (SKILL.md):** kept high level on purpose, so it rarely needs a change. How a change reaches people depends on where they installed it (below).

## Claude Code: plugin from this repo
The repo is a plugin marketplace. `.claude-plugin/marketplace.json` lists one plugin, `plugins/waggle`, which bundles the skill and the remote MCP server (OAuth with dynamic registration, so no client id is needed).

```
/plugin marketplace add MattShelton777/waggle
/plugin install waggle@waggle
```

Updates: installed plugins don't update on their own. Auto-update is a per-marketplace toggle that is off by default for third-party marketplaces, so tell users to turn it on (`/plugin` > Marketplaces > Enable auto-update), or run `claude plugin update waggle@waggle`. Bump `version` in `plugins/waggle/.claude-plugin/plugin.json` on every change, or clients won't see an update.

## claude.ai and Claude Desktop
- **Connector:** each user adds the MCP URL as a custom connector (Settings > Connectors). This is the part that carries the server-side updates.
- **Skill, one person:** upload `apps/connect/downloads/waggle-skill.zip` in Customize > Skills (needs code execution on). A change means uploading the new zip again.
- **Skill, a Team or Enterprise org:** an owner can provision it to all members from Organization settings. Updates by the owner reach members at next use.
- There is no documented way for a third party to push a skill into other organizations, so the skill can't be updated across every account from here.

## Rule of thumb
Put anything that changes in the server. Change the skill only when the flow itself changes (pull, read the blueprint, check docs narrowly, build, report).
