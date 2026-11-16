# Beezi analytics for Claude Code

This plugin shows your own Beezi usage analytics inside Claude Code: spend, sessions, top model, a status and up to three recommendations, for the last 7 or 30 days. It is read-only. It records nothing and changes nothing in Beezi.

## Requirements

A Beezi account. The plugin signs in as you, and the summary covers your default Beezi workspace.

## Install

From Beezi's marketplace:

```
/plugin marketplace add Beezi-AI/beezi-claude-plugin-dev
/plugin install beezi-analytics-staging@beezi-internal
```

## Sign in

Run `/mcp`, choose the `beezi` server, then Authenticate. A browser window opens for your Beezi sign-in. Until you have signed in, the summary replies with the same instruction.

## Usage

```
/beezi-analytics-staging:analytics 7d
/beezi-analytics-staging:analytics 30d
/beezi-analytics-staging:about
```

`analytics` prints the summary for the period you give; with no period it uses 7 days. `about` explains what the plugin does and where the numbers come from.

## What it connects to

The plugin declares one MCP server, `beezi`, at `https://beezi-api-staging.azurewebsites.net/api/mcp`. The plugin has no hooks, scripts, commands or local code, and it uploads no conversation transcripts; only the arguments of the tools Claude calls reach Beezi. Its skills call only your personal summary. If you ask Claude other questions about your Beezi analytics, it may use the server's other read-only tools, which return only what your Beezi role lets you see.

## The full Beezi plugin

Sessions come from the full Beezi plugin, which records Claude Code usage and is installed from the Beezi portal. It includes this summary, so install one or the other.

## Links

- Documentation: https://docs.beezi.ai/coding-tool/beezi-analytics-plugin
- Privacy policy: https://beezi.ai/privacy-policy
- Terms: https://beezi.ai/terms-and-conditions
- Support: https://beezi.ai/contact-us

## License

Apache License 2.0. See `LICENSE`.
