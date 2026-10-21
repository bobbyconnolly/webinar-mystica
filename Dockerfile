# Mystica server image. Built with the repo root as context (az acr build or docker build .).
# Node 24: the store uses the built-in node:sqlite, no native modules to compile.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/*.js ./server/
COPY prototype ./prototype
# The live database is on local disk; a consistent copy is mirrored to the mounted share (/data) after
# every flush and restored from there on start. SQLite cannot lock files on a network share directly.
ENV DB_FILE=/tmp/mystica/world-7.sqlite
ENV MIRROR_DIR=/data
ENV PORT=8080
EXPOSE 8080
# Runs as root on purpose: the Azure Files mount is owned by root and the node user could not write it.
WORKDIR /app/server
CMD ["node", "server.js"]
