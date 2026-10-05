/**
 * Produto de criança não vai pro grupo. Nunca.
 *
 * Regra fixa, não preferência de público: o filtro da IA (`ai/publico.ts`) já
 * tirava "infantil num perfil adulto", mas ele é pulável (`--sem-filtro`), some
 * quando a IA está fora do ar e só olha os 80 primeiros. Aqui é regex no título,
 * dentro do scoring — nenhum caminho (busca, `--db`, lote salvo, `send`) escapa.
 *
 * Fica de fora o que bate palavra mas não é de criança: "baby look" é corte de
 * camiseta adulta, "fralda geriátrica" é adulto. "boy"/"girl" nem entram —
 * "Bad Boy" e "Good Girl" são perfumes.
 */
const INFANTIL = new RegExp(
  [
    'infant(il|is)',
    'criancas?',
    'bebes?',
    'baby(?!\\s*look)',
    'kids?',
    'menin[oa]s?',
    'juvenil|juvenis',
    'mirim',
    'recem[- ]nascid[oa]s?',
    'maternal',
    'mamadeiras?',
    'chupetas?',
    'fraldas?(?!\\s*geriatric)',
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
);

export function ehInfantil(titulo: string): boolean {
  const t = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return INFANTIL.test(t);
}
