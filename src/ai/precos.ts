import type { Scored } from '../domain/scoring.js';

/**
 * Confere as afirmações de preço da IA contra os produtos de verdade.
 *
 * O prompt já proíbe inventar número, e mesmo assim saiu "Relógios top por
 * menos de 100" numa lista com item de R$ 139,90, e "só 12 reais" numa etiqueta
 * de produto de R$ 109,99. Regra de prompt não é garantia — verificação é.
 */

/** Só considera número que aparece em contexto de preço. "50M à prova" não é. */
const EXATO = /(?:R\$\s*|\bpor\s+(?:só\s+|apenas\s+)?)(\d{1,4}(?:[.,]\d{1,2})?)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:reais|conto)/i;
const TETO = /(?:menos\s+de|abaixo\s+de|até|nao\s+passa\s+de|não\s+passa\s+de)\s*R?\$?\s*(\d{1,4}(?:[.,]\d{1,2})?)/i;

const numero = (t: string | undefined) =>
  t === undefined ? null : Number(t.replace(/\./g, '').replace(',', '.'));

/** O preço que o texto afirma, se afirmar algum. */
export function precoAfirmado(texto: string): number | null {
  const m = EXATO.exec(texto);
  return m ? numero(m[1] ?? m[2]) : null;
}

/** O teto que o texto promete ("menos de 100"), se prometer algum. */
export function tetoAfirmado(texto: string): number | null {
  const m = TETO.exec(texto);
  return m ? numero(m[1]) : null;
}

const perto = (a: number, b: number) => Math.abs(a - b) <= Math.max(b * 0.05, 1);

/**
 * A etiqueta cita um preço que não é o do produto dela?
 *
 * Tolera 5% porque a IA arredonda ("por 33" num produto de R$ 32,94), o que é
 * legítimo. O que não passa é citar o preço de outro produto.
 */
export function etiquetaMente(etiqueta: string, s: Scored): boolean {
  const afirmado = precoAfirmado(etiqueta);
  return afirmado !== null && !perto(afirmado, s.offer.price);
}

export interface QueixaDePreco {
  campo: string;
  texto: string;
  motivo: string;
}

/**
 * Textos que valem pra lista inteira (capa, slide final) prometendo preço que
 * a lista não cumpre. É o erro mais caro: vai impresso na capa, que é o que
 * decide se a pessoa continua vendo.
 */
export function conferirTextosGerais(
  textos: { campo: string; texto: string }[],
  produtos: Scored[],
): QueixaDePreco[] {
  if (!produtos.length) return [];

  const precos = produtos.map((p) => p.offer.price);
  // O teto é o da VARIAÇÃO mais cara, não o do menor preço de cada produto.
  // "Tudo abaixo de 100" com um produto de 67,90 cujas variações chegam a
  // 133,56 é promessa quebrada na hora em que a pessoa escolhe o tamanho — e
  // pelo menor preço a checagem deixava passar.
  const maior = Math.max(...produtos.map((p) => p.offer.priceMax ?? p.offer.price));
  const queixas: QueixaDePreco[] = [];

  for (const { campo, texto } of textos) {
    if (!texto) continue;

    const teto = tetoAfirmado(texto);
    if (teto !== null && maior > teto) {
      queixas.push({
        campo,
        texto,
        motivo: `promete até R$ ${teto} mas o mais caro da lista é R$ ${maior.toFixed(2)}`,
      });
      continue;
    }

    const exato = precoAfirmado(texto);
    if (exato !== null && !precos.some((p) => perto(exato, p))) {
      queixas.push({
        campo,
        texto,
        motivo: `cita R$ ${exato}, que não é o preço de nenhum produto da lista`,
      });
    }
  }

  return queixas;
}
