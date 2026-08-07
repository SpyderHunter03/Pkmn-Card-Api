FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3400
CMD ["node", "server.js"]
