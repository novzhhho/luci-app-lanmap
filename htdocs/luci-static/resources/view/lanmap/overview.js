'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

/*
 * 局域网设备管理
 *
 * 布局取向：这是「设备管理」不是流量监控，所以
 *   - 首屏就是设备清单，一屏 9 台，名称/IP 完整可读
 *   - 分组是 在线 / 已禁用 / 离线，管理动作放在详情页头部
 *   - 流量只是每行右侧的一列参考值，详情页里才展开曲线
 *
 * 字号按 Argon 的 1rem = 16px 定：正文 16px、设备名 17px、详情名 28px、次要信息 15px。
 *
 * 类名全部带 lm- 前缀。Argon 里有 .danger/.success/.primary 这类 Bootstrap
 * 工具类且带 !important，直接写 class="lm-btn danger" 会被染成红底红字看不见。
 */

var callDevices = rpc.declare({ object: 'luci.lanmap', method: 'devices', expect: { '': {} } });
var callDetail = rpc.declare({ object: 'luci.lanmap', method: 'detail', params: [ 'mac' ], expect: { '': {} } });
var callScan = rpc.declare({ object: 'luci.lanmap', method: 'scan', expect: { '': {} } });
var callStatus = rpc.declare({ object: 'luci.lanmap', method: 'status', expect: { '': {} } });

/* setmeta 只传发生变化的字段：后端对缺失的键做「不修改」处理 */
var callRename = rpc.declare({ object: 'luci.lanmap', method: 'setmeta', params: [ 'mac', 'name' ], expect: { '': {} } });
var callSetType = rpc.declare({ object: 'luci.lanmap', method: 'setmeta', params: [ 'mac', 'type' ], expect: { '': {} } });
var callBlock = rpc.declare({ object: 'luci.lanmap', method: 'setmeta', params: [ 'mac', 'blocked' ], expect: { '': {} } });

/* ---------------- 图标（内联 SVG，随主题变色，合计约 3KB） ---------------- */

var ICON = {
	phone: '<rect x="6.5" y="2.2" width="11" height="19.6" rx="2.4"/><path d="M10.3 18.6h3.4"/>',
	tablet: '<rect x="3.6" y="3.2" width="16.8" height="17.6" rx="2.2"/><path d="M10 18.4h4"/>',
	computer: '<rect x="2.6" y="4" width="18.8" height="12.2" rx="1.6"/><path d="M1.4 19.6h21.2"/>',
	tv: '<rect x="2.4" y="3.4" width="19.2" height="13" rx="1.6"/><path d="M8.5 20.4h7M12 16.4v4"/>',
	speaker: '<rect x="6" y="2.6" width="12" height="18.8" rx="2.4"/><circle cx="12" cy="8.4" r="2"/><circle cx="12" cy="15.6" r="2.6"/>',
	camera: '<path d="M2.6 8.2h5l1.6-2.4h5.6l1.6 2.4h5v11.2H2.6z"/><circle cx="12" cy="13.4" r="3.1"/>',
	printer: '<path d="M6.6 8.4V2.8h10.8v5.6"/><rect x="2.6" y="8.4" width="18.8" height="8.4" rx="1.6"/><path d="M6.6 14.4h10.8v6.8H6.6z"/>',
	nas: '<rect x="3" y="3.4" width="18" height="7" rx="1.6"/><rect x="3" y="13.6" width="18" height="7" rx="1.6"/><path d="M6.4 6.9h.02M6.4 17.1h.02"/>',
	router: '<rect x="2.4" y="12.6" width="19.2" height="7.4" rx="1.6"/><path d="M6.4 16.3h.02M9.4 16.3h.02"/><path d="M7.6 9.2a7 7 0 0 1 8.8 0"/><path d="M10.2 6.6a10.8 10.8 0 0 1 3.6 0"/>',
	game: '<path d="M7.4 8.6h9.2a4.4 4.4 0 0 1 4.3 5.3l-.7 3.6a2.3 2.3 0 0 1-4 1.1l-1.7-1.9H9.5l-1.7 1.9a2.3 2.3 0 0 1-4-1.1l-.7-3.6a4.4 4.4 0 0 1 4.3-5.3z"/><path d="M7.6 12.4v2.2M6.5 13.5h2.2M15.6 12.9h.02M17.6 14.6h.02"/>',
	iot: '<path d="M9.4 17.4a6 6 0 1 1 5.2 0v2.2a1.4 1.4 0 0 1-1.4 1.4h-2.4a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M9.8 18.6h4.4"/>',
	unknown: '<circle cx="12" cy="12" r="9.2"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.6.2-1 .8-1 1.5v.6"/><path d="M12 17.4h.02"/>'
};

var TYPES = [
	[ 'auto', '自动' ], [ 'phone', '手机' ], [ 'tablet', '平板' ], [ 'computer', '电脑' ],
	[ 'tv', '电视' ], [ 'speaker', '音箱' ], [ 'camera', '摄像头' ], [ 'printer', '打印机' ],
	[ 'nas', 'NAS' ], [ 'router', '路由器' ], [ 'game', '游戏机' ], [ 'iot', '智能家居' ],
	[ 'unknown', '未知' ]
];

var SV = {
	scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.4 8.4V4.6h3.8M16.8 4.6h3.8v3.8M20.6 15.6v3.8h-3.8M7.2 19.4H3.4v-3.8"/><path d="M3.4 12h17.2"/></svg>',
	search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="6.6"/><path d="M15.6 15.6l4.2 4.2"/></svg>',
	edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>',
	grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4"/></svg>',
	ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M5.9 5.9l12.2 12.2"/></svg>',
	ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.2 12.2l2.6 2.6 5-5.4"/></svg>',
	back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
	wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.6 8.6a14 14 0 0 1 18.8 0"/><path d="M5.9 12.2a9.4 9.4 0 0 1 12.2 0"/><path d="M9.1 15.6a5 5 0 0 1 5.8 0"/><path d="M12 19h.02"/></svg>',
	wire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.8 9.4h4.8v5.2H2.8z"/><path d="M7.6 12h3.2l2.2-2.4h5.2"/><path d="M7.6 12h10.6"/></svg>',
	chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>'
};

function raw(html, cls) {
	var s = E('span', { class: cls || '' });
	s.innerHTML = html;
	return s;
}

function svg(name, cls) {
	return raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" '
		+ 'stroke-linecap="round" stroke-linejoin="round">' + (ICON[name] || ICON.unknown) + '</svg>',
		cls || 'lm-svg');
}

/* ---------------- 格式化 ---------------- */

function fmtRate(n) {
	n = n || 0;
	if (n < 1024) return [ String(Math.round(n)), 'B/s' ];
	if (n < 1048576) return [ (n / 1024).toFixed(n < 10240 ? 1 : 0), 'KB/s' ];
	return [ (n / 1048576).toFixed(n < 10485760 ? 1 : 0), 'MB/s' ];
}

function fmtBytes(n) {
	n = n || 0;
	if (n < 1024) return [ String(n), 'B' ];
	var u = [ 'KB', 'MB', 'GB', 'TB', 'PB' ], i = -1;
	do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
	return [ n.toFixed(n < 10 ? 2 : (n < 100 ? 1 : 0)), u[i] ];
}

function fmtSize(n) {
	var a = fmtBytes(n);
	return a[0] + ' ' + a[1];
}

function ago(ts) {
	if (!ts) return '从未';
	var d = Math.floor(Date.now() / 1000) - ts;
	if (d < 0) d = 0;
	if (d < 60) return '刚刚';
	if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
	if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
	if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
	return new Date(ts * 1000).toLocaleDateString();
}

function dt(ts) {
	if (!ts) return '—';
	var d = new Date(ts * 1000);
	return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
		+ ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function dur(sec) {
	if (!sec || sec < 0) return '—';
	var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
	if (d) return d + ' 天 ' + h + ' 小时';
	if (h) return h + ' 小时 ' + m + ' 分';
	return m + ' 分';
}

/* ---------------- 图表 ---------------- */

/* 面积图：下行/上行两条曲线，共用纵轴。viewBox 固定、preserveAspectRatio=none，
 * 否则在窄栏里会按比例缩成一条线。 */
function areaChart(points) {
	var W = 620, H = 150, PAD = 4;
	var dn = points.map(function (p) { return p[1] || 0; });
	var up = points.map(function (p) { return p[0] || 0; });
	var max = Math.max.apply(null, dn.concat(up).concat([ 1024 ]));
	var n = points.length;

	function line(vals) {
		if (!n) return '';
		return vals.map(function (v, i) {
			var x = n === 1 ? W : (i / (n - 1)) * W;
			var y = H - PAD - (v / max) * (H - PAD * 2);
			return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
		}).join(' ');
	}

	var lDn = line(dn), lUp = line(up);
	var fill = function (d) { return d ? d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z' : ''; };

	return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
		+ '<defs>'
		+ '<linearGradient id="lmgdn" x1="0" y1="0" x2="0" y2="1">'
		+ '<stop offset="0%" stop-color="var(--primary,#5e72e4)" stop-opacity=".28"/>'
		+ '<stop offset="100%" stop-color="var(--primary,#5e72e4)" stop-opacity="0"/></linearGradient>'
		+ '<linearGradient id="lmgup" x1="0" y1="0" x2="0" y2="1">'
		+ '<stop offset="0%" stop-color="var(--orange,#fb6340)" stop-opacity=".24"/>'
		+ '<stop offset="100%" stop-color="var(--orange,#fb6340)" stop-opacity="0"/></linearGradient>'
		+ '</defs>'
		+ '<path d="' + fill(lDn) + '" fill="url(#lmgdn)"/>'
		+ '<path d="' + fill(lUp) + '" fill="url(#lmgup)"/>'
		+ '<path d="' + lDn + '" fill="none" stroke="var(--primary,#5e72e4)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>'
		+ '<path d="' + lUp + '" fill="none" stroke="var(--orange,#fb6340)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>'
		+ '</svg>';
}

/* 柱状图：每小时两根柱，蓝色下行在前、橙色上行在后 */
function barChart(series) {
	var W = 620, H = 130, n = series.length;
	if (!n) return '<svg viewBox="0 0 ' + W + ' ' + H + '"></svg>';

	var max = 1;
	series.forEach(function (s) { max = Math.max(max, s.d || 0); });
	var slot = W / n;
	var bw = Math.max(1.5, Math.min(9, slot * 0.34));
	var out = '';

	series.forEach(function (s, i) {
		var x = i * slot + slot / 2;
		var hd = Math.max(((s.d || 0) / max) * (H - 4), s.d > 0 ? 1.2 : 0);
		var hu = Math.max(((s.u || 0) / max) * (H - 4), s.u > 0 ? 1.2 : 0);
		if (hd) out += '<rect x="' + (x - bw - 0.6).toFixed(1) + '" y="' + (H - hd).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hd.toFixed(1) + '" rx="1" fill="var(--primary,#5e72e4)" opacity=".85"/>';
		if (hu) out += '<rect x="' + (x + 0.6).toFixed(1) + '" y="' + (H - hu).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hu.toFixed(1) + '" rx="1" fill="var(--orange,#fb6340)" opacity=".8"/>';
	});

	return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + out + '</svg>';
}

/* ---------------- 样式 ---------------- */

var CSS = `
.lm{font-size:1rem;line-height:1.6}
.lm .cbi-section{padding:0;overflow:hidden}
.lm code{color:inherit;background:rgba(136,152,170,.15);padding:.05rem .38rem;
  border-radius:.2rem;font-size:.9375rem}

/* 图标容器统一尺寸，具体大小由所在位置覆盖 */
.lm .lm-svg{display:inline-flex;flex:none;width:1.4rem;height:1.4rem}
.lm .lm-svg svg{width:100%;height:100%;display:block}

/* ---------- 顶栏 ---------- */
.lm-hd{display:flex;align-items:flex-start;gap:1rem;padding:1.15rem 1.25rem .95rem}
.lm-hd h3{margin:0;padding:0;background:none;width:auto;display:block;color:inherit;
  font-size:1.375rem;font-weight:700;line-height:1.35}
.lm-hd .lm-hsub{margin-top:.15rem;font-size:.9375rem;color:var(--gray,#8898aa);
  display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.lm-hd .lm-hsub b{color:inherit;font-weight:600}
.lm-hd .lm-hsub .s{opacity:.5}
.lm-tools{margin-left:auto;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.lm-search{position:relative;display:flex;align-items:center}
.lm-search .lm-svg{position:absolute;left:.62rem;width:1.05rem;height:1.05rem;
  color:var(--gray,#8898aa);pointer-events:none}
.lm-search input{width:13rem;height:2.45rem;padding:.3rem .7rem .3rem 2.15rem;
  font-size:.9375rem;border-radius:.25rem;border:1px solid var(--border-color,#dee2e6);
  background:transparent;color:inherit;outline:0}
.lm-search input:focus{border-color:var(--primary,#5e72e4)}

.lm-btn{display:inline-flex;align-items:center;gap:.4rem;height:2.45rem;padding:0 .8rem;
  font-size:.9375rem;line-height:1;border-radius:.25rem;cursor:pointer;
  border:1px solid var(--border-color,#dee2e6);background:transparent;color:inherit;
  font-family:inherit;transition:border-color .15s,color .15s,background .15s}
.lm-btn .lm-svg{width:1.05rem;height:1.05rem;color:var(--gray,#8898aa)}
.lm-btn:hover{border-color:var(--primary,#5e72e4);color:var(--primary,#5e72e4)}
.lm-btn:hover .lm-svg{color:inherit}
.lm-btn[disabled]{opacity:.55;cursor:default}
.lm-btn.lm-primary{background:var(--primary,#5e72e4);border-color:var(--primary,#5e72e4);color:#fff}
.lm-btn.lm-primary .lm-svg{color:#fff}
.lm-btn.lm-primary:hover{filter:brightness(1.06)}
.lm-btn.lm-danger{border-color:rgba(245,54,92,.45);color:var(--danger,#f5365c)}
.lm-btn.lm-danger .lm-svg{color:var(--danger,#f5365c)}
.lm-btn.lm-danger:hover{background:rgba(245,54,92,.08);border-color:var(--danger,#f5365c);color:var(--danger,#f5365c)}
.lm-btn.lm-danger:hover .lm-svg{color:inherit}

/* ---------- 筛选 ---------- */
.lm-tabs{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;
  padding:.6rem 1.25rem;border-top:1px solid var(--border-color,#dee2e6);
  border-bottom:1px solid var(--border-color,#dee2e6);background:rgba(136,152,170,.05)}
.lm-tab{display:inline-flex;align-items:center;gap:.4rem;height:2.1rem;padding:0 .72rem;
  font-size:.9375rem;border-radius:.25rem;cursor:pointer;color:inherit;
  border:1px solid transparent;background:transparent;font-family:inherit}
.lm-tab b{font-weight:600;font-variant-numeric:tabular-nums}
.lm-tab .n{color:var(--gray,#8898aa);font-variant-numeric:tabular-nums}
.lm-tab:hover{background:rgba(136,152,170,.14)}
.lm-tab.on{background:var(--primary,#5e72e4);color:#fff}
.lm-tab.on .n{color:rgba(255,255,255,.72)}

/* ---------- 分组 ---------- */
.lm-group{display:flex;align-items:center;gap:.5rem;padding:.5rem 1.25rem .35rem;
  font-size:.875rem;font-weight:600;letter-spacing:.02em;color:var(--gray,#8898aa);
  background:rgba(136,152,170,.03);border-top:1px solid var(--border-color,#dee2e6)}
.lm-group .dot{width:.42rem;height:.42rem;border-radius:50%;background:var(--border-color,#dee2e6)}
.lm-group.online .dot{background:var(--success,#2dce89)}
.lm-group.blocked .dot{background:var(--danger,#f5365c)}
.lm-group .n2{margin-left:auto;font-weight:400;color:var(--gray,#8898aa)}

/* ---------- 设备行 ---------- */
.lm-row{display:grid;grid-template-columns:2.75rem minmax(0,1fr) auto 1rem;
  gap:.2rem .85rem;align-items:center;width:100%;padding:.7rem 1.25rem;margin:0;
  border:0;border-top:1px solid var(--border-color,#dee2e6);
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;
  height:auto;line-height:1.5;transition:background .13s}
.lm-row:first-of-type{border-top:0}
.lm-row:hover{background:rgba(94,114,228,.055)}
.lm-ava{grid-row:1;position:relative;display:grid;place-items:center;
  width:2.75rem;height:2.75rem;border-radius:.6rem;
  background:rgba(136,152,170,.14);color:var(--gray,#8898aa)}
.lm-ava .lm-svg{width:1.5rem;height:1.5rem}
.lm-row.on .lm-ava{background:rgba(94,114,228,.1);color:var(--primary,#5e72e4)}
.lm-row.blk .lm-ava{background:rgba(245,54,92,.1);color:var(--danger,#f5365c)}
.lm-live{position:absolute;right:-.16rem;top:-.16rem;width:.66rem;height:.66rem;
  border-radius:50%;border:2px solid var(--white,#fff);background:var(--border-color,#dee2e6)}
.lm-row.on .lm-live{background:var(--success,#2dce89)}

.lm-id{min-width:0}
.lm-name{display:flex;align-items:center;gap:.45rem;font-size:1.0625rem;
  font-weight:600;line-height:1.4}
.lm-name .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lm-name .badge{flex:none;padding:0 .38rem;border-radius:.2rem;font-size:.8125rem;
  font-weight:500;line-height:1.55;background:rgba(251,99,64,.14);color:var(--orange,#fb6340)}
.lm-name .badge.red{background:rgba(245,54,92,.13);color:var(--danger,#f5365c)}
.lm-sub{display:flex;align-items:center;gap:.35rem;margin-top:.1rem;
  font-size:.9375rem;color:var(--gray,#8898aa);line-height:1.45;
  overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.lm-sub .lm-svg{width:1rem;height:1rem;margin-right:.1rem}
.lm-sub .ip{font-variant-numeric:tabular-nums}

.lm-rt{text-align:right;font-size:.9375rem;font-variant-numeric:tabular-nums;
  display:flex;flex-direction:column;align-items:flex-end;gap:.06rem;min-width:6.4rem}
.lm-rt .v{font-weight:600;line-height:1.35;white-space:nowrap}
.lm-rt .rates{display:flex;align-items:baseline;gap:.5rem;justify-content:flex-end}
.lm-rt .v.dn{color:var(--primary,#5e72e4)}
.lm-rt .v.up{color:var(--orange,#fb6340)}
.lm-rt .v.idle,.lm-rt .v.off{color:var(--gray,#8898aa);font-weight:400}
.lm-rt .v.blk{color:var(--danger,#f5365c);font-weight:600}
.lm-rt .t{color:var(--gray,#8898aa);line-height:1.3;font-size:.875rem}
.lm-chev{display:grid;place-items:center;width:1rem;height:1rem;color:var(--gray,#8898aa)}
.lm-chev svg{width:100%;height:100%;display:block}

.lm-empty{padding:3rem 1.25rem;text-align:center;color:var(--gray,#8898aa);font-size:1rem}

/* ---------- 详情 ---------- */
.lm-back{display:inline-flex;align-items:center;gap:.35rem;padding:.85rem 1.25rem .1rem;
  font-size:.9375rem;color:var(--gray,#8898aa);background:none;border:0;cursor:pointer;
  font-family:inherit}
.lm-back:hover{color:var(--primary,#5e72e4)}
.lm-back .lm-svg{width:1.1rem;height:1.1rem}
.lm-hero{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;
  padding:.65rem 1.25rem 1.15rem}
.lm-hero .lm-ava{width:4rem;height:4rem;border-radius:.85rem;grid-row:auto;
  color:var(--primary,#5e72e4);background:rgba(94,114,228,.1)}
.lm-hero .lm-ava .lm-svg{width:2.15rem;height:2.15rem}
.lm-hero .lm-hname{margin:0;font-size:1.75rem;font-weight:700;line-height:1.25;color:inherit}
.lm-hero .lm-hmeta{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-top:.3rem}
.lm-pill{display:inline-flex;align-items:center;gap:.3rem;padding:.08rem .55rem;
  border-radius:.25rem;font-size:.875rem;line-height:1.65;
  background:rgba(136,152,170,.15);color:inherit}
.lm-pill.ok{background:rgba(45,206,137,.14);color:var(--success,#2dce89);font-weight:600}
.lm-pill.warn{background:rgba(251,99,64,.13);color:var(--orange,#fb6340)}
.lm-pill.bad{background:rgba(245,54,92,.12);color:var(--danger,#f5365c);font-weight:600}
.lm-hero .lm-hact{margin-left:auto;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}

.lm-picker{display:flex;flex-wrap:wrap;gap:.4rem;padding:.9rem 1.25rem 1.1rem;
  border-top:1px solid var(--border-color,#dee2e6)}
.lm-picker button{display:inline-flex;flex-direction:column;align-items:center;gap:.25rem;
  width:4.6rem;padding:.5rem .2rem;font-size:.8125rem;border-radius:.35rem;cursor:pointer;
  border:1px solid var(--border-color,#dee2e6);background:transparent;color:inherit;
  font-family:inherit}
.lm-picker button .lm-svg{width:1.5rem;height:1.5rem;color:var(--gray,#8898aa)}
.lm-picker button:hover{border-color:var(--primary,#5e72e4);color:var(--primary,#5e72e4)}
.lm-picker button:hover .lm-svg{color:inherit}
.lm-picker button.on{border-color:var(--primary,#5e72e4);background:rgba(94,114,228,.08);
  color:var(--primary,#5e72e4);font-weight:600}
.lm-picker button.on .lm-svg{color:inherit}

.lm-cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);
  border-top:1px solid var(--border-color,#dee2e6)}
.lm-col{padding:1.05rem 1.25rem}
.lm-col+.lm-col{border-left:1px solid var(--border-color,#dee2e6)}
.lm-kv{display:grid;grid-template-columns:5.6rem minmax(0,1fr);gap:.55rem .8rem;
  margin:0;font-size:.9375rem;line-height:1.55}
.lm-kv dt{color:var(--gray,#8898aa)}
.lm-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}

.lm-live-rate{display:flex;align-items:baseline;gap:1.1rem;margin:.15rem 0 .7rem}
.lm-live-rate .v{font-size:1.75rem;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.lm-live-rate .v.dn{color:var(--primary,#5e72e4)}
.lm-live-rate .v.up{color:var(--orange,#fb6340)}
.lm-live-rate .u{font-size:.9375rem;font-weight:400;color:var(--gray,#8898aa)}
.lm-live-foot{display:flex;gap:1.3rem;flex-wrap:wrap;margin-top:.6rem;padding-top:.65rem;
  border-top:1px solid var(--border-color,#dee2e6);
  font-size:.875rem;color:var(--gray,#8898aa)}
.lm-live-foot b{font-weight:600;color:inherit}

.lm-flow{display:flex;border-top:1px solid var(--border-color,#dee2e6)}
.lm-flow>div{flex:1;padding:.85rem 1.25rem;border-right:1px solid var(--border-color,#dee2e6)}
.lm-flow>div:last-child{border-right:0}
.lm-flow .k{font-size:.875rem;color:var(--gray,#8898aa);line-height:1.4}
.lm-flow .v{font-size:1.5rem;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums}
.lm-flow .v small{font-size:.9375rem;font-weight:400;color:var(--gray,#8898aa);margin-left:.15rem}

.lm-chart{padding:1rem 1.25rem 1.1rem;border-top:1px solid var(--border-color,#dee2e6)}
.lm-chart .t{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem;flex-wrap:wrap}
.lm-chart .t b{font-size:1rem;font-weight:600}
.lm-chart .t .lg{margin-left:auto;display:flex;gap:.9rem;font-size:.875rem;color:var(--gray,#8898aa)}
.lm-chart .t .lg span{display:inline-flex;align-items:center;gap:.32rem}
.lm-chart .t .lg i{width:.6rem;height:.6rem;border-radius:.15rem}
.lm-svgwrap{width:100%}
/* 固定高度：否则 svg 按 viewBox 等比缩放，在窄栏里会被压成一条线 */
.lm-svgwrap svg{display:block;width:100%;height:9.5rem}
.lm-placeholder{height:9.5rem;display:grid;place-items:center;border-radius:.35rem;
  background:rgba(136,152,170,.06);color:var(--gray,#8898aa);font-size:.9375rem}
.lm-chart .lm-svgwrap svg{height:7.6rem}
.lm-axis{display:flex;justify-content:space-between;margin-top:.35rem;
  font-size:.8125rem;color:var(--gray,#8898aa);font-variant-numeric:tabular-nums}

.lm-warn{padding:.7rem 1.25rem;font-size:.9375rem;
  background:rgba(251,99,64,.08);color:var(--orange,#fb6340);
  border-top:1px solid var(--border-color,#dee2e6)}

@media screen and (max-width:760px){
  .lm-hd{flex-wrap:wrap;padding:1rem 1rem .8rem}
  .lm-tools{margin-left:0;width:100%}
  .lm-search{flex:1 1 auto}
  .lm-search input{width:100%}
  .lm-row{grid-template-columns:2.5rem minmax(0,1fr) auto;gap:.15rem .7rem;padding:.65rem 1rem}
  .lm-c,.lm-t,.lm-lbl{display:none}
  .lm-sub{font-size:.875rem}
  .lm-rt{min-width:5.6rem}
  .lm-name .badge{display:none}
  .lm-ava{width:2.5rem;height:2.5rem}
  .lm-chev{display:none}
  .lm-tabs,.lm-group,.lm-hd,.lm-col,.lm-flow>div,.lm-chart,.lm-picker,.lm-warn{padding-left:1rem;padding-right:1rem}
  .lm-tabs{gap:.22rem;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .lm-tabs::-webkit-scrollbar{display:none}
  .lm-tab{flex:none;padding:0 .5rem;font-size:.8125rem;gap:.28rem}
  .lm-cols{grid-template-columns:1fr}
  .lm-col+.lm-col{border-left:0;border-top:1px solid var(--border-color,#dee2e6)}
  .lm-hero .lm-hact{margin-left:0;width:100%}
  .lm-flow{flex-wrap:wrap}
  .lm-flow>div{flex:1 1 50%}
  .lm-hero .lm-hname{font-size:1.5rem}
}
`;

/* ---------------- 视图 ---------------- */

return view.extend({
	load: function () {
		return Promise.all([ callDevices(), callStatus() ]);
	},

	render: function (res) {
		this.data = (res[0] && res[0].ok) ? res[0] : { devices: [], count: {} };
		this.status = (res[1] && res[1].ok) ? res[1] : {};
		this.filter = 'all';
		this.query = '';
		this.mac = null;
		this.detail = null;
		this.picker = false;
		this.sig = '';

		this.wrap = E('div', { class: 'cbi-section' });

		var root = E('div', { class: 'cbi-map lm' });
		root.appendChild(E('style', {}, CSS));
		root.appendChild(this.wrap);

		this.renderList();
		poll.add(L.bind(this.refresh, this), 5);

		return root;
	},

	/* 数据没变就不重绘，避免 5 秒一次的闪烁和点击落空 */
	refresh: function () {
		var self = this;

		return callDevices().then(function (d) {
			if (!d || !d.ok) return;

			if (self.mac) {
				return callDetail(self.mac).then(function (r) {
					if (!r || !r.ok) { self.mac = null; self.detail = null; self.renderList(); return; }
					self.detail = r.device;
					self.renderDetail();
				});
			}

			var sig = JSON.stringify((d.devices || []).map(function (x) {
				return [ x.mac, x.online, x.blocked, x.name, x.type, x.ru, x.rd, x.tu, x.td ];
			}));
			self.data = d;
			if (sig === self.sig) return;
			self.sig = sig;
			self.renderList();
		}).catch(function () { });
	},

	/* ---------- 列表 ---------- */

	renderList: function () {
		var self = this;
		var d = this.data || { devices: [], count: {} };
		var all = d.devices || [];
		var c = d.count || {};

		var today = all.reduce(function (s, x) { return s + (x.tu || 0) + (x.td || 0); }, 0);

		var hd = E('div', { class: 'lm-hd' }, [
			E('div', {}, [
				E('h3', {}, '设备管理'),
				E('div', { class: 'lm-hsub' }, [
					E('span', {}, [ E('b', {}, String(c.total || all.length)), ' 台设备' ]),
					E('span', { class: 's' }, '·'),
					E('span', {}, [ '在线 ', E('b', {}, String(c.online || 0)) ]),
					E('span', { class: 's' }, '·'),
					E('span', {}, '今日流量 ' + fmtSize(today))
				])
			]),
			E('div', { class: 'lm-tools' }, [
				E('div', { class: 'lm-search' }, [
					raw(SV.search, 'lm-svg'),
					E('input', {
						type: 'text', placeholder: '搜索名称、IP、MAC', value: this.query,
						input: function (ev) { self.query = ev.target.value; self.renderRows(); }
					})
				]),
				E('button', { class: 'lm-btn', click: ui.createHandlerFn(this, 'doScan') },
					[ raw(SV.scan, 'lm-svg'), E('span', { class: 'lm-lbl' }, '扫描新设备') ])
			])
		]);

		var tabs = [
			[ 'all', '全部', c.total || all.length ],
			[ 'online', '在线', c.online || 0 ],
			[ 'offline', '离线', c.offline || 0 ],
			[ 'blocked', '已禁用', c.blocked || 0 ]
		];

		var tabbar = E('div', { class: 'lm-tabs' }, tabs.map(function (t) {
			return E('button', {
				class: 'lm-tab' + (self.filter === t[0] ? ' on' : ''),
				click: function () { self.filter = t[0]; self.renderList(); }
			}, [ E('b', {}, t[1]), E('span', { class: 'n' }, String(t[2])) ]);
		}));

		this.listBox = E('div', {});
		this.wrap.replaceChildren(hd, tabbar, this.listBox);
		this.renderRows();
	},

	renderRows: function () {
		var self = this;
		var all = (this.data && this.data.devices) || [];
		var q = (this.query || '').trim().toLowerCase();

		var list = all.filter(function (x) {
			if (self.filter === 'online' && !x.online) return false;
			if (self.filter === 'offline' && x.online) return false;
			if (self.filter === 'blocked' && !x.blocked) return false;
			if (!q) return true;
			return (x.name || '').toLowerCase().indexOf(q) >= 0
				|| (x.host || '').toLowerCase().indexOf(q) >= 0
				|| (x.ip || '').indexOf(q) >= 0
				|| (x.mac || '').indexOf(q) >= 0
				|| (x.vendor || '').toLowerCase().indexOf(q) >= 0;
		});

		var groups = [
			[ 'blocked', '已禁用', list.filter(function (x) { return x.blocked; }) ],
			[ 'online', '在线', list.filter(function (x) { return !x.blocked && x.online; }) ],
			[ 'offline', '离线', list.filter(function (x) { return !x.blocked && !x.online; }) ]
		];

		var out = [];
		var shown = 0;

		groups.forEach(function (g) {
			if (!g[2].length) return;
			shown += g[2].length;
			out.push(E('div', { class: 'lm-group ' + g[0] }, [
				E('span', { class: 'dot' }),
				E('span', {}, g[1]),
				E('span', { class: 'n2' }, g[2].length + ' 台')
			]));
			g[2].forEach(function (x) { out.push(self.row(x)); });
		});

		if (!shown)
			out.push(E('div', { class: 'lm-empty' }, q ? '没有匹配的设备' : '暂无设备'));

		this.listBox.replaceChildren.apply(this.listBox, out);
	},

	row: function (x) {
		var self = this;
		var rt;

		if (x.blocked) {
			rt = E('span', { class: 'v blk' }, '已禁用');
		}
		else if (!x.online) {
			rt = E('span', { class: 'v off' }, '离线');
		}
		else if ((x.ru || 0) > 0 && (x.rd || 0) > 0) {
			var d1 = fmtRate(x.rd), u1 = fmtRate(x.ru);
			rt = E('span', { class: 'rates' }, [
				E('span', { class: 'v dn' }, '↓ ' + d1[0] + ' ' + d1[1]),
				E('span', { class: 'v up' }, '↑ ' + u1[0] + ' ' + u1[1])
			]);
		}
		else if ((x.rd || 0) > 0) {
			var d2 = fmtRate(x.rd);
			rt = E('span', { class: 'v dn' }, '↓ ' + d2[0] + ' ' + d2[1]);
		}
		else if ((x.ru || 0) > 0) {
			var u2 = fmtRate(x.ru);
			rt = E('span', { class: 'v up' }, '↑ ' + u2[0] + ' ' + u2[1]);
		}
		else {
			rt = E('span', { class: 'v idle' }, '空闲');
		}

		var name = E('span', { class: 'lm-name' }, [ E('span', { class: 'n' }, x.name || x.mac) ]);
		if (x.random_mac) name.appendChild(E('span', { class: 'badge' }, '随机 MAC'));

		var sub = E('span', { class: 'lm-sub' }, [ raw(x.conn === 'wifi' ? SV.wifi : SV.wire, 'lm-svg') ]);
		sub.appendChild(E('span', { class: 'lm-c' }, (x.conn === 'wifi' ? '无线' : '有线') + ' · '));
		sub.appendChild(E('span', { class: 'lm-t' },
			(x.type_name || '未知设备') + (x.vendor ? ' · ' + x.vendor : '')));
		/* 名称已经是 IP 时不再重复一遍 */
		if (x.ip && x.ip !== x.name) sub.appendChild(E('span', { class: 'ip' }, ' · ' + x.ip));

		return E('button', {
			class: 'lm-row' + (x.blocked ? ' blk' : (x.online ? ' on' : '')),
			click: function () { self.openDetail(x.mac); }
		}, [
			E('span', { class: 'lm-ava' }, [ svg(x.type), E('span', { class: 'lm-live' }) ]),
			E('span', { class: 'lm-id' }, [ name, sub ]),
			E('span', { class: 'lm-rt' }, [
				rt,
				E('span', { class: 't' }, '今日 ' + fmtSize((x.tu || 0) + (x.td || 0)))
			]),
			raw(SV.chev, 'lm-chev')
		]);
	},

	/* ---------- 详情 ---------- */

	openDetail: function (mac) {
		var self = this;
		this.mac = mac;
		this.picker = false;

		return callDetail(mac).then(function (r) {
			if (!r || !r.ok) {
				ui.addNotification(null, E('p', {}, (r && r.error) || '读取设备详情失败'));
				self.mac = null;
				return;
			}
			self.detail = r.device;
			self.renderDetail();
		});
	},

	renderDetail: function () {
		var self = this;
		var x = this.detail;
		if (!x) { this.mac = null; this.renderList(); return; }

		var pills = [ E('span', { class: 'lm-pill ' + (x.online ? 'ok' : '') }, x.online ? '在线' : '离线') ];
		pills.push(E('span', { class: 'lm-pill' }, x.type_name));
		if (x.vendor) pills.push(E('span', { class: 'lm-pill' }, x.vendor));
		if (x.random_mac) pills.push(E('span', { class: 'lm-pill warn' }, '随机 MAC'));
		if (x.blocked) pills.push(E('span', { class: 'lm-pill bad' }, '已禁止上网'));

		var back = E('button', {
			class: 'lm-back',
			click: function () { self.mac = null; self.detail = null; self.renderList(); }
		}, [ raw(SV.back, 'lm-svg'), '所有设备' ]);

		var hero = E('div', { class: 'lm-hero' }, [
			E('span', { class: 'lm-ava' }, [ svg(x.type), E('span', { class: 'lm-live' }) ]),
			E('div', {}, [
				E('h4', { class: 'lm-hname' }, x.name || x.mac),
				E('div', { class: 'lm-hmeta' }, pills)
			]),
			E('div', { class: 'lm-hact' }, [
				E('button', { class: 'lm-btn', click: ui.createHandlerFn(this, 'doRename') },
					[ raw(SV.edit, 'lm-svg'), '重命名' ]),
				E('button', {
					class: 'lm-btn',
					click: function () { self.picker = !self.picker; self.renderDetail(); }
				}, [ raw(SV.grid, 'lm-svg'), '更换图标' ]),
				E('button', {
					class: 'lm-btn' + (x.blocked ? '' : ' lm-danger'),
					click: ui.createHandlerFn(this, 'doToggleBlock')
				}, [ raw(x.blocked ? SV.ok : SV.ban, 'lm-svg'), x.blocked ? '恢复上网' : '禁止上网' ])
			])
		]);

		var frag = [ back, hero ];

		if (this.picker) {
			var cur = x.custom_type || 'auto';
			frag.push(E('div', { class: 'lm-picker' }, TYPES.map(function (t) {
				return E('button', {
					class: cur === t[0] ? 'on' : '',
					click: ui.createHandlerFn(self, 'doSetType', t[0])
				}, [ svg(t[0] === 'auto' ? x.type : t[0]), E('span', {}, t[1]) ]);
			})));
		}

		/* 左栏：设备身份 */
		var kv = [
			[ '接入方式', (x.conn === 'wifi' ? '无线' : '有线') + (x.online ? '' : ' · 当前离线') ],
			[ 'IP 地址', x.ip ? E('code', {}, x.ip) : '—' ],
			[ 'IPv6', x.ip6 ? E('code', {}, x.ip6) : '—' ],
			[ 'MAC 地址', E('code', {}, x.mac) ],
			[ '主机名', x.host || '—' ],
			[ '厂商', x.vendor || (x.random_mac ? '随机 MAC，无法识别' : '未知') ],
			[ '首次发现', x.first ? dt(x.first) : '刚刚' ],
			[ '最后一次', x.online ? '现在' : ago(x.last) ],
			[ 'DHCP 租约', (x.lease && x.lease.remain > 0) ? '剩余 ' + dur(x.lease.remain) : '无（静态或已过期）' ]
		];

		var dl = E('dl', { class: 'lm-kv' });
		kv.forEach(function (k) {
			dl.appendChild(E('dt', {}, k[0]));
			dl.appendChild(E('dd', {}, k[1]));
		});

		/* 右栏：实时曲线 */
		var rd = fmtRate(x.rd || 0), ru = fmtRate(x.ru || 0);
		var totalNow = (x.uptime_bytes ? (x.uptime_bytes.u + x.uptime_bytes.d) : 0);

		var right = E('div', { class: 'lm-col' }, [
			E('div', { class: 'lm-live-rate' }, [
				E('span', { class: 'v dn' }, [ rd[0], E('span', { class: 'u' }, ' ' + rd[1]) ]),
				E('span', { class: 'v up' }, [ ru[0], E('span', { class: 'u' }, ' ' + ru[1]) ])
			]),
			((x.live && x.live.length >= 2)
				? raw(areaChart(x.live), 'lm-svgwrap')
				: E('div', { class: 'lm-svgwrap lm-placeholder' }, '正在采集实时速率，约 10 秒后显示曲线')),
			E('div', { class: 'lm-axis' }, [
				E('span', {}, '近 5 分钟'), E('span', {}, '蓝=下行 橙=上行'), E('span', {}, '现在')
			]),
			E('div', { class: 'lm-live-foot' }, [
				E('span', {}, [ '本次开机累计 ', E('b', {}, fmtSize(totalNow)) ]),
				E('span', {}, [ '最后活跃 ', E('b', {}, ago(x.last)) ])
			])
		]);

		frag.push(E('div', { class: 'lm-cols' }, [
			E('div', { class: 'lm-col' }, [ dl ]),
			right
		]));

		/* 流量四格 */
		frag.push(E('div', { class: 'lm-flow' }, [
			[ '今日', x.today ], [ '近 7 天', x.week ], [ '近 30 天', x.month ], [ '累计', x.total ]
		].map(function (f) {
			var v = f[1] || {};
			var s = fmtBytes((v.u || 0) + (v.d || 0));
			return E('div', {}, [
				E('div', { class: 'k' }, f[0]),
				E('div', { class: 'v' }, [ s[0], E('small', {}, s[1]) ])
			]);
		})));

		/* 近 24 小时，按小时对齐成 24 个槽 */
		var ser = x.series || [];
		var nowH = Math.floor(Date.now() / 3600000) * 3600;
		var slots = [];
		for (var i = 23; i >= 0; i--) {
			var t = nowH - i * 3600;
			var hit = null;
			for (var j = 0; j < ser.length; j++)
				if (ser[j].t === t) { hit = ser[j]; break; }
			slots.push(hit || { t: t, u: 0, d: 0 });
		}

		frag.push(E('div', { class: 'lm-chart' }, [
			E('div', { class: 't' }, [
				E('b', {}, '近 24 小时'),
				E('div', { class: 'lg' }, [
					E('span', {}, [ E('i', { style: 'background:var(--primary,#5e72e4)' }), '下行' ]),
					E('span', {}, [ E('i', { style: 'background:var(--orange,#fb6340)' }), '上行' ])
				])
			]),
			raw(barChart(slots), 'lm-svgwrap'),
			E('div', { class: 'lm-axis' }, [
				E('span', {}, new Date((nowH - 23 * 3600) * 1000).getHours() + ':00'),
				E('span', {}, new Date((nowH - 12 * 3600) * 1000).getHours() + ':00'),
				E('span', {}, '现在')
			])
		]));

		if (this.status && this.status.offload)
			frag.push(E('div', { class: 'lm-warn' },
				'路由器开启了 flow offloading，部分转发流量会绕过计数钩子，统计值可能偏低。可在「防火墙 → 常规设置」里关闭软件/硬件流量分载。'));

		if (this.status && this.status.running === false)
			frag.push(E('div', { class: 'lm-warn' }, '采集服务未运行，实时速率和历史流量都不会更新。请检查 /etc/init.d/lanmap。'));

		this.wrap.replaceChildren.apply(this.wrap, frag);
	},

	/* ---------- 动作 ---------- */

	doRename: function () {
		var self = this;
		var cur = (this.detail && this.detail.alias) || '';
		var v = window.prompt('给这台设备起个好认的名字（留空则恢复默认）', cur);
		if (v === null) return;

		return callRename(this.detail.mac, v.trim()).then(function (r) {
			if (!r || !r.ok) { ui.addNotification(null, E('p', {}, (r && r.error) || '重命名失败')); return; }
			return self.openDetail(self.detail.mac).then(function () { self.sig = ''; });
		});
	},

	doSetType: function (type) {
		var self = this;
		var v = (type === 'auto') ? '' : type;

		return callSetType(this.detail.mac, v).then(function (r) {
			if (!r || !r.ok) { ui.addNotification(null, E('p', {}, (r && r.error) || '设置失败')); return; }
			self.picker = false;
			self.sig = '';
			return self.openDetail(self.detail.mac);
		});
	},

	doToggleBlock: function () {
		var self = this;
		var next = !this.detail.blocked;
		var nm = this.detail.name || this.detail.mac;
		var msg = next
			? '禁止「' + nm + '」访问外网？\n\n局域网内互访、DHCP 和路由器管理页面不受影响。'
			: '恢复「' + nm + '」的上网权限？';

		if (!window.confirm(msg)) return;

		return callBlock(this.detail.mac, next).then(function (r) {
			if (!r || !r.ok) { ui.addNotification(null, E('p', {}, (r && r.error) || '操作失败')); return; }
			ui.addNotification(null, E('p', {}, next ? '已禁止「' + nm + '」上网' : '已恢复「' + nm + '」上网'), 'info');
			self.sig = '';
			return self.openDetail(self.detail.mac);
		});
	},

	doScan: function (ev) {
		var self = this;
		var btn = ev.currentTarget;
		btn.disabled = true;

		return callScan().then(function (r) {
			btn.disabled = false;
			if (!r || !r.ok) { ui.addNotification(null, E('p', {}, (r && r.error) || '扫描失败')); return; }
			ui.addNotification(null, E('p', {}, '扫描完成，发现 ' + r.found + ' 台设备'), 'info');
			self.sig = '';
			return self.refresh();
		}).catch(function () { btn.disabled = false; });
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
