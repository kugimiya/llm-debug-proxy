FROM node:22-alpine

WORKDIR /app

COPY package.json index.js ./

RUN mkdir -p /app/logs && chown -R node:node /app

USER node

EXPOSE 1234

ENV LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=1234 \
    TARGET_HOST=host.docker.internal \
    TARGET_PORT=1235 \
    LOG_DIR=/app/logs

CMD ["node", "index.js"]