// HTML → Markdown (UYAP belge HTML'leri için: vekalet pulu, makbuz vb.)
// UYAP HTML'leri mutlak konumlu div'ler kullanır; hedef: düzgün metin
// akışı. Sıfır bağımlılık; küçük tokenizer yaklaşımı.

export interface HtmlSonuc {
  md: string;
  baslik?: string;
}

const VARLIKLAR: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&ccedil;": "ç",
  "&Ccedil;": "Ç",
  "&ouml;": "ö",
  "&Ouml;": "Ö",
  "&uuml;": "ü",
  "&Uuml;": "Ü",
  "&#304;": "İ",
  "&#305;": "ı",
  "&#252;": "ü",
  "&#246;": "ö",
  "&#231;": "ç",
  "&#287;": "ğ",
  "&#351;": "ş",
  "&#350;": "Ş",
  "&#286;": "Ğ",
  "&#214;": "Ö",
  "&#220;": "Ü",
  "&#199;": "Ç",
  "&#8364;": "€",
};

function varlikCoz(metin: string): string {
  let out = metin;
  for (const [k, v] of Object.entries(VARLIKLAR)) out = out.split(k).join(v);
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const num = Number(n);
    if (num > 0 && num < 0x10ffff) return String.fromCodePoint(num);
    return "";
  });
  return out;
}

/** HTML'i blok satırlara ayırıp Markdown'a çevirir. */
export function htmlToMd(html: string): HtmlSonuc {
  let h = html;
  // <style> <script> <head> bloklarını at
  h = h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "");
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<br\s*\/?>/gi, "\n");
  // h etiketleri → Markdown başlık
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, seviye: string, icerik: string) => {
    const n = "#".repeat(Number(seviye));
    return `\n\n${n} ${varlikCoz(icerik.replace(/<[^>]+>/g, "")).trim()}\n\n`;
  });
  // p/div/tr → satır sonu
  h = h.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n");
  h = h.replace(/<(p|div|tr|h[1-6]|li)[^>]*>/gi, "\n");
  // kalan tüm etiketleri at
  h = h.replace(/<[^>]+>/g, " ");
  h = varlikCoz(h);
  // satır bazında temizlik
  const satirlar = h
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  // tekrar eden satırları sıkıştır (UYAP div'leri tekrar edebilir)
  const cikti: string[] = [];
  let son = "";
  for (const s of satirlar) {
    if (s === son) continue;
    cikti.push(s);
    son = s;
  }
  return { md: cikti.join("\n\n") };
}

/** HTML'den başlık (<title> ya da ilk h etiketi) */
export function htmlBaslik(html: string): string | undefined {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) {
    const b = varlikCoz(t[1]!.replace(/<[^>]+>/g, "")).trim();
    if (b) return b;
  }
  const h = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  if (h) return varlikCoz(h[1]!.replace(/<[^>]+>/g, "")).trim() || undefined;
  return undefined;
}
