#!/usr/bin/ucode
'use strict';

/*
 * luci-app-lanmap —— 设备数据聚合
 *
 * 输入：/usr/libexec/rpcd/luci.lanmap 把方法名作为 argv[1]、参数 JSON 放在 stdin。
 * 输出：stdout 一个 JSON 对象。
 *
 * 数据来自五处，优先级从高到低：
 *   1. /etc/lanmap/devices.json   用户设置（别名/类型/分组/禁网）—— 最高优先
 *   2. /var/run/lanmap/state.json lanmapd 的实时速率与最后一次活跃时间
 *   3. ip neigh / bridge fdb      当前 IP 与在线状态
 *   4. /tmp/dhcp.leases           主机名、租约、静态分配
 *   5. OUI 表                     MAC 前缀 -> 厂商
 *
 * 流量的「今日/累计」来自 lanmapd 落盘的 hourly.tsv + daily.tsv。
 */

let fs = require('fs');

let RUNDIR = '/var/run/lanmap';
let STATEF = RUNDIR + '/state.json';
let DATADIR = '/usr/share/lanmap/data';
let HOURLY = DATADIR + '/hourly.tsv';
let DAILY = DATADIR + '/daily.tsv';
let METAF = '/etc/lanmap/devices.json';
let OUIF = '/usr/share/lanmap/oui.tsv';
let BLOCKTABLE = 'lanmap_block';

/* ================= 通用工具 ================= */

function readfile(p) {
	try {
		let v = fs.readfile(p);
		return v ? v : '';
	} catch (e) {
		return '';
	}
}

function writefile_atomic(p, data) {
	try {
		let tmp = p + '.tmp';
		let f = fs.open(tmp, 'w');
		if (!f) return false;
		f.write(data);
		f.close();
		fs.rename(tmp, p);
		return true;
	} catch (e) {
		return false;
	}
}

function run(cmd) {
	let out = '';
	try {
		let p = fs.popen(cmd);
		if (!p) return '';
		out = p.read('all');
		p.close();
	} catch (e) {
		return '';
	}
	return out ? out : '';
}

function strip(t) {
	let m = trim(t);
	return (m && m != '-') ? m : '';
}

function now() {
	return time();
}

/* 本地时区偏移（秒）。/etc/TZ 是 POSIX 格式，CST-8 表示 UTC+8，符号是反的。 */
let _tzc = null;
function tz_offset() {
	if (_tzc != null) return _tzc;
	let tz = trim(readfile('/etc/TZ'));
	let m = match(tz, /([+-])(\d+)/);
	if (!m) { _tzc = 0; return 0; }
	let v = int(m[2]) * 3600;
	_tzc = (m[1] == '-') ? v : -v;
	return _tzc;
}

/* 本地日/小时对齐的 epoch */
function day_start(t) {
	let off = tz_offset();
	return int((t + off) / 86400) * 86400 - off;
}

function cfg_get(opt, dflt) {
	let v = run(sprintf("uci -q get lanmap.main.%s 2>/dev/null", opt));
	v = trim(v);
	return v ? v : dflt;
}

function lan_iface() {
	let v = cfg_get('interface', '');
	if (v) return v;

	let out = run('ubus call network.interface.lan status 2>/dev/null');
	if (out) {
		let d = null;
		try { d = json(out); } catch (e) { }
		if (type(d) == 'object') {
			if (type(d.l3_device) == 'string' && d.l3_device) return d.l3_device;
			if (type(d.device) == 'string' && d.device) return d.device;
		}
	}
	return 'br-lan';
}

function lan_cidr(iface) {
	let out = run(sprintf("ip -4 route show dev %s proto kernel scope link 2>/dev/null", iface));
	let m = match(out, /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+)/);
	return m ? m[1] : '192.168.0.0/16';
}

/* ================= 数据源 ================= */

function load_state() {
	let raw = readfile(STATEF);
	if (!raw) return { ts: 0, iface: '', devs: {} };
	let d = null;
	try { d = json(raw); } catch (e) { return { ts: 0, iface: '', devs: {} }; }
	if (type(d) != 'object' || type(d.devs) != 'object') return { ts: 0, iface: '', devs: {} };
	return d;
}

function load_neigh(iface) {
	let map = {};
	let out = run(sprintf('ip neigh show dev %s 2>/dev/null', iface));
	let line, m;
	for (line in split(out, '\n')) {
		m = match(line, /^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+).*lladdr\s+([0-9a-fA-F:]{17})\s+(\w+)/);
		if (!m) continue;
		map[lc(m[2])] = { ip: m[1], state: m[3] };
	}
	return map;
}

function load_fdb(iface) {
	let map = {};
	let out = run('bridge fdb show 2>/dev/null');
	let line, m;
	for (line in split(out, '\n')) {
		m = match(line, /^([0-9a-fA-F:]{17})\s+dev\s+(\S+)(.*)$/);
		if (!m) continue;
		let rest = m[3];
		if (index(rest, 'permanent') >= 0) continue;
		if (match(rest, /\bself\b/)) continue;
		let dev = m[2];
		/* 只看挂在 LAN 桥端口上的条目 */
		if (index(rest, 'master ' + iface) < 0 && dev != iface) continue;
		map[lc(m[1])] = true;
	}
	return map;
}

/* 关联到无线接口的 MAC。没有无线射频时返回空，全部按有线处理。 */
function load_wifi() {
	let set = {};
	let ifs = trim(run("iw dev 2>/dev/null | awk '/Interface/{print $2}'"));
	if (!ifs) return set;

	for (let i in split(ifs, '\n')) {
		i = trim(i);
		if (!i) continue;
		let out = run(sprintf('iw dev %s station dump 2>/dev/null', i));
		for (let line in split(out, '\n')) {
			let m = match(line, /^Station\s+([0-9a-fA-F:]{17})/);
			if (m) set[lc(m[1])] = true;
		}
	}
	return set;
}

function load_leases() {
	let map = {};
	let out = readfile('/tmp/dhcp.leases');
	let line, f;
	for (line in split(out, '\n')) {
		line = trim(line);
		if (!line) continue;
		f = split(line, ' ');
		if (length(f) < 4) continue;
		let mac = lc(f[1]);
		if (!match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)) continue;
		map[mac] = {
			expire: int(f[0]),
			ip: f[2],
			host: (f[3] == '*') ? '' : f[3]
		};
	}
	return map;
}

/* luci-rpc 的 getHostHints 是 LuCI 官方的设备信息聚合，失败也不影响主流程 */
function load_hints() {
	let map = {};
	let out = run("ubus call luci-rpc getHostHints 2>/dev/null");
	if (!out) return map;
	let d = null;
	try { d = json(out); } catch (e) { return map; }
	if (type(d) != 'object') return map;

	for (let mac, v in d) {
		if (type(v) != 'object') continue;
		let e = { ip: '', ip6: [], name: '' };
		if (type(v.ipaddrs) == 'array' && length(v.ipaddrs)) e.ip = v.ipaddrs[0];
		if (type(v.ip6addrs) == 'array') e.ip6 = v.ip6addrs;
		if (type(v.name) == 'string') e.name = v.name;
		map[lc(mac)] = e;
	}
	return map;
}

/* 静态租约：配置里写死的 IP，比 DHCP 租约更权威 */
function load_static() {
	let map = {};
	let out = run("uci -q show dhcp 2>/dev/null");
	let curmac = null;
	for (let line in split(out, '\n')) {
		let m = match(line, /^dhcp\.(@host\[[0-9]+\]|[^.]+)\.mac='?([0-9a-fA-F:]{17})'?/);
		if (m) { curmac = lc(m[2]); map[curmac] = { ip: '' }; continue; }
		m = match(line, /^dhcp\.(@host\[[0-9]+\]|[^.]+)\.ip='?([0-9.]+)'?/);
		if (m && curmac && map[curmac]) map[curmac].ip = m[2];
	}
	return map;
}

/*
 * OUI 表有 4 万条、767KB。每次请求都把它解析成对象太慢，
 * 所以按当前这批 MAC 的前缀拼一条正则，让 grep 一次捞回来。
 * 实测 18 台设备约 8ms。
 */
function oui_map(macs) {
	let pat = '';
	for (let mac in macs) {
		let h = replace(lc(mac), /:/g, '');
		if (length(h) < 6) continue;
		pat += (pat ? '|' : '') + '^' + substr(h, 0, 6);
	}
	if (!pat) return {};

	let out = run(sprintf("grep -E '%s' %s 2>/dev/null", pat, OUIF));
	let map = {};
	let line, f;
	for (line in split(out, '\n')) {
		line = trim(line);
		if (!line) continue;
		f = split(line, '\t');
		if (length(f) < 2) continue;
		map[lc(f[0])] = f[1];
	}
	return map;
}

/* 第一个字节的 bit1 置位 = 本地管理地址（手机/平板的随机 MAC），OUI 必然查不到 */
function is_random_mac(mac) {
	let h = replace(lc(mac), /:/g, '');
	if (length(h) < 2) return false;
	let v = index('0123456789abcdef', substr(h, 1, 1));
	if (v < 0) return false;
	return (v % 4) >= 2;
}

/* ================= 元数据（用户设置） ================= */

function load_meta() {
	let raw = readfile(METAF);
	if (!raw) return {};
	let d = null;
	try { d = json(raw); } catch (e) { return {}; }
	if (type(d) != 'object') return {};
	return d;
}

function save_meta(db) {
	try { fs.mkdir('/etc/lanmap', 0o755); } catch (e) { }
	return writefile_atomic(METAF, sprintf('%J', db));
}

/* ================= 流量汇总 ================= */

function read_tsv(p) {
	let rows = [];
	let out = readfile(p);
	let line, f;
	for (line in split(out, '\n')) {
		line = trim(line);
		if (!line) continue;
		f = split(line, '\t');
		if (length(f) < 4) continue;
		push(rows, { ts: int(f[0]), mac: lc(f[1]), u: int(f[2]), d: int(f[3]) });
	}
	return rows;
}

/*
 * 一次读全，算出每个设备的
 *   today 今天 00:00 起
 *   week  最近 7 天
 *   month 最近 30 天
 *   total 全部（已裁剪进 daily 的历史 + 最近 7 天 hourly）
 */
function usage_all() {
	let t = now();
	let d0 = day_start(t);
	let w0 = d0 - 6 * 86400;
	let m0 = d0 - 29 * 86400;

	let res = {};

	function add(mac, u, d, bucket) {
		let e = res[mac];
		if (!e) { e = { tu: 0, td: 0, wu: 0, wd: 0, mu: 0, md: 0, au: 0, ad: 0 }; res[mac] = e; }
		e.au += u; e.ad += d;
		if (bucket) {
			if (bucket.ts >= m0) { e.mu += u; e.md += d; }
			if (bucket.ts >= w0) { e.wu += u; e.wd += d; }
			if (bucket.ts >= d0) { e.tu += u; e.td += d; }
		}
	}

	let r;
	for (r in read_tsv(DAILY))
		add(r.mac, r.u, r.d, r);
	for (r in read_tsv(HOURLY))
		add(r.mac, r.u, r.d, r);

	/* 补上 lanmapd 内存里还没落盘的最近一段 */
	let st = load_state();
	if (type(st.acc) == 'object') {
		for (let mac, a in st.acc) {
			let e = res[mac];
			if (!e) { e = { tu: 0, td: 0, wu: 0, wd: 0, mu: 0, md: 0, au: 0, ad: 0 }; res[mac] = e; }
			e.tu += a.u; e.td += a.d;
			e.wu += a.u; e.wd += a.d;
			e.mu += a.u; e.md += a.d;
			e.au += a.u; e.ad += a.d;
		}
	}

	return res;
}

/* 单设备的时间序列：按小时聚合，供详情页画柱状图 */
function series(mac, hours) {
	let t = now();
	let d0 = day_start(t);
	let from = d0 - (hours - 24) * 3600;
	let buckets = {};
	let r, k;

	for (r in read_tsv(HOURLY)) {
		if (r.mac != mac) continue;
		let hb = int((r.ts + tz_offset()) / 3600) * 3600 - tz_offset();
		if (hb < from) continue;
		k = buckets[hb];
		if (!k) { k = { u: 0, d: 0 }; buckets[hb] = k; }
		k.u += r.u;
		k.d += r.d;
	}

	let out = [];
	for (let hb, v in buckets)
		push(out, { t: int(hb), u: v.u, d: v.d });
	sort(out, function (a, b) { return a.t - b.t; });

	return out;
}

/* ================= 类型推断 ================= */

/*
 * 顺序敏感：越具体的越靠前。
 * 主机名是唯一可靠的信号 —— 随机 MAC 的设备查不到厂商，
 * 只能靠设备自己广播的名字（Xiaomi-15-Ultra / DESKTOP-XXXX / MiTV-...）。
 */
let TYPE_RULES = [
	['camera',   /(camera|ipcam|ipc-|ezviz|dahua|hikvision|tapo|reolink|arlo|nvr|dvr|webcam|nest-?cam)/],
	['printer',  /(printer|epson|canon|brother|laserjet|deskjet|officejet|hp-?print)/],
	['nas',      /(synology|diskstation|qnap|freenas|truenas|unraid|openmediavault|nas-|omv)/],
	['router',   /(router|openwrt|immortalwrt|lede|repeater|extender|mesh|access-?point|tplink-?(ap|re)|mi-?router)/],
	['game',     /(playstation|ps[45]|xbox|nintendo|switch-|steamdeck)/],
	['speaker',  /(homepod|speaker|sonos|soundbar|echo-|alexa|audio|sound-?core|soundbox|mi-?ai|xiaodu|tmall-?genie|dingdong)/],
	['tv',       /(tv-|mi-?tv|appletv|apple-?tv|chromecast|bravia|skyworth|hisense|coocaa|changhong|projector|tvbox|mibox|fire-?tv|roku)/],
	['tablet',   /(ipad|tablet|tab-?[as]|matepad|galaxy-?tab|-pad|pad-|pad-?air)/],
	['phone',    /(iphone|android|redmi|poco|xiaomi|huawei|honor|oppo|vivo|oneplus|realme|meizu|pixel|sm-?[agsgn]|galaxy-?[sna]|moto|nokia|nothing-?phone)/],
	['computer', /(desktop|laptop|notebook|thinkpad|ideapad|legion|macbook|imac|mac-?mini|mac-?studio|surface|windows|win-?[0-9a-z]|linux|pc-|workstation)/],
	['iot',      /(esp[0-9]|esp32|esp8266|sonoff|tasmota|tuya|aqara|yeelight|switchbot|shelly|smart-?plug|bulb|sensor|thermostat|vacuum|roborock|mi-?robot)/]
];

/* 厂商名也能补出类型，但只在前面的规则都没命中时才用 */
let VENDOR_TYPES = [
	[/^(apple)/i,                    'computer'],
	[/xiaomi|huawei|oppo|vivo|oneplus|realme|honor|meizu|samsung/i, 'phone'],
	[/hikvision|dahua|ezviz|axis|reolink/i, 'camera'],
	[/hewlett|epson|canon|brother|seiko/i, 'printer'],
	[/synology|qnap|western digital|seagate/i, 'nas'],
	[/tp-?link|d-?link|netgear|ubiquiti|ruckus|aruba|meraki/i, 'router'],
	[/sony|philips|hisense|tcl|skyworth|sharp|lg electronics|panasonic/i, 'tv'],
	[/espressif|tuya|broadlink|smart-?home|itead/i, 'iot']
];

function guess_type(host, vendor) {
	let h = lc(host ? host : '');
	if (h) {
		for (let r in TYPE_RULES) {
			if (match(h, r[1])) return r[0];
		}
	}
	if (vendor) {
		for (let r in VENDOR_TYPES) {
			if (match(vendor, r[0])) return r[1];
		}
	}
	return 'unknown';
}

let TYPE_NAMES = {
	phone: '手机', tablet: '平板', computer: '电脑', tv: '电视',
	speaker: '音箱', camera: '摄像头', printer: '打印机', nas: 'NAS',
	router: '路由器', game: '游戏机', iot: '智能家居', unknown: '未知设备'
};

/* ================= 设备合并 ================= */

/* ================= 方法实现 ================= */

function method_devices() {
	let iface = lan_iface();
	let st = load_state();
	let neigh = load_neigh(iface);
	let fdb = load_fdb(iface);
	let leases = load_leases();
	let hints = load_hints();
	let statics = load_static();
	let meta = load_meta();
	let usage = usage_all();
	let wifi = load_wifi();
	let t = now();

	let seen = {};
	for (let mac in st.devs) seen[mac] = true;
	for (let mac in neigh) seen[mac] = true;
	for (let mac, v in fdb) seen[mac] = true;
	for (let mac in leases) seen[mac] = true;
	for (let mac in hints) seen[mac] = true;
	for (let mac in meta) seen[mac] = true;

	let list = [];
	let fresh = {};
	let cnt = { total: 0, online: 0, offline: 0, blocked: 0 };
	let omap = oui_map(seen);

	for (let mac in seen) {
		let m = meta[mac] ? meta[mac] : {};
		let n = neigh[mac] ? neigh[mac] : {};
		let l = leases[mac] ? leases[mac] : {};
		let h = hints[mac] ? hints[mac] : {};
		let s = statics[mac] ? statics[mac] : {};
		let sd = st.devs[mac] ? st.devs[mac] : {};

		let ip = n.ip ? n.ip : (s.ip ? s.ip : (l.ip ? l.ip : (h.ip ? h.ip : '')));
		let host = l.host ? l.host : (h.name ? h.name : '');
		let oui = omap[substr(replace(mac, /:/g, ''), 0, 6)];
		let vendor = oui ? oui : '';
		let rnd = is_random_mac(mac);

		let online = false;
		if (n.ip && (n.state == 'REACHABLE' || n.state == 'DELAY' || n.state == 'PROBE')) online = true;
		if (fdb[mac]) online = true;
		if (sd.last && (t - sd.last) < 300) online = true;

		let type = m.type ? m.type : guess_type(host, vendor);
		if (!m.first) fresh[mac] = true;

		/* 名称优先级：用户别名 > 主机名 > 厂商+IP > MAC */
		/* 名称回退顺序：别名 > 主机名 > IP。
		 * 不能回退到厂商名 —— 同一个牌子有两台设备时会出现两行都叫
		 * "Xiaomi Mobile Software"，用户完全分不清是哪一台。 */
		let name = m.name ? m.name : '';
		if (!name) name = host;
		if (!name) name = ip ? ip : mac;

		let u = usage[mac] ? usage[mac] : { tu: 0, td: 0, wu: 0, wd: 0, mu: 0, md: 0, au: 0, ad: 0 };

		cnt.total++;
		if (online) cnt.online++;
		if (!online) cnt.offline++;
		if (m.blocked) cnt.blocked++;

		let ip6 = '';
		if (h.ip6 && length(h.ip6)) {
			for (let a in h.ip6) {
				if (!match(lc(a), /^fe80/)) { ip6 = a; break; }
			}
			if (!ip6) ip6 = h.ip6[0];
		}

		push(list, {
			mac: mac,
			ip: ip,
			ip6: ip6,
			host: host,
			name: name,
			alias: m.name ? m.name : '',
			vendor: vendor,
			random_mac: rnd,
			type: type,
			type_name: TYPE_NAMES[type] ? TYPE_NAMES[type] : TYPE_NAMES.unknown,
			group: m.group ? m.group : '',
			custom_type: m.type ? m.type : '',
			conn: wifi[mac] ? 'wifi' : 'wire',
			blocked: m.blocked ? true : false,
			online: online,
			first: m.first ? m.first : 0,
			last: sd.last ? sd.last : (l.expire ? (l.expire - 43200) : 0),
			ru: sd.ru ? sd.ru : 0,
			rd: sd.rd ? sd.rd : 0,
			tu: u.tu, td: u.td,
			au: u.au, ad: u.ad
		});
	}

	/* 第一次见到的设备记下时间，之后不再改 —— 这是「首次发现」的唯一来源 */
	if (length(keys(fresh))) {
		for (let mac in fresh) {
			if (!meta[mac]) meta[mac] = {};
			if (!meta[mac].first) meta[mac].first = t;
		}
		save_meta(meta);
	}

	/* 在线优先，在线内按实时速率降序，其余按名称 */
	sort(list, function (a, b) {
		if (a.blocked != b.blocked) return a.blocked ? 1 : -1;
		if (a.online != b.online) return a.online ? -1 : 1;
		if (a.online && b.online) {
			let x = (b.ru + b.rd) - (a.ru + a.rd);
			if (x != 0) return x;
		}
		return lc(a.name) < lc(b.name) ? -1 : (lc(a.name) > lc(b.name) ? 1 : 0);
	});

	return { ok: true, ts: t, iface: iface, count: cnt, devices: list };
}

function method_detail(args) {
	let mac = lc(args.mac ? args.mac : '');
	if (!match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/))
		return { ok: false, error: 'MAC 地址不合法' };

	let all = method_devices();
	let dev = null;
	for (let d in all.devices) {
		if (d.mac == mac) { dev = d; break; }
	}
	if (!dev) return { ok: false, error: '设备不存在' };

	let usage = usage_all();
	let u = usage[mac] ? usage[mac] : { tu: 0, td: 0, wu: 0, wd: 0, mu: 0, md: 0, au: 0, ad: 0 };

	let leases = load_leases();
	let l = leases[mac] ? leases[mac] : {};

	let iface = all.iface;
	let sd = load_state().devs[mac];

	dev.today = { u: u.tu, d: u.td };
	dev.week = { u: u.wu, d: u.wd };
	dev.month = { u: u.mu, d: u.md };
	dev.total = { u: u.au, d: u.ad };
	dev.series = series(mac, 24);
	dev.live = (sd && type(sd.h) == 'array') ? sd.h : [];
	dev.lease = {
		expire: l.expire ? l.expire : 0,
		remain: l.expire ? (l.expire - now()) : 0
	};
	dev.uptime_bytes = sd ? { u: sd.u, d: sd.d } : { u: 0, d: 0 };
	dev.iface = iface;

	return { ok: true, device: dev };
}

function method_summary() {
	let iface = lan_iface();
	let st = load_state();
	let usage = usage_all();

	let up = 0, down = 0, tu = 0, td = 0;
	for (let mac, v in st.devs) {
		up += v.ru ? v.ru : 0;
		down += v.rd ? v.rd : 0;
	}
	for (let mac, v in usage) {
		tu += v.tu;
		td += v.td;
	}

	return {
		ok: true,
		iface: iface,
		rate: { up: up, down: down },
		today: { up: tu, down: td },
		ts: st.ts ? st.ts : 0
	};
}

/* 禁网：独立建一张 forward 表，不碰 fw4 的规则。
 * 下行用 ip daddr 匹配而不是 ether daddr —— fw4 的 forward 钩子上
 * WAN 侧来的包是 PPP 隧道解出来的，没有以太网头。 */
function rebuild_block() {
	let meta = load_meta();
	let iface = lan_iface();
	let cidr = lan_cidr(iface);
	let neigh = load_neigh(iface);

	run('nft delete table inet ' + BLOCKTABLE + ' 2>/dev/null');

	let body = '';
	let n = 0;
	for (let mac, e in meta) {
		if (!e.blocked) continue;
		n++;
		body += sprintf('\t\tether saddr %s ip daddr != %s drop\n', mac, cidr);
		let ip = (e.ip ? e.ip : (neigh[mac] ? neigh[mac].ip : ''));
		if (ip) body += sprintf('\t\tip daddr %s ip saddr != %s drop\n', ip, cidr);
	}

	if (!n) return 0;

	let s = sprintf("table inet %s {\n\tchain fwd {\n\t\ttype filter hook forward priority -140; policy accept;\n%s\t}\n}\n",
		BLOCKTABLE, body);

	writefile_atomic('/tmp/.lanmap-block.nft', s);
	let err = run('nft -f /tmp/.lanmap-block.nft 2>&1');
	fs.unlink('/tmp/.lanmap-block.nft');

	if (err && index(err, 'Error') >= 0) return -1;
	return n;
}

function method_setmeta(args) {
	let mac = lc(args.mac ? args.mac : '');
	if (!match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/))
		return { ok: false, error: 'MAC 地址不合法' };

	let db = load_meta();
	let e = db[mac];
	if (!e) { e = { first: now() }; db[mac] = e; }
	if (!e.first) e.first = now();

	if (args.name != null) {
		let v = trim(args.name);
		if (v) e.name = v; else delete e.name;
	}
	if (args.type != null) {
		let v = trim(args.type);
		if (v && v != 'auto') e.type = v; else delete e.type;
	}
	if (args.group != null) {
		let v = trim(args.group);
		if (v) e.group = v; else delete e.group;
	}
	if (args.blocked != null) {
		e.blocked = truthy(args.blocked);
		if (e.blocked) {
			let neigh = load_neigh(lan_iface());
			if (neigh[mac] && neigh[mac].ip) e.ip = neigh[mac].ip;
		}
	}

	if (!save_meta(db)) return { ok: false, error: '写入 /etc/lanmap/devices.json 失败' };

	let applied = 0;
	if (args.blocked != null) {
		applied = rebuild_block();
		if (applied < 0) return { ok: false, error: '禁网规则下发失败，请检查 nft' };
	}

	return { ok: true, blocked: e.blocked ? true : false, rules: applied };
}

function truthy(v) {
	if (v == true || v == 1) return true;
	if (type(v) == 'string') {
		let s = lc(trim(v));
		if (s == '1' || s == 'true' || s == 'yes' || s == 'on') return true;
	}
	return false;
}

function method_scan() {
	let iface = lan_iface();
	let cidr = lan_cidr(iface);
	let m = match(cidr, /^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)\/(\d+)$/);
	if (!m) return { ok: false, error: '无法获取 LAN 网段' };

	let prefix = m[1];
	let bits = int(m[3]);
	if (bits < 24) return { ok: false, error: '网段过大（/' + bits + '），请手动指定接口' };

	/* 64 个一批并发，避免一次 fork 出 254 个 ping */
	let sh = sprintf(
		'i=1; while [ $i -le 254 ]; do ping -c 1 -W 1 %s.$i >/dev/null 2>&1 & i=$((i+1)); ' +
		'[ $((i %% 64)) -eq 0 ] && wait; done; wait; echo done', prefix);

	run(sh);
	run('sleep 1');

	let neigh = load_neigh(iface);
	return { ok: true, found: length(keys(neigh)), cidr: cidr };
}

function method_status() {
	let procs = trim(run('pgrep -f /usr/sbin/lanmapd 2>/dev/null'));
	let nfttab = run('nft list table netdev lanmap 2>/dev/null | head -1');
	let st = load_state();
	let offload = trim(run("uci -q get firewall.@defaults[0].flow_offloading 2>/dev/null"));
	let offload_hw = trim(run("uci -q get firewall.@defaults[0].flow_offloading_hw 2>/dev/null"));

	return {
		ok: true,
		running: procs != '' && nfttab != '',
		iface: st.iface ? st.iface : lan_iface(),
		devices: st.devs ? length(keys(st.devs)) : 0,
		ts: st.ts ? st.ts : 0,
		offload: (offload == '1' || offload_hw == '1'),
		interval: int(cfg_get('interval', '5')),
		version: trim(readfile('/usr/share/luci-app-lanmap/build'))
	};
}

function method_log() {
	let out = readfile('/var/log/lanmapd.log');
	let lines = split(trim(out), '\n');
	let keep = [];
	for (let i = 0; i < length(lines); i++) {
		if (i >= length(lines) - 80) push(keep, lines[i]);
	}
	return { ok: true, log: join('\n', keep) };
}

/* ================= 入口 ================= */

function main() {
	let method = ARGV[0] ? ARGV[0] : '';
	let args = {};

	let raw = readfile('/dev/stdin');
	if (raw) {
		try {
			let d = json(trim(raw));
			if (type(d) == 'object') args = d;
		} catch (e) { }
	}

	let res;
	try {
		switch (method) {
		case 'devices': res = method_devices(); break;
		case 'detail':  res = method_detail(args); break;
		case 'setmeta': res = method_setmeta(args); break;
		case 'scan':    res = method_scan(); break;
		case 'summary': res = method_summary(); break;
		case 'status':  res = method_status(); break;
		case 'log':     res = method_log(); break;
		default:        res = { ok: false, error: '未知方法: ' + method };
		}
	} catch (e) {
		res = {
			ok: false,
			error: '后端异常: ' + e,
			trace: (type(e.stacktrace) == 'string' ? e.stacktrace : '')
		};
	}

	print(sprintf('%J', res), '\n');
}

main();
