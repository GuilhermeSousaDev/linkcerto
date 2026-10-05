import type { DealType, Scored } from './scoring.js';
import { rotuloProduto, tituloHonesto } from './produto.js';

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
 * O cabeçalho É a classificação da curadoria. Cada tipo só afirma o que dá pra
 * provar: OFERTA tem queda medida, MENOR PREÇO tem o nosso histórico, ACHADO
 * tem só a prova social — e por isso nunca aparece com "de/por".
 *
 * Sem urgência inventada: nada de "últimas unidades", "só hoje", "corre" ou
 * "imperdível". Não temos dado que sustente nenhum deles.
 */
const CABECALHO: Record<DealType, string> = {
  oferta: '🔥 OFERTA APROVADA',
  menor_preco: '🏆 MENOR PREÇO',
  achado: '⭐ ACHADO',
};

/** "4,8 · 2.400 vendidos" — a prova de qualidade, igual em todo tipo. */
function provaSocial(s: Scored): string | null {
  const o = s.offer;
  const partes: string[] = [];
  if (o.rating) partes.push(`⭐ ${o.rating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
  if (o.sold) partes.push(`${o.sold.toLocaleString('pt-BR')} vendidos`);
  return partes.length ? partes.join(' · ') : null;
}

/**
 * O preço, sempre honesto sobre variações: com faixa relevante o número é o
 * da variação mais barata, e a mensagem diz "a partir de".
 */
function linhaDePreco(s: Scored): string {
  const o = s.offer;
  const atual = o.priceMax !== null ? `a partir de *${brl(o.price)}*` : `*${brl(o.price)}*`;
  // "De/por" só com baseline medido. A âncora da loja não entra: ela é a
  // primeira coisa que o vendedor infla.
  if (s.dealType === 'oferta' && s.baseline && s.baseline > o.price) {
    return `De ~${brl(s.baseline)}~ por ${atual}`;
  }
  return `💰 ${atual.charAt(0).toUpperCase()}${atual.slice(1)}`;
}

export function formatDeal(s: Scored, link: string): string {
  const o = s.offer;
  const tipo = s.dealType ?? 'achado';
  const lines: string[] = [];

  lines.push(`*${CABECALHO[tipo]}*`);
  lines.push('');
  lines.push(tituloHonesto(o.title, s.produto));
  // O que a pessoa recebe, antes do preço: barato e explicado passa confiança,
  // barato e calado parece golpe.
  const rotulo = rotuloProduto(s.produto);
  if (rotulo) lines.push(`_${rotulo}_`);
  lines.push('');

  lines.push(linhaDePreco(s));
  lines.push('');

  // A explicação: por que isso passou na curadoria.
  if (tipo === 'oferta' && s.realDiscount !== null) {
    lines.push(`📉 ${Math.round(s.realDiscount * 100)}% abaixo do preço que acompanhamos`);
    // A loja anuncia muito mais do que medimos: dizer isso é o diferencial,
    // e evita que a pessoa ache que a gente "errou" o desconto.
    const vd = o.vendorDiscount;
    if (vd !== null && Math.round(vd * 100) > Math.round(s.realDiscount * 100) + 10) {
      lines.push(`🏷️ _a loja anuncia ${Math.round(vd * 100)}% — o real é o de cima_`);
    }
  }
  if (s.isLowest) lines.push('🏆 Menor preço que já acompanhamos');
  if (s.reenvioDe !== undefined) {
    lines.push(`🔻 Caiu de novo: da última vez mandamos por ${brl(s.reenvioDe)}`);
  }

  const social = provaSocial(s);
  if (social) lines.push(social);
  if (tipo === 'achado') lines.push('🔥 Produto muito bem avaliado');

  lines.push('');
  lines.push(`🛒 ${link}`);
  lines.push('');

  return lines.join('\n');
}
