FROM node:20-alpine AS build
WORKDIR /app

COPY DayZWebService/package*.json DayZWebService/

WORKDIR /app/DayZWebService
RUN npm install --omit=dev

COPY DayZWebService/ /app/DayZWebService/

FROM node:20-alpine
ENV NODE_ENV=production \
    SAVEPATH=/data
WORKDIR /app
COPY --from=build /app/DayZWebService /app

VOLUME ["/data"]

EXPOSE 80 443

CMD ["node", "app.js"]
