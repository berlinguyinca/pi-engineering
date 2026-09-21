# pi-engineering control API container.
# Builds the pi-engineering-runtime package and runs the control-plane server.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
# Run the control-plane server (see scripts/control-server.ts).
CMD ["node", "--experimental-strip-types", "scripts/control-server.ts"]
