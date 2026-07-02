FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.js portscan.js ./
USER node
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:7700/health || exit 1
CMD ["node", "server.js"]
