FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY data/nz_police_stations.csv ./data/nz_police_stations.csv
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 7800
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:7800/health || exit 1
CMD ["node", "server.js"]
