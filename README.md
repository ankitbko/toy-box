# 🧸 Toy Box

<img width="1000" src="https://github.com/user-attachments/assets/7964dab2-ca7c-4bc4-8e00-cbb85afa9c8b" />

## Features

1. Start + resume agentic coding sessions via Foundry hosted agents
1. CMD+click sessions to open a grid of sessions (up to 4)
1. Sessions track in-progress/unread state, which is synced across all clients
1. PWA/responsive layout makes working on sessions from your phone a breeze
1. Automated sessions allow you to schedule recurring tasks

## Getting Started

1. Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and authenticate with `az login`
1. Deploy a GitHub Copilot hosted agent to Foundry (see the [hosted-agents sample](https://github.com/microsoft/hosted-agents-vnext-private-preview))
1. Set the `AGENT_BASE_URL` environment variable to your agent's base URL, or configure it in the Settings dialog
1. Run `npx @lostintangent/toy-box` (or `bunx @lostintangent/toy-box`)
1. Start running agentic tasks on your hosted agent 🚀

> **Note:** Terminal support is not available with hosted agents (WebSocket not supported).

## Developing

1. Clone this repo
1. Run `bun install`
1. Set `AGENT_BASE_URL` to your hosted agent URL
1. Run `bun dev`
