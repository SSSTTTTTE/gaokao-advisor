# Gaokao Major Advisor

Mobile-first Gaokao volunteer-filling chat agent built with CopilotKit v2, DeepSeek, official-first score lookup, optional MCP rank lookup, and the local `zhangxuefeng-perspective` skill.

## What It Does

- Uses `CopilotKitProvider` and `CopilotChat` from `@copilotkit/react-core/v2`.
- Presents a CopilotKit Agent-style chat experience for parents and students, with local persistent sessions and no profile form/sidebar.
- Keeps DeepSeek through the OpenAI-compatible API.
- Uses `lookupAdmissionScores` for official-first score lookup, with optional `lifefloating/gaokao-vault` PostgreSQL lookup before search fallbacks.
- Uses `lookupRankByScore` through optional `gaokao-vault` score segments or `iefnaf/mcp-gaokao`; it supplements one-score-one-rank data and does not replace official admission score sources.
- Keeps `researchGaokaoData` as a Tavily fallback for schools or policies that do not yet have a structured official parser.
- Registers a controlled `scoreLineTrendChart` generative UI component for mobile-friendly admission score trend charts and professional-group comparison charts.
- Enables Open Generative UI for exploratory non-critical UI, while score-line curves stay on the controlled chart.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter gaokao-major-advisor example-dev -- -p 3020
```

Create `examples/v1/gaokao-major-advisor/.env.local`:

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
TAVILY_API_KEY=
MCP_GAOKAO_RANK_ENDPOINT=
GAOKAO_VAULT_DATABASE_URL=
```

`TAVILY_API_KEY` is optional. Jiangsu official parsing does not require it. `MCP_GAOKAO_RANK_ENDPOINT` is optional; when present it should expose the `mcp-gaokao` `get_rank` tool through a local adapter endpoint.

`GAOKAO_VAULT_DATABASE_URL` is optional and points to a PostgreSQL database created by [`lifefloating/gaokao-vault`](https://github.com/lifefloating/gaokao-vault), for example:

```bash
GAOKAO_VAULT_DATABASE_URL=postgresql://gaokao:gaokao@localhost:5432/gaokao_vault
```

When configured, the app tries `gaokao-vault` first for `major_admission_results` and `score_segments`. Results are labeled as a third-party structured data library, so official examination authority and university admission sites still remain the final source for filling decisions.

## Optional Quark Public Data Probe

The app includes a narrow read-only Quark public endpoint wrapper for basic college list metadata:

```text
GET /api/gaokao/quark-colleges?keyword=苏州大学&limit=10
GET /api/gaokao/quark-colleges?province=江苏&type=综合类&tag=211
```

This wrapper only calls a publicly reachable JSON endpoint and filters locally. It intentionally does not spoof Quark Browser, call signed recommendation APIs, or use Quark-only browser capabilities. Treat returned data as third-party reference data and confirm final score-line or volunteer-filling decisions against official admissions sources.

## Data Flow

For questions like “2025 苏州大学江苏物理类分数线是什么”:

1. The agent calls `lookupAdmissionScores` with `yearRange: [2025]` and `queryType: "groupComparison"`.
2. The server first checks `gaokao-vault` if `GAOKAO_VAULT_DATABASE_URL` is configured, then falls back to official parser/search logic.
3. The agent renders `scoreLineTrendChart` with professional-group points.
4. It gives a short, source-aware judgment. If ranks are not disclosed by the official source, it must pass `rank: -1` and say so.

For “苏州大学近三年江苏物理类趋势”, the same tool uses `[2023, 2024, 2025]` and `queryType: "overallTrend"`.

Future production integrations can replace Tavily with provincial one-score-one-rank tables, university admission score databases, official enrollment plans, and employment quality reports.

## Docker Deployment

From the repository root, build and run only this app:

```bash
cd examples/v1/gaokao-major-advisor
cp .env.production.example .env.production
# edit .env.production and fill DEEPSEEK_API_KEY
docker compose --env-file .env.production up -d --build
```

To connect a separately running `gaokao-vault` PostgreSQL database from Docker Desktop on macOS, set:

```bash
GAOKAO_VAULT_DATABASE_URL=postgresql://gaokao:gaokao@host.docker.internal:5432/gaokao_vault
```

The compose file binds the app to `127.0.0.1:3020` by default. Put Nginx or BaoTa in front of it and reverse proxy the public domain to:

```text
http://127.0.0.1:3020
```

For a different local port, set `HOST_PORT` in `.env.production`. Keep real keys in `.env.production`; it is ignored by git.
