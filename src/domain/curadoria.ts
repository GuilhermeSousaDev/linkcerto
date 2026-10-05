import { config } from '../infra/config.js';
import type { Scored } from './scoring.js';

/**
 * Monta o lote do grupo: ATÉ `max` ofertas, nunca "exatamente `max`".
 *
 * Duas regras, nessa ordem:
 *
 * 1. Corte de qualidade (`MIN_SCORE`). O que não alcança fica de fora mesmo que
 *    o lote saia com 4. Os filtros nunca afrouxam pra completar o TOP_N — 5
 *    ofertas boas valem mais que 15 medianas, e o grupo lembra das medianas.
 *
 * 2. Diversidade, como critério SECUNDÁRIO. Cada produto da mesma família que
 *    já entrou multiplica o score do próximo por `DIVERSITY_DECAY` (0,85 → a 2ª
 *    camiseta vale 85%, a 3ª 72%…). Não é cota por categoria: uma oferta
 *    excelente ainda passa uma mediana de uma família "faltante".
 */

/** Palavras que abrem título mas não dizem o que o produto é. */
const NAO_E_FAMILIA = new Set([
  'kit', 'novo', 'nova', 'original', 'premium', 'promocao', 'oferta', 'lancamento',
  'combo', 'conjunto', 'par', 'jogo', 'unidade', 'unidades', 'pecas', 'peca',
  'masculino', 'masculina', 'feminino', 'feminina', 'unissex', 'super', 'mega',
  'top', 'luxo', 'importado', 'importada', 'com', 'para', 'pra', 'de', 'do', 'da',
]);

/**
 * A família do produto, lida do título: o primeiro substantivo que conta.
 *
 * "Kit 3 Camisetas Masculinas Dry Fit" → "camiseta"; "Fone de Ouvido
 * Bluetooth" → "fone". Grosseiro de propósito: serve pra perceber 8 camisetas
 * num lote de 10, não pra classificar o catálogo da Shopee.
 */
export function familia(titulo: string): string {
  const palavras = titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((p) => p.length >= 3 && !NAO_E_FAMILIA.has(p));
  const p = palavras[0] ?? '';
  // Plural simples: "camisetas" e "camiseta" são a mesma família.
  return p.length > 4 && p.endsWith('s') ? p.slice(0, -1) : p;
}

export interface Curadoria {
  escolhidas: Scored[];
  /** Passaram nos filtros, mas o score ficou abaixo do MIN_SCORE. */
  abaixoDoCorte: Scored[];
  /** Multiplicador de diversidade aplicado a cada escolhida (1 = nenhum). */
  diversidade: Map<Scored, number>;
}

export function curar(list: Scored[], max: number): Curadoria {
  const abaixoDoCorte = list.filter((s) => s.score < config.MIN_SCORE);
  const restantes = list.filter((s) => s.score >= config.MIN_SCORE);
  const escolhidas: Scored[] = [];
  const diversidade = new Map<Scored, number>();
  const porFamilia = new Map<string, number>();

  // Guloso: a cada vaga, quem tem o maior score já descontada a repetição.
  while (escolhidas.length < max && restantes.length) {
    let melhor = 0;
    let melhorFator = 1;
    let melhorEfetivo = -1;
    restantes.forEach((s, i) => {
      const fator = config.DIVERSITY_DECAY ** (porFamilia.get(familia(s.offer.title)) ?? 0);
      if (s.score * fator > melhorEfetivo) {
        melhorEfetivo = s.score * fator;
        melhor = i;
        melhorFator = fator;
      }
    });

    const [s] = restantes.splice(melhor, 1);
    escolhidas.push(s!);
    diversidade.set(s!, melhorFator);
    const f = familia(s!.offer.title);
    porFamilia.set(f, (porFamilia.get(f) ?? 0) + 1);
  }

  return { escolhidas, abaixoDoCorte, diversidade };
}
