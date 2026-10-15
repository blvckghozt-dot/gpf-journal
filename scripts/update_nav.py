#!/usr/bin/env python3
"""ดึง NAV ล่าสุดจากหน้า "มูลค่ากองทุน" ของ กบข. แล้วบันทึกลง data/nav.json (ใช้กับ GitHub Actions)"""
import html, json, re, sys, urllib.request, datetime, pathlib

URL = 'https://www.gpf.or.th/thai2019/About/main.php?page=memberfund&lang=th&menu=statistic'
PLANS = ['เชิงรุก 35', 'ลงทุนพื้นฐานทั่วไป', 'ตราสารหนี้ต่างประเทศ', 'ตราสารหนี้', 'เงินฝากและตราสารหนี้ระยะสั้น', 'เชิงรุก 20', 'เชิงรุก 65', 'เชิงรุก 75',
         'หุ้นไทย', 'กองทุนอสังหาริมทรัพย์ไทย', 'หุ้นต่างประเทศ', 'ทองคำ', 'กองทุนรวมวายุภักษ์', 'เกษียณสบายใจ 2569', 'การลงทุนตามหลักชะรีอะฮ์']
OUT = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'nav.json'


def to_text(raw: str) -> str:
    raw = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', raw)
    raw = re.sub(r'(?s)<[^>]+>', ' ', raw)
    return re.sub(r'\s+', ' ', html.unescape(raw).replace(' ', ' '))


def parse(text: str):
    m = re.search(r'มูลค่ากองทุนส่วนสมาชิก.*?วันที่\s*ประกาศใช้\s*(\d{1,2})/(\d{1,2})/(\d{4})', text)
    if not m:
        return None, {}
    d, mo, y = m.groups()
    if int(y) < 2400:
        y = str(int(y) + 543)
    date = f'{y}-{int(mo):02d}-{int(d):02d}'
    seg = text[m.end(): m.end() + 4000]
    cut = seg.find('มูลค่าสินทรัพย์สุทธิ')
    if cut > 0:
        seg = seg[:cut]
    vals = {}
    for p in PLANS:
        pat = r'แผน\s*' + r'\s*'.join(map(re.escape, p.split(' '))) + r'(?![ก-๙])\s*\*?\s*(?:\([^)]*\))?\s*([\d,]+\.\d{2,6})'
        mm = re.search(pat, seg)
        if mm:
            vals[p] = round(float(mm.group(1).replace(',', '')), 4)
    return date, vals


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if src:
        raw = open(src, encoding='utf-8').read()
    else:
        req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (GPF Journal NAV updater)'})
        raw = urllib.request.urlopen(req, timeout=60).read().decode('utf-8', 'replace')
    date, vals = parse(to_text(raw))
    if not date or len(vals) < 8:
        print(f'อ่าน NAV ไม่ได้ (date={date}, plans={len(vals)})')
        sys.exit(0 if src is None else 1)
    data = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {'nav': {}}
    nav = data.setdefault('nav', {})
    if nav.get(date, {}).get('values') == vals:
        print(f'ไม่มีข้อมูลใหม่ ({date})')
        return
    flags = []
    prev = [k for k in sorted(nav) if k < date]
    if prev:
        pv = nav[prev[-1]]['values']
        for p, v in vals.items():
            if p in pv and abs(v / pv[p] - 1) > 0.06:
                flags.append(f'แผน{p} เปลี่ยน {(v / pv[p] - 1) * 100:+.2f}% จาก {prev[-1]}')
        missing = [p for p in pv if p not in vals]
        if missing:
            flags.append('ไม่พบ ' + ', '.join(missing))
    nav[date] = {'values': vals, 'flags': flags, 'fetchedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    data['nav'] = dict(sorted(nav.items()))
    data['updatedAt'] = nav[date]['fetchedAt']
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'บันทึก NAV {date} {len(vals)} แผน' + (f' (ข้อสังเกต: {flags})' if flags else ''))


if __name__ == '__main__':
    main()
