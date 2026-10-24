#!/bin/sh
# 开发期打包：root/ + htdocs/ 合成一份安装树（htdocs 映射到 /www，和 luci.mk 一致）
set -e
STAGE=../.workbuddy/tmp/stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r root/. "$STAGE"/
mkdir -p "$STAGE/www"
cp -r htdocs/. "$STAGE/www/"
tar czf ../.workbuddy/tmp/lanmap.tar.gz -C "$STAGE" .
echo "packed: $(find "$STAGE" -type f | wc -l) files, $(du -h ../.workbuddy/tmp/lanmap.tar.gz | cut -f1)"
