FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DATABASE_FILE=/data/app.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server.js"]
