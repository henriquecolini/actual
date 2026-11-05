# This fork: icons and an AI budgeting assistant

This is a personal fork of [Actual Budget](https://github.com/actualbudget/actual)
(based on `v26.11.0`). It adds two things. Everything else is upstream.

1. **Icons** on categories and accounts, with a background color, and bank logos
   for accounts.
2. **An AI assistant** that chats about your budget, categorizes transactions,
   spots problems and suggests changes, plus an **MCP server** so other AI tools
   can read the same data.

## Icons

- Right-click a category or account in the sidebar and choose **Change icon** (for categories you can also
  click the icon itself). On mobile, open the category/account sheet and tap
  **Change icon**.
- Pick from every [Tabler icon](https://tabler.io/icons) (about 6,300; searchable)
  and a color. Accounts can also use a bank logo (Nubank, Itaú, Inter, Caixa, C6,
  Bradesco, Santander, BTG, Sicoob, Safra, PicPay, Mercado Pago, PagBank, Pan,
  Neon, Next, Carrefour). Add more by dropping an SVG into
  `packages/desktop-client/src/assets/bank-logos/` and one line in `bankLogos.ts`.
- Icons show in the sidebar, budget rows, autocompletes, transaction rows, the
  account page title and the mobile lists.
- Stored as two nullable columns on `categories` and `accounts` (`icon`,
  `icon_color`), added by an additive migration, so they sync like any other
  field and older clients keep working.

## AI assistant

Open it with the sparkle button in the top bar (needs a sync server and a budget
uploaded to it). It is per user: each person connects their own account.

**What it does**

- Answers questions and reviews your budget using real data (spending, trends,
  recurring payments, anomalies, duplicates, budget health, net worth).
- Asks you questions with selectable options when a choice is yours.
- Suggests changes (categories, rules, budget amounts, icons) as review cards.
  **Nothing changes until you approve it**, and applied changes can be undone
  with Ctrl/⌘+Z.

**Connecting a model** (Settings → AI Assistant)

| Option              | What you need                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription | Run `claude setup-token` on any computer and paste the token. Uses your Claude plan through the Claude Code CLI on the server.                       |
| API key             | OpenRouter, DeepSeek, OpenAI, Google Gemini, xAI, Ollama Cloud, or any OpenAI-compatible server (vLLM, LM Studio, LiteLLM, Ollama) via a custom URL. |

Tokens and keys are stored encrypted (AES-256-GCM) in the server's account
database and are never sent to the browser again.

**Server settings** (environment variables, all optional)

| Variable               | Purpose                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ACTUAL_AI_SECRET_KEY` | Key used to encrypt stored tokens. If unset, one is generated at `<server-files>/ai-secret.key`. Keep it with your backups. |
| `ACTUAL_AI_DATA_DIR`   | Where per-user AI state lives (default `<data dir>/ai`).                                                                    |
| `ACTUAL_CLAUDE_BIN`    | Path to the `claude` binary (default: `claude` on `PATH`; the image installs it).                                           |
| `ACTUAL_MCP_PATH`      | Override the MCP server entry point.                                                                                        |
| `ACTUAL_AI_SERVER_URL` | URL the assistant's helper process uses to reach this server (default `http://127.0.0.1:<port>`).                           |

**Limits to know about**

- Budgets with end-to-end encryption are not supported by the assistant.
- Each question you send opens your budget in a helper process (a cached copy is
  kept per user, so later runs only sync changes).
- Using a subscription token is meant for personal, self-hosted use.

### Use your budget from other AI tools (MCP)

Settings → AI Assistant → **Use from other AI tools** creates a token and shows
the command to add the server to Claude Code (or any MCP client):

```sh
claude mcp add actual \
  -e ACTUAL_SERVER_URL=https://your-server \
  -e ACTUAL_SESSION_TOKEN=<token> \
  -e ACTUAL_SYNC_ID=<sync id> \
  -e ACTUAL_DATA_DIR=$HOME/.actual-mcp \
  -- node /path/to/actual/packages/mcp-server/dist/mcp.js
```

The server is read-only plus `propose_*` tools by default. Set
`ACTUAL_MCP_WRITE=1` to also expose tools that modify the budget
(`update_transactions`, `set_budget_amount`, `create_category`, `set_icon`).
Build it with `yarn workspace @actual-app/api build && yarn workspace @actual-app/mcp build`.

## Running it

Build and run the image (the build installs the Claude Code CLI):

```sh
docker build -f sync-server.Dockerfile -t actual-server:custom .
docker run -d -p 5006:5006 -v actual-data:/data actual-server:custom
```

The `custom-image` workflow builds and pushes
`ghcr.io/<owner>/actual-server:custom` (amd64 and arm64) on every push to the
`custom` branch. Back up your data volume before switching images; the
migrations are additive.

## Development

```sh
yarn install
yarn start              # web client on :3001 (use "Try the demo")
yarn typecheck && yarn lint && yarn test
```

Notes:

- The MCP server's integration tests use the built API. After `yarn typecheck`
  (which overwrites `packages/api/dist`), rebuild it with
  `yarn workspace @actual-app/api build` before running them.
- Where things live: `packages/mcp-server` (tools and analysis),
  `packages/sync-server/src/ai` and `src/app-ai.ts` (runtimes, questions,
  storage, API), `packages/desktop-client/src/ai` and `components/ai` (chat UI),
  `components/common/EntityIcon` (icons).

## Staying up to date with upstream

```sh
git remote add upstream https://github.com/actualbudget/actual.git   # once
git fetch upstream --tags
git rebase <new-tag>      # e.g. v26.12.0, on the custom branch
```

Most changes are new files; the edits to upstream files are small and local
(sidebar rows, autocompletes, transaction cells, the schema, the account handler,
the Dockerfile). Re-run `yarn typecheck`, `yarn lint` and `yarn test` after a
rebase, and check that the icon migration timestamp still sorts after upstream's
newest migration.
