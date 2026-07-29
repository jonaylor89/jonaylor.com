#!/usr/bin/env bash

set -x
set -eo pipefail

CONTAINER_NAME="hub-redis"

# Reuse existing container if it's running
RUNNING=$(docker ps --filter "name=^${CONTAINER_NAME}$" --format "{{.ID}}")
if [[ -n $RUNNING ]]; then
    echo >&2 "Redis container '${CONTAINER_NAME}' is already running"
    exit 0
fi

# Restart stopped container if it exists
STOPPED=$(docker ps -a --filter "name=^${CONTAINER_NAME}$" --format "{{.ID}}")
if [[ -n $STOPPED ]]; then
    docker start "${CONTAINER_NAME}"
    echo >&2 "Restarted existing Redis container"
    exit 0
fi

# Create a new container
docker run \
    -p "6379:6379" \
    -d \
    --name "${CONTAINER_NAME}" \
    redis:7-alpine

>&2 echo "Redis is ready to go"
