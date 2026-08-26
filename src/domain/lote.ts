import { z } from 'zod';
import { brl } from './mensagem.js';
import type { Scored } from './scoring.js';

/**
 * O lote é pro WhatsApp o que o plano é pras fotos.
 *
 * Antes, `deals` e `send` faziam buscas independentes: você aprovava uma lista
 * no `deals` e o `send` saía atrás de outra, porque o `--tema` vira termos
 * novos a cada execução e o feed da Shopee muda no meio. O lote fecha isso —
 * `deals` grava o que te mostrou, `send` manda exatamente aquilo.
 *
 * Guarda id, título e preço. Título e preço são só pra conferência: o que sai
 * pro grupo é sempre o preço da busca de agora, nunca o do arquivo.
 */
const schema = z.object({
  gerado_em: z.string().default(''),
  termos: z.array(z.string()).default([]),
  ofertas: z
    .array(
      z.object({
        id: z.string(),
        titulo: z.string().default(''),
        preco: z.coerce.number().default(0),
      }),
    )
    .default([]),
});

export interface Lote {
  termos: string[];
  ofertas: { id: string; titulo: string; preco: number }[];
}

export function loteToJson(termos: string[], list: Scored[]): string {
  return JSON.stringify(
    {
      gerado_em: new Date().toISOString(),
      termos,
      ofertas: list.map((s) => ({
        id: s.offer.id,
        titulo: s.offer.title,
        preco: s.offer.price,
        desconto: Math.round(s.discount * 100),
      })),
    },
    null,
    2,
  );
}

export function lerLote(raw: string): Lote {
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error('lote inválido: ' + z.prettifyError(parsed.error).slice(0, 160));
  }
  return { termos: parsed.data.termos, ofertas: parsed.data.ofertas.filter((o) => o.id) };
}

/**
 * Casa o lote com as ofertas de agora, na ordem em que foram aprovadas.
 *
 * `subiu` é o que justifica existir: entre o `deals` e o `send` o preço pode ter
 * voltado ao normal, e mandar pro grupo uma "promoção" que já acabou é o jeito
 * mais rápido de perder a confiança de quem está lá.
 */
export function casarLote(
  lote: Lote,
  disponiveis: Scored[],
): { picked: Scored[]; sumiram: number; subiu: { s: Scored; antes: number }[] } {
  const porId = new Map(disponiveis.map((s) => [s.offer.id, s]));
  const picked: Scored[] = [];
  const subiu: { s: Scored; antes: number }[] = [];

  for (const o of lote.ofertas) {
    const s = porId.get(o.id);
    if (!s) continue;
    picked.push(s);
    if (o.preco > 0 && s.offer.price > o.preco * 1.02) subiu.push({ s, antes: o.preco });
  }

  return { picked, sumiram: lote.ofertas.length - picked.length, subiu };
}

/** Linha de aviso pros que ficaram mais caros desde o `deals`. */
export function avisoDeAlta(subiu: { s: Scored; antes: number }[]): string[] {
  return subiu.map(
    ({ s, antes }) =>
      `   ${s.offer.title.slice(0, 46)} — era ${brl(antes)}, agora ${brl(s.offer.price)}`,
  );
}
