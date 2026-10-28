FROM node:24-alpine

# tzdata: rotation times (e.g. "täglich 04:00") follow the TZ variable
RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
