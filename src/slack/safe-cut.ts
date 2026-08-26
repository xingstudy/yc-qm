const FLOOR_FRACTION = 0.25;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function safeCutIndex(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let cut = max;
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  const floor = Math.max(1, Math.floor(max * FLOOR_FRACTION));
  const lastOpen = text.lastIndexOf("<", cut - 1);
  if (lastOpen >= 0) {
    const lastClose = text.lastIndexOf(">", cut - 1);
    if (lastOpen > lastClose && lastOpen >= floor) cut = lastOpen;
  }
  for (const marker of ["`", "*", "~"]) {
    let count = 0;
    for (let i = 0; i < cut; i++) if (text[i] === marker) count++;
    if (count % 2 === 1) {
      const back = text.lastIndexOf(marker, cut - 1);
      if (back >= floor) cut = Math.min(cut, back);
    }
  }
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  return Math.max(cut, 1);
}

export function safeChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const cut = safeCutIndex(rest, max);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks.length ? chunks : [""];
}

export function safeClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCutIndex(text, max))}…`;
}
