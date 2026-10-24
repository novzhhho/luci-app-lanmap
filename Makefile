#
# luci-app-lanmap —— 局域网设备管理（设备清单 / 流量统计 / 上网控制）
#
# This is free software, licensed under the MIT License.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI app for LAN device management
LUCI_DESCRIPTION:=List every device on the LAN, identify what it is, and show per-device traffic.
LUCI_DEPENDS:=+luci-base +rpcd +nftables +ucode +ucode-mod-fs +ucode-mod-uloop +ucode-mod-uci +ucode-mod-ubus
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=novzhhho
LUCI_URL:=https://github.com/novzhhho/luci-app-lanmap

# 版本由 CI 改写：PKG_RELEASE 取 commit 数，保证每次构建版本号递增，
# 这样路由器上 apk add 才会真正覆盖安装（详见 .github/workflows/apk.yml）
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
