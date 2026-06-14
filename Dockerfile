# syntax=docker/dockerfile:1

FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS builder

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter gaokao-major-advisor example-build

FROM node:22-slim AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3020

WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /repo/examples/v1/gaokao-major-advisor/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/examples/v1/gaokao-major-advisor/.next/static ./examples/v1/gaokao-major-advisor/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/examples/v1/gaokao-major-advisor/public ./examples/v1/gaokao-major-advisor/public

USER nextjs

EXPOSE 3020

CMD ["node", "examples/v1/gaokao-major-advisor/server.js"]
