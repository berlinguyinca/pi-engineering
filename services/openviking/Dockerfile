# OpenViking service — tier-1 container (thin HTTP layer + Postgres backing store).
FROM node:22-alpine

WORKDIR /app

# Install production deps (pg). package-lock is committed alongside package.json.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV OPENVIKING_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.mjs"]
