FROM node:18-alpine AS build
WORKDIR /app

COPY DayZWebService/package*.json DayZWebService/

WORKDIR /app/DayZWebService
RUN npm ci --production

COPY DayZWebService/ /app/DayZWebService/

FROM node:18-alpine
ENV NODE_ENV=production

ENV SAVEPATH=/data/
WORKDIR /app
COPY --from=build /app/DayZWebService /app

VOLUME ["/data"]

EXPOSE 80 443

CMD ["node", "app.js"]
