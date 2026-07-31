#!/bin/sh
# Resolve the Postgres host once at startup and pin it into /etc/hosts.
#
# Why: on Fly, asyncpg resolves the DB hostname through the internal resolver
# (fdaa::3), which INTERMITTENTLY fails to resolve Render's IPv4-only external
# DB hostname (dpg-…-a.oregon-postgres.render.com — no AAAA record). The miss
# surfaces as socket.gaierror -> OSError -> HTTP 502 on every DB-touching
# endpoint (/analyze, /recommendations), while /health (no DB) stays 200.
#
# Pinning the A record into /etc/hosts makes glibc serve it from `files`
# (consulted before `dns` per nsswitch.conf), so request-time lookups never
# touch the flaky resolver. The hostname is unchanged, so asyncpg still sends
# it as the TLS SNI to Render — connecting by raw IP would break SNI routing.
#
# Best effort: if resolution fails for the whole retry window we start anyway
# (no worse than today's runtime DNS). Set DB_HOST_FALLBACK_IP to pin a known
# IP as a safety net for a fully-bad startup window.
set -e

HOST=$(python3 - <<'PY'
import os, urllib.parse as u

url = os.environ.get("DATABASE_URL", "")
try:
    # Strip the +asyncpg driver suffix so urlsplit sees a clean scheme.
    scheme = url.split("://", 1)[0]
    if "+" in scheme:
        url = scheme.split("+", 1)[0] + "://" + url.split("://", 1)[1]
    print(u.urlsplit(url).hostname or "")
except Exception:
    print("")
PY
)

if [ -n "$HOST" ] && ! grep -q "$HOST" /etc/hosts 2>/dev/null; then
    IP=""
    i=0
    while [ "$i" -lt 30 ]; do
        IP=$(python3 - "$HOST" <<'PY'
import socket, sys

try:
    print(socket.gethostbyname(sys.argv[1]))  # IPv4 (A) — Render is v4-only
except Exception:
    print("")
PY
)
        [ -n "$IP" ] && break
        i=$((i + 1))
        sleep 1
    done

    if [ -z "$IP" ] && [ -n "$DB_HOST_FALLBACK_IP" ]; then
        IP="$DB_HOST_FALLBACK_IP"
        echo "entrypoint: DNS failed after retries; using DB_HOST_FALLBACK_IP=$IP" >&2
    fi

    if [ -n "$IP" ]; then
        echo "$IP $HOST" >> /etc/hosts
        echo "entrypoint: pinned $HOST -> $IP in /etc/hosts" >&2
    else
        echo "entrypoint: WARNING could not resolve $HOST; starting with runtime DNS" >&2
    fi
fi

exec "$@"
