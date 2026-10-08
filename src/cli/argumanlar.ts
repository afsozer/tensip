// Argüman ayrıştırma — saf modül (I/O yok).

export interface Argumanlar {
  konum: string[];
  bayrak: Record<string, string | boolean>;
}

export function argAyristir(argv: string[]): Argumanlar {
  const konum: string[] = [];
  const bayrak: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      konum.push(a);
      continue;
    }
    // --ad=değer biçimi
    const esit = a.indexOf("=");
    if (esit > 2) {
      const ad = a.slice(2, esit);
      bayrak[ad] = a.slice(esit + 1);
      continue;
    }
    const ad = a.slice(2);
    const sonraki = argv[i + 1];
    if (sonraki !== undefined && !sonraki.startsWith("--")) {
      bayrak[ad] = sonraki;
      i++;
    } else {
      bayrak[ad] = true;
    }
  }
  return { konum, bayrak };
}
