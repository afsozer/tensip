#!/usr/bin/env python3
# tensip.svg → tensip.iconset + tensip.icns (yalnız macOS araçları + stdlib).
#
# SVG'yi Quick Look (qlmanage) çizer ama zemini beyazla doldurur. Saydamlığı
# geri almak için SVG bir kez beyaz, bir kez siyah zeminde çizilir; iki
# görüntünün farkı her pikselin alfasını verir (fark matlaması).
import os, re, struct, subprocess, sys, tempfile, zlib

KOK = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(KOK, "tensip.svg")
BOYUT = 1024


def png_oku(yol):
    d = open(yol, "rb").read()
    p, idat = 8, b""
    while p < len(d):
        n, = struct.unpack(">I", d[p:p + 4])
        tip, veri = d[p + 4:p + 8], d[p + 8:p + 8 + n]
        p += 12 + n
        if tip == b"IHDR":
            w, h, derinlik, renk = struct.unpack(">IIBB", veri[:10])
            assert derinlik == 8 and renk in (2, 6), "beklenmeyen PNG biçimi"
        elif tip == b"IDAT":
            idat += veri
    bpp = 4 if renk == 6 else 3
    ham, satir = zlib.decompress(idat), w * bpp
    cikti, onceki = bytearray(), bytearray(satir)
    for y in range(h):
        f = ham[y * (satir + 1)]
        s = bytearray(ham[y * (satir + 1) + 1:(y + 1) * (satir + 1)])
        for i in range(satir):
            a = s[i - bpp] if i >= bpp else 0
            b = onceki[i]
            c = onceki[i - bpp] if i >= bpp else 0
            if f == 1: s[i] = (s[i] + a) & 255
            elif f == 2: s[i] = (s[i] + b) & 255
            elif f == 3: s[i] = (s[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                s[i] = (s[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        cikti += s
        onceki = s
    return w, h, bpp, cikti


def png_yaz(yol, w, h, rgba):
    ham = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def parca(tip, veri):
        return struct.pack(">I", len(veri)) + tip + veri + struct.pack(">I", zlib.crc32(tip + veri) & 0xFFFFFFFF)
    with open(yol, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(parca(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(parca(b"IDAT", zlib.compress(ham, 9)))
        f.write(parca(b"IEND", b""))


def ciz(svg_metni, dizin, ad):
    yol = os.path.join(dizin, ad + ".svg")
    open(yol, "w", encoding="utf-8").write(svg_metni)
    subprocess.run(["qlmanage", "-t", "-s", str(BOYUT), "-o", dizin, yol], check=True, capture_output=True)
    return png_oku(yol + ".png")


def main():
    svg = open(SVG, encoding="utf-8").read()
    acilis = re.search(r"<svg[^>]*>", svg).end()
    siyah = svg[:acilis] + f'<rect width="{BOYUT}" height="{BOYUT}" fill="#000"/>' + svg[acilis:]
    with tempfile.TemporaryDirectory() as tmp:
        w, h, bpp, beyazda = ciz(svg, tmp, "beyaz")
        _, _, bpp2, siyahta = ciz(siyah, tmp, "siyah")
        rgba = bytearray(w * h * 4)
        for i in range(w * h):
            b = beyazda[i * bpp:i * bpp + 3]
            s = siyahta[i * bpp2:i * bpp2 + 3]
            alfa = 255 - round(sum(b[k] - s[k] for k in range(3)) / 3)
            alfa = max(0, min(255, alfa))
            rgba[i * 4 + 3] = alfa
            if alfa:
                for k in range(3):
                    rgba[i * 4 + k] = max(0, min(255, round(s[k] * 255 / alfa)))
        ana = os.path.join(tmp, "tensip-1024.png")
        png_yaz(ana, w, h, rgba)

        iconset = os.path.join(KOK, "tensip.iconset")
        os.makedirs(iconset, exist_ok=True)
        for b in (16, 32, 128, 256, 512):
            for kat, ek in ((1, ""), (2, "@2x")):
                hedef = os.path.join(iconset, f"icon_{b}x{b}{ek}.png")
                subprocess.run(["sips", "-z", str(b * kat), str(b * kat), ana, "--out", hedef],
                               check=True, capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(KOK, "tensip.icns")], check=True)
        if len(sys.argv) > 1:
            subprocess.run(["cp", ana, sys.argv[1]], check=True)
    print("üretildi: tensip.iconset, tensip.icns")


if __name__ == "__main__":
    main()
