// Dosyalar ekranının yerel sonuç işlemleri. Portal yanıtına veya DOM'a bağlı değil.
export function turkceKucult(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function portalDurum(value) {
  const durum = turkceKucult(value).trim();
  if (/^acık(?:\s*\(|$)/.test(durum)) return "acik";
  if (/^kapalı(?:\s*\(|$)/.test(durum)) return "kapali";
  return "bilinmeyen";
}

export function portalSonuclari(
  cases,
  { search = "", status = "tumu", sort = "mahkeme", direction = "asc" } = {},
) {
  const needle = turkceKucult(search).trim();
  const filtered = (cases || []).filter((item) => {
    const durum = portalDurum(item.dosyaDurum);
    if (status !== "tumu" && durum !== status) return false;
    if (!needle) return true;
    return [item.birimAdi, item.esasNo, item.dosyaTur].some((value) =>
      turkceKucult(value).includes(needle),
    );
  });
  const fields = {
    mahkeme: "birimAdi",
    esas: "esasNo",
    tur: "dosyaTur",
    durum: "dosyaDurum",
  };
  const key = fields[sort] || fields.mahkeme;
  return filtered
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const result = turkceKucult(a.item[key]).localeCompare(
        turkceKucult(b.item[key]),
        "tr-TR",
        { numeric: true, sensitivity: "base" },
      );
      return (direction === "desc" ? -result : result) || a.index - b.index;
    })
    .map(({ item }) => item);
}

export function portalSayfa(items, page, pageSize = 50) {
  const size = Math.max(1, Number(pageSize) || 50);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    totalPages,
  };
}
