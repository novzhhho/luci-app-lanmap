#!/bin/sh
# 开发期手工部署（正式安装走 apk）
set -e
R=/tmp/lanmap-stage
rm -rf $R
mkdir -p $R
tar -xzf /tmp/lanmap.tar.gz -C $R

mkdir -p /usr/sbin /usr/libexec/rpcd /usr/share/lanmap/data /usr/share/luci/menu.d /usr/share/rpcd/acl.d /etc/lanmap
cp -f $R/usr/sbin/lanmapd                  /usr/sbin/lanmapd
cp -f $R/usr/libexec/rpcd/luci.lanmap      /usr/libexec/rpcd/luci.lanmap
cp -f $R/usr/share/lanmap/rpc.uc           /usr/share/lanmap/rpc.uc
cp -f $R/usr/share/lanmap/oui.tsv          /usr/share/lanmap/oui.tsv
cp -f $R/usr/share/luci/menu.d/*.json      /usr/share/luci/menu.d/
cp -f $R/usr/share/rpcd/acl.d/*.json       /usr/share/rpcd/acl.d/
cp -f $R/etc/init.d/lanmap                 /etc/init.d/lanmap
mkdir -p /www/luci-static/resources/view/lanmap
[ -d $R/www ] && cp -f $R/www/luci-static/resources/view/lanmap/*.js /www/luci-static/resources/view/lanmap/
[ -f /etc/config/lanmap ] || cp -f $R/etc/config/lanmap /etc/config/lanmap

chmod 755 /usr/sbin/lanmapd /usr/libexec/rpcd/luci.lanmap /etc/init.d/lanmap

rm -rf $R
/etc/init.d/rpcd reload >/dev/null 2>&1
sleep 1
echo "--- 部署完成 ---"
ls -l /usr/sbin/lanmapd /usr/share/lanmap/oui.tsv
