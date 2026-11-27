# Frontend: built from its own repo so one service serves the app and the API
# from the same origin (the session cookie needs that without a custom domain).
FROM node:22-alpine AS web
WORKDIR /web
# ADD of a URL is re-downloaded on every build and its layer is reused only
# while the archive is unchanged, so a new frontend commit rebuilds from here.
ARG FRONTEND_ARCHIVE=https://github.com/cebanoleksandr/jarvis-fe/archive/refs/heads/main.tar.gz
ADD ${FRONTEND_ARCHIVE} /tmp/web.tar.gz
RUN tar -xzf /tmp/web.tar.gz --strip-components=1 && rm /tmp/web.tar.gz
RUN npm install -g npm@12.2.0 && npm ci
# Same origin: the API lives under /api. Operator details for the privacy
# policy come from the service's environment (Render passes it as build args).
ARG VITE_OPERATOR_NAME
ARG VITE_PRIVACY_EMAIL
ENV VITE_API_URL=/api \
    VITE_OPERATOR_NAME=${VITE_OPERATOR_NAME} \
    VITE_PRIVACY_EMAIL=${VITE_PRIVACY_EMAIL}
RUN npm run build

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install -g npm@12.2.0 && npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    WEB_DIST=/app/web
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
