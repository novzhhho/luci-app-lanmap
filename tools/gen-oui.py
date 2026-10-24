#!/usr/bin/env python3
"""
生成 root/usr/share/lanmap/oui.tsv —— MAC 前缀 -> 厂商名

数据来自 Wireshark 的 manuf 表（内容出自 IEEE 注册库，每周更新一次）：
    https://www.wireshark.org/download/automated/data/manuf

用法：
    python3 tools/gen-oui.py                      # 自动下载并生成
    python3 tools/gen-oui.py path/to/manuf        # 用本地已下载的 manuf
    python3 tools/gen-oui.py --check              # 只检查现有文件是否可解析

只保留 24 位（/24）分配块：/28、/36 属于子块划分，对「这台设备是什么牌子」
没有额外帮助，反而让文件变大三倍。
"""

import gzip
import io
import os
import re
import sys
import urllib.request

URL = "https://www.wireshark.org/download/automated/data/manuf"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "root", "usr", "share", "lanmap", "oui.tsv")

# 公司类型后缀：去掉后名字更像普通用户会看到的品牌名
SUFFIX = {
    'inc', 'inc.', 'ltd', 'ltd.', 'co', 'co.', 'corp', 'corp.', 'corporation',
    'gmbh', 'llc', 'limited', 's.a.', 's.a', 'b.v.', 'b.v', 'ag', 'sas',
    's.a.s.', 'pty', 'pty.', 'plc', 'oy', 'ab', 'as', 'kk', 'k.k.',
}

# 中国厂商普遍带城市前缀，去掉更好读
CITY = {
    'shenzhen', 'guangzhou', 'hangzhou', 'beijing', 'shanghai', 'dongguan',
    'chengdu', 'wuhan', 'suzhou', 'nanjing', 'xiamen', 'zhuhai', 'fuzhou',
    'qingdao', 'tianjin', 'huizhou', 'zhongshan', 'ningbo', 'changsha',
}

# 「XX Electronics / XX Technology」这类后缀剥掉，只留品牌词
TECH = {
    'technology', 'technologies', 'communication', 'communications',
    'electronics', 'electronic', 'industrial', 'network', 'networks',
}

# 少数几个高频厂商直接给规范名，避免被上面的规则削得奇怪
ALIAS = {
    'intel corporate': 'Intel',
    'asustek computer': 'ASUSTek',
    'tp-link technologies': 'TP-Link',
    'xiaomi communications': 'Xiaomi',
    'huawei technologies': 'Huawei',
    'samsung electronics': 'Samsung',
    'hewlett packard': 'HP',
    'apple': 'Apple',
    'google': 'Google',
}

MAXLEN = 24


def cleanup(name: str) -> str:
    name = re.sub(r'\([^)]*\)', ' ', name)          # 去掉括号注释
    name = name.split(',')[0]                        # ', Inc.' 之类已经在逗号后
    words = name.replace('.', '. ').split()

    while words and words[-1].lower().strip('.,') in SUFFIX:
        words.pop()
    if words and words[0].lower() in CITY:
        words = words[1:]
    while len(words) > 1 and words[-1].lower().strip('.,') in TECH:
        words.pop()

    s = re.sub(r'\s+', ' ', ' '.join(words)).strip(' .,-')
    if s.lower() in ALIAS:
        return ALIAS[s.lower()]
    if len(s) > MAXLEN:
        s = s[:MAXLEN].rstrip(' .,-')
    return s


def parse(raw: str):
    out, seen = [], set()
    for line in raw.splitlines():
        if line.startswith('#') or not line.strip():
            continue
        f = [x.strip() for x in line.split('\t')]
        if len(f) < 3:
            continue
        prefix = f[0]
        # 只要 /24 块：形如 00:1A:2B
        if len(prefix) != 8 or not re.fullmatch(r'[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){2}', prefix):
            continue
        key = prefix.replace(':', '').lower()
        if key in seen or key == '000000':          # 00:00:00 不是真实厂商
            continue
        name = cleanup(f[2])
        if not name:
            continue
        seen.add(key)
        out.append((key, name))
    out.sort()
    return out


def main():
    args = [a for a in sys.argv[1:]]
    check = '--check' in args
    args = [a for a in args if a != '--check']

    if check:
        txt = open(OUT, encoding='utf-8').read()
        rows = [l for l in txt.splitlines() if l.strip()]
        bad = [l for l in rows if '\t' not in l]
        print(f'{OUT}: {len(rows)} 条, 格式异常 {len(bad)} 条')
        return 0 if not bad else 1

    if args:
        raw = open(args[0], encoding='utf-8', errors='replace').read()
        src = args[0]
    else:
        print(f'下载 {URL} ...')
        with urllib.request.urlopen(URL, timeout=120) as r:
            raw = r.read().decode('utf-8', 'replace')
        src = URL

    rows = parse(raw)
    txt = ''.join(f'{k}\t{n}\n' for k, n in rows)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(txt)

    size = len(txt.encode())
    gz = len(gzip.compress(txt.encode()))
    uniq = len({n for _, n in rows})
    print(f'来源 : {src}')
    print(f'输出 : {OUT}')
    print(f'条目 : {len(rows)}  ({uniq} 个不同厂商)')
    print(f'体积 : {size/1024:.0f} KB  (gzip {gz/1024:.0f} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
