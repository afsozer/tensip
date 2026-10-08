#!/usr/bin/env python3
# Tensip ikonu — SVG kaynağını üretir (stdlib). PNG/ICNS'e çevirme: uygulama/ikon-derle.sh
# Motif: lacivert zemin üzerinde üst üste iki evrak (dosya), üstteki evrakta
# büyük serifli "T" ve satırlar, sağ altta mühür — "tensip zaptı" fikri.
import math, sys

def muhur_yolu(cx, cy, r, dis=26, derin=9):
    """Kenarı tırtıllı (balmumu mühür) daire yolu."""
    n = 360
    noktalar = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r + derin * (0.5 + 0.5 * math.cos(dis * a))
        noktalar.append(f"{cx + rr * math.cos(a):.1f},{cy + rr * math.sin(a):.1f}")
    return "M" + " L".join(noktalar) + " Z"

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="zemin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2C3D6B"/>
      <stop offset="1" stop-color="#121A33"/>
    </linearGradient>
    <radialGradient id="parilti" cx="0.5" cy="0.0" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="kagit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FBF7EE"/>
      <stop offset="1" stop-color="#EDE3CF"/>
    </linearGradient>
    <linearGradient id="kagitArka" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#D9CDB4"/>
      <stop offset="1" stop-color="#C2B496"/>
    </linearGradient>
    <radialGradient id="mum" cx="0.38" cy="0.32" r="0.8">
      <stop offset="0" stop-color="#C2403A"/>
      <stop offset="0.6" stop-color="#93231F"/>
      <stop offset="1" stop-color="#6A1512"/>
    </radialGradient>
    <filter id="golge" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.35"/>
    </filter>
    <filter id="kartGolge" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#050914" flood-opacity="0.45"/>
    </filter>
    <filter id="muhurGolge" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#2A0606" flood-opacity="0.45"/>
    </filter>
    <clipPath id="kare"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  </defs>

  <g filter="url(#golge)">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#zemin)"/>
  </g>
  <g clip-path="url(#kare)">
    <rect x="100" y="100" width="824" height="824" fill="url(#parilti)"/>

    <!-- arkadaki evrak -->
    <g transform="rotate(7 512 520)" filter="url(#kartGolge)">
      <rect x="282" y="224" width="460" height="590" rx="30" fill="url(#kagitArka)"/>
    </g>

    <!-- öndeki evrak, sağ üst köşesi kıvrık -->
    <g transform="rotate(-3 512 520)" filter="url(#kartGolge)">
      <path d="M300 228 H652 L736 312 V790 Q736 820 706 820 H300 Q270 820 270 790 V258 Q270 228 300 228 Z" fill="url(#kagit)"/>
      <path d="M652 228 V284 Q652 312 680 312 H736 Z" fill="#D8CCB2"/>

      <!-- T -->
      <text x="500" y="560" text-anchor="middle"
            font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="330"
            fill="#1E2B52">T</text>

      <!-- satırlar -->
      <rect x="334" y="608" width="332" height="18" rx="9" fill="#CFC3A9"/>
      <rect x="334" y="650" width="268" height="18" rx="9" fill="#CFC3A9"/>
      <rect x="334" y="692" width="196" height="18" rx="9" fill="#CFC3A9"/>
    </g>

    <!-- mühür -->
    <g filter="url(#muhurGolge)">
      <path d="{muhur_yolu(676, 724, 86)}" fill="url(#mum)"/>
      <circle cx="676" cy="724" r="62" fill="none" stroke="#F3C9B8" stroke-opacity="0.35" stroke-width="5"/>
      <text x="676" y="760" text-anchor="middle"
            font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="104"
            fill="#F6D9CC" fill-opacity="0.85">§</text>
    </g>
  </g>
</svg>
"""

hedef = sys.argv[1] if len(sys.argv) > 1 else "tensip.svg"
with open(hedef, "w", encoding="utf-8") as f:
    f.write(SVG)
print(f"üretildi: {hedef}")
