#!/bin/sh
envsubst < /app/DayZWebService/sample-config.json > "$SAVEPATH/config.json"
exec node app.js