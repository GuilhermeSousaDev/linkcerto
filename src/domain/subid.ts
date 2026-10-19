import { config } from '../infra/config.js';
import type { DealType, Scored } from './scoring.js';

/**
 * Os Sub IDs de um link de afiliado — as etiquetas que a Shopee devolve no
 * relatório (Report → Click Report / Conversion Report) pra dizer de onde veio
 * cada clique e cada venda.
 *
 * Uma dimensão por posição, sempre na mesma ordem, pra o relatório agrupar:
 *
 *   sub1  canal        wagrupo · tiktok · waprivado   (configurável no .env)
 *   sub2  tipo         oferta · menorpreco · achado · semtipo
 *   sub3  data         20261005 — o dia em que o link foi emitido
 *
 * Só letras e números: a Shopee recusa "-" e "_" (`invalid sub id`).
 */

export type Canal = 'grupo' | 'tiktok' | 'privado';

const CANAL: Record<Canal, () => string> = {
  grupo: () => config.SHOPEE_SUB_ID,
  tiktok: () => config.SHOPEE_SUB_ID_TIKTOK,
  privado: () => config.SHOPEE_SUB_ID_PRIVADO,
};

const TIPO: Record<DealType, string> = {
  oferta: 'oferta',
  menor_preco: 'menorpreco',
  achado: 'achado',
};

const soAlfanumerico = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');

function dia(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function subIdsDe(canal: Canal, s: Scored, quando = new Date()): string[] {
  return [CANAL[canal](), s.dealType ? TIPO[s.dealType] : 'semtipo', dia(quando)].map(soAlfanumerico);
}

/**
 * O link que vai pro texto: o emitido pro canal; sem ele, o de afiliado da
 * busca. O `productLink` cru só como último recurso — e quem usa isto (post do
 * TikTok) avisa quando cai nele, porque ele não paga comissão.
 */
export const linkDe = (s: Scored): string => s.link?.link ?? s.offer.offerLink ?? s.offer.url;
