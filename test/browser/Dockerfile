# Both browser and OS are fixed: screenshot baselines are generated in this exact Linux image.
FROM node:26.5.1-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
COPY --from=node /usr/local /usr/local
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --ignore-scripts
COPY . .
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
RUN npm run db:generate && npm run build
ENTRYPOINT ["bash", "test/browser/container.sh"]
