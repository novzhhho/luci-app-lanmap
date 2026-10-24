# luci-app-lanmap

LuCI 的**局域网设备管理**插件：把局域网里所有设备列出来，认出它是什么（手机 / 电脑 / 电视 / NAS…），
点进去看它的实时和历史流量，顺手还能重命名、换图标、禁止上网。

不依赖 bandix，也不依赖任何外部服务 —— 自己用 nft 计数、自己落盘。

## 和"流量监控插件"的区别

设计重心是**设备**，不是流量：

| | 流量监控类插件 | 这个插件 |
|---|---|---|
| 首页 | 各设备流量排行榜 | 设备清单，按 在线 / 已禁用 / 离线 分组 |
| 设备识别 | 通常只有 MAC + IP | 类型 + 厂商 + 主机名，配对应图标 |
| 能做的管理动作 | 基本没有 | 重命名、换图标、禁止上网 |
| 流量 | 主角，占满整屏 | 每行右侧一列参考值，详情页里才展开曲线 |

## 数据从哪来

```
                    ┌─────────────────────────────────────────┐
  nft 计数器 ───────► lanmapd (ucode + uloop)                   │
  (br-lan 二层钩子)   │  每 5 秒读一次 → 算速率 → state.json    │
                    │  每 15 分钟把增量 append 到 hourly.tsv   │
                    │  每天把超 7 天的数据折叠进 daily.tsv      │
                    └─────────────────────────────────────────┘
                                     │
  ip neigh / dhcp.leases ──┐         │        ┌── /etc/lanmap/devices.json
  bridge fdb / iw ─────────┼────────►│◄───────┤   （别名/类型/禁网）
  luci-rpc getHostHints ───┘         │        └── oui.tsv（厂商表）
                                     ▼
                          rpcd: luci.lanmap (rpc.uc)
                          合并 / 识别 / 汇总 → JSON
                                     │
                                     ▼
                          LuCI 视图 overview.js
```

### 为什么计数挂在二层钩子而不是 forward

本机 WAN 是 PPPoE。下行包从 PPP 隧道进 `forward` 钩子时**没有以太网头**，
按 `ether daddr` 匹配恒为 0 —— 实测下载 157MB 只记到 2.5MB（TCP ACK）。

所以计数挂在 `br-lan` 的 netdev 钩子上：

```
chain lanin  { type filter hook ingress device "br-lan" }
    ether saddr <mac> counter name "ul_<mac>"
chain lanout { type filter hook egress device "br-lan" }
    ether daddr <mac> counter name "dl_<mac>"
```

实测下载 292MB → 下行 343MB、上行 1.8MB，方向和量级都对。

### 为什么每台设备一条规则

本机 nft 1.1.6 上这几种写法全是语法错误：`meter {...}`、`counter name @map`、
`update @set {...}`。唯一能用的是「命名 counter 对象 + 每设备一条匹配规则」。
设备数上限由 `option max_devices` 控制（默认 200）。

## 已知限制

- **flow offloading**：如果开启了软件/硬件分载，转发流量会走 fastpath 绕过钩子，
  统计值会偏低。插件检测到后会直接在详情页显示警告。
- **随机 MAC**：手机/平板默认用随机 MAC 连 Wi-Fi，这类地址的 OUI 查不到厂商，
  只能靠主机名推断类型。界面会给它们打「随机 MAC」标签，而不是瞎猜一个厂商。
- **无线信号强度**：需要 `iw` 和无线射频。本机（R66S）没有 Wi-Fi，所以全部按有线显示。
  有射频的设备上会自动从 `iw station dump` 判断接入方式。
- **历史数据**：小时级，保留 90 天（`option retention_days`）。秒级曲线只在内存里保留最近 5 分钟。
- **"今日/累计"的口径**是设备侧接口的总收发，包含它和路由器的往来（DNS、DHCP、管理页面），
  也包含局域网内互传。这更接近"这台设备用了多少流量"，而不是"它占了多少宽带"。

## 安装

```sh
# 从 Release 下载对应 apk
apk add --allow-untrusted --force-overwrite luci-app-lanmap-*.apk

# 装完确认服务在跑
/etc/init.d/lanmap enable
/etc/init.d/lanmap restart
```

依赖：`luci-base rpcd nftables ucode ucode-mod-fs ucode-mod-uloop ucode-mod-uci`

装完菜单在 **网络 → 设备管理**。

## 插件内更新

页面底部的版本条就是更新入口。它比对的是**本地烧进去的 commit 短 sha**
（`/usr/share/luci-app-lanmap/build`，CI 打包时写入）和 GitHub 最新 Release 的 tag。

```
luci-app-lanmap · e1fcfe7                    [检查更新]
发现新版本 a1b2c3d（当前 e1fcfe7）              [立即更新]
```

点「立即更新」后依次做：

1. 从 Release 下载 apk；
2. 同时下载 `SHA256SUMS.txt` 并 `sha256sum -c` 校验 —— **拿不到校验文件就不装**，
   截断或中间人改写都会被拦住；
3. `apk add --no-network --allow-untrusted --force-overwrite` 覆盖安装；
4. 刷新页面。

升级保留 `/etc/lanmap/devices.json`（别名、图标、禁网状态）和历史 TSV 数据。

> **实现上的一个坑**：`post-upgrade` 里**不能** `reload rpcd`。这次 `apk add` 是
> rpcd 调起的子进程，reload 会把 rpcd 一起重启，正在等回包的请求直接超时。
> apk 覆盖后下一次调用本来就用新脚本，不需要重启；只有全新安装才需要。

检查更新要能连 `api.github.com`。路由器上如果是纯 IPv6 或 DNS 有污染，
会直接报「连不上 GitHub API」，不影响插件其它功能。

## 校验包没被改动过

```sh
sha256sum -c SHA256SUMS.txt
```

卸载：

```sh
apk del luci-app-lanmap
```

运行期产生的历史数据不归 apk 管，想彻底清干净再删这几个：

```sh
rm -rf /usr/share/lanmap/data /etc/lanmap /var/run/lanmap
```

服务管理：

```sh
/etc/init.d/lanmap status
/etc/init.d/lanmap restart
nft list table netdev lanmap        # 看每台设备的计数器
cat /var/run/lanmap/state.json      # 当前速率
tail -f /var/log/lanmapd.log        # 采集服务日志
```

## 配置

`/etc/config/lanmap`：

```uci
config lanmap 'main'
	option enabled '1'
	option interface ''        # 留空则自动取 br-lan
	option interval '5'        # 采样周期（秒）
	option max_devices '200'   # 最多为多少台设备建计数规则
	option retention_days '90' # 小时级历史保留天数
```

用户数据（不在 config 里，升级不覆盖）：

- `/etc/lanmap/devices.json` —— 别名、类型、分组、禁网状态、首次发现时间
- `/usr/share/lanmap/data/hourly.tsv` —— 15 分钟粒度的历史，保留 7 天
- `/usr/share/lanmap/data/daily.tsv` —— 天粒度，保留 `retention_days`
- `/usr/share/lanmap/oui.tsv` —— MAC 前缀 → 厂商，4 万条

## 开发

```sh
# 更新厂商表（数据源是 Wireshark 维护的 IEEE manuf 表）
python3 tools/gen-oui.py

# 只检查现有表格式
python3 tools/gen-oui.py --check
```

目录：

```
root/usr/sbin/lanmapd                 采集服务（ucode + uloop，常驻）
root/usr/share/lanmap/rpc.uc          rpcd 的业务逻辑（数据合并、识别、汇总）
root/usr/libexec/rpcd/luci.lanmap     rpcd 协议壳（list / call 分发）+ 插件自更新
htdocs/.../view/lanmap/overview.js    界面
```

### 调试

```sh
# 直接跑一次接口，看原始 JSON
echo '{}' | ucode /usr/share/lanmap/rpc.uc devices
echo '{"mac":"aa:bb:cc:dd:ee:ff"}' | ucode /usr/share/lanmap/rpc.uc detail

# 改完界面文件后刷新浏览器缓存即可，不需要重启服务
```

### 几个容易踩的坑

- Argon 里有 `.danger` / `.success` / `.primary` 这类 Bootstrap 工具类且带 `!important`，
  插件里的修饰类必须加前缀（`lm-danger`），否则按钮会被染成红底红字。
- `.lm-svg` 这类图标容器如果只写 `height:auto`，SVG 会按 viewBox 等比缩成一条线，
  必须给固定高度 + `preserveAspectRatio="none"`。
- ucode 没有 `floor()`（`math` 模块只有 `abs/atan2/cos/exp/isnan/log/pow/rand/sin/sqrt/srand`），
  时间戳都是正数，直接用 `int()` 截断即可。
- ucode 的 `json()` 只解析不序列化，序列化用 `sprintf('%J', obj)`。
- ucode 的正则不支持 `(?!...)` 负向前瞻。
- 用数字当对象键之后再 `for (k, v in obj)` 取出来的 `k` 是**字符串**，要 `int()` 转回去。

## License

MIT
