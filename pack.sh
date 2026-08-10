#!/bin/sh
# Сборка MCPB-бандла для Smithery: они раздают stdio-серверы только так, ссылки на
# собственный хостинг у нас нет.
#
#   sh pack.sh                     # собрать бандл рядом со скриптом
#   npx -y @smithery/cli mcp publish ./sv-number-mcp.mcpb -n sv-number/mcp-server
#
# Раскладка внутри повторяет установленный npm-пакет: package.json лежит рядом с dist/,
# иначе сервер не найдёт свою версию по ../package.json и упадёт на старте.
set -e
PKG="$(cd "$(dirname "$0")" && pwd)"
STAGE="$PKG/mcpb_stage"
OUT="$PKG/sv-number-mcp.mcpb"

npx tsc                                     # бандл собирается из свежего dist, не из старого

rm -rf "$STAGE"
mkdir -p "$STAGE/server/dist"
cp "$PKG/manifest.json" "$STAGE/manifest.json"
cp "$PKG/README.md" "$STAGE/README.md"
cp "$PKG/LICENSE" "$STAGE/LICENSE"
cp "$PKG/dist/"*.js "$STAGE/server/dist/"
cp "$PKG/assets/logo-400.png" "$STAGE/icon.png"

# Своё package.json: без "type": "module" node прочитает index.js как CommonJS и
# упадёт на первом import, а без версии сервер представится клиентам чужим номером.
python - "$PKG/package.json" "$STAGE/server/package.json" <<'PY'
import json, sys
source = json.load(open(sys.argv[1], encoding="utf-8"))
json.dump({"name": source["name"], "version": source["version"], "type": "module",
           "dependencies": source["dependencies"]},
          open(sys.argv[2], "w", encoding="utf-8"), indent=2)
PY

(cd "$STAGE/server" && npm install --omit=dev --ignore-scripts --silent)
npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUT"
rm -rf "$STAGE"
