import type { Scored } from './scoring.js';

/**
 * Texto do WhatsApp.
 *
 * O conteúdo social (capa, etiquetas, legenda, roteiro) não mora mais aqui:
 * quem escreve é a IA, em ai.ts. Aqui ficou só a mensagem do grupo, que é
 * formato fixo de propósito — é transação, não copy.
 */

export const brl = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    v,
  );

// ─── WhatsApp ───────────────────────────────────────────────────────────────

/**
 * O texto acompanha o modo do scoring. Com baseline medido dá pra afirmar queda
 * real; sem baseline estamos repetindo a alegação da loja, e a mensagem diz
 * "anunciado" em vez de fingir que verificamos.
 */
/**
 * Preço "de" — o valor riscado ao lado do atual.
 *
 * Com histórico usa o que NÓS medimos; sem histórico, o que a loja declara.
 * A diferença importa: a âncora da loja costuma ser inflada, e é justamente por
 * isso que o texto rotula a origem em vez de deixar os dois parecerem a mesma
 * coisa.
 */
function anchorPrice(s: Scored): { value: number; medido: boolean } | null {
  if (s.mode === 'history' && s.baseline && s.baseline > s.offer.price) {
    return { value: s.baseline, medido: true };
  }
  const vd = s.offer.vendorDiscount;
  if (vd !== null && vd > 0 && vd < 1) {
    return { value: s.offer.price / (1 - vd), medido: false };
  }
  return null;
}

/** Chamada de abertura. Varia pela característica da oferta, não aleatoriamente. */
function hook(s: Scored): string {
  if (s.isLowest) return 'MENOR PREÇO QUE JÁ MEDIMOS 🔥';

  const a = anchorPrice(s);
  // Só cabe quando temos baseline medido pra contrapor à alegação da loja.
  if (s.mode === 'history' && a?.medido && s.offer.vendorDiscount) {
    const lojaPct = Math.round(s.offer.vendorDiscount * 100);
    const realPct = Math.round(s.discount * 100);
    if (lojaPct > realPct + 10) return `A LOJA DIZ ${lojaPct}%. O REAL É ${realPct}% 👀`;
  }

  if (s.discount >= 0.6) return 'ISSO É UM ABSURDO 🔥';
  if (s.discount >= 0.45) return 'CAIU MUITO 🔥';
  if (s.offer.rating && s.offer.rating >= 4.8) return 'NOTA QUASE PERFEITA ⭐';
  return 'ACHADO DO DIA 🔥';
}

export function formatDeal(s: Scored, link: string): string {
  const o = s.offer;
  const a = anchorPrice(s);
  const lines: string[] = [];

  lines.push(`*${hook(s)}*`);
  lines.push('');
  lines.push(o.title);
  lines.push('');

  // Formato "de/por": é o que o nicho usa e o que faz a oferta parecer oferta.
  if (a) {
    lines.push(`De ~${brl(a.value)}~ por *${brl(o.price)}* 🔥`);
    lines.push(
      a.medido
        ? '📊 _o "de" é o preço real que medimos, não o da loja_'
        : '🏷️ _valor "de" anunciado pela loja_',
    );
  } else {
    lines.push(`💰 *${brl(o.price)}*`);
  }

  if (s.isLowest) lines.push('🏆 *Menor preço desde que começamos a acompanhar*');

  const social: string[] = [];
  if (o.rating) social.push(`⭐ ${o.rating.toFixed(1)}`);
  if (o.sold) social.push(`${o.sold.toLocaleString('pt-BR')} vendidos`);
  if (social.length) lines.push(social.join(' · '));

  lines.push('');
  lines.push(`🛒 ${link}`);
  lines.push('');

  return lines.join('\n');
}
