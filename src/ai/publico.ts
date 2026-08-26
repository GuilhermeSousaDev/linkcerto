import { z } from 'zod';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import type { Scored } from '../domain/scoring.js';
import { aiEnabled, askJson } from './client.js';

const log = logger.child({ mod: 'publico' });

const foraSchema = z.object({
  fora: z
    .array(z.object({ indice: z.coerce.number().int(), motivo: z.string().default('') }))
    .default([]),
});

/**
 * Quantos títulos vão pro filtro, por ordem de score.
 *
 * O que sobra abaixo disso é DESCARTADO, não devolvido sem examinar: numa lista
 * de 500 ofertas o filtro tirava 41 do topo e a cauda não-examinada subia pra
 * ocupar as vagas, trazendo de volta a peça feminina que ele tinha acabado de
 * remover. 80 é bem mais do que qualquer post usa e cabe numa chamada só.
 */
const TETO_FILTRO = 80;

export interface ForaDoPublico {
  s: Scored;
  motivo: string;
}

/** Gênero do público, quando ele tem um. Só isso é decidível por regra. */
function generoDoPublico(publico: string): 'm' | 'f' | null {
  const p = publico.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const m = /\b(homem|homens|masculin[oa]s?|rapaz|cara)\b/.test(p);
  const f = /\b(mulher|mulheres|feminin[oa]s?|menina|garota)\b/.test(p);
  if (m === f) return null; // os dois ou nenhum: não dá pra decidir por regra
  return m ? 'm' : 'f';
}

const UNISSEX = /\b(unissex|unisex|homens?\s+e\s+mulher|masculino\s+e\s+feminino|feminino\s+e\s+masculino)\b/;
const MARCA = {
  m: /\b(masculin[oa]s?|homem|homens|menino)\b/,
  f: /\b(feminin[oa]s?|mulher|mulheres|menina)\b/,
};

/**
 * Veredito por regra, quando o título é explícito.
 *
 * A IA sozinha errou nos dois sentidos no mesmo teste: deixou passar uma "…para
 * Academia Feminina" e derrubou uma "Calça Legging Masculina" achando que
 * legging é sempre feminino. Quando a palavra está escrita no título não há o
 * que interpretar — a regra decide e a IA não opina.
 *
 * `null` = não é explícito, deixa a IA julgar (cropped, suplex, corte).
 */
function veredito(titulo: string, genero: 'm' | 'f'): 'dentro' | 'fora' | null {
  const t = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (UNISSEX.test(t)) return 'dentro';

  const oposto = genero === 'm' ? 'f' : 'm';
  const temMeu = MARCA[genero].test(t);
  const temOposto = MARCA[oposto].test(t);

  if (temMeu && temOposto) return 'dentro'; // "masculina e feminina" = serve
  if (temMeu) return 'dentro';
  if (temOposto) return 'fora';
  return null;
}

/**
 * Tira da lista o que é claramente de outro público.
 *
 * Termo de busca com gênero ajuda, mas não resolve: a busca da Shopee é frouxa
 * e devolve "Camiseta Dry Fit Feminina" pra quem pediu masculina. O único lugar
 * onde dá pra decidir isso é olhando o título de cada produto, um a um — e é o
 * que esta função faz, em uma chamada só.
 *
 * Conservadora de propósito: na dúvida mantém. Descartar item bom é pior que
 * deixar passar um duvidoso, porque o corte visual e o `--skip` ainda vêm
 * depois. Nunca lança: se a IA falhar, o dia segue sem o filtro.
 */
export async function filtrarPublico(
  list: Scored[],
): Promise<{ dentro: Scored[]; fora: ForaDoPublico[] }> {
  const publico = config.AI_PUBLICO.trim();
  if (!publico || !aiEnabled() || !list.length) return { dentro: list, fora: [] };

  const janela = list.slice(0, TETO_FILTRO);

  const titulos = janela
    .map((s, i) => `[${i}] ${s.offer.title.replace(/\s+/g, ' ').slice(0, 100)}`)
    .join('\n');

  let raw: z.infer<typeof foraSchema>;
  try {
    raw = await askJson(
      foraSchema,
      [
        {
          role: 'system',
          content: `Você separa produtos por público-alvo. Responda SOMENTE com JSON válido.`,
        },
        {
          role: 'user',
          content: `PÚBLICO DO PERFIL: ${publico}

PRODUTOS:
${titulos}

Liste os índices dos produtos que NÃO servem para esse público.

- Peça do gênero errado (legging feminina num perfil masculino) está fora.
- Vale o que a peça É, não só a palavra escrita: legging, cropped, top, costa
  aberta, vestido e saia são femininos mesmo sem a palavra "feminina" no título.
- Item unissex, neutro ou "para homens e mulheres" está DENTRO.
- Faixa etária errada (infantil num perfil adulto) está fora.
- Na dúvida, está DENTRO. Marcar demais é pior que deixar passar um.
- "motivo" em 3 ou 4 palavras.

{"fora": [{"indice": 7, "motivo": "legging feminina"}]}`,
        },
      ],
    );
  } catch (err) {
    // Alto e com o motivo: este filtro degradar calado foi como ele passou
    // despercebido no primeiro teste, entregando legging feminina como se
    // estivesse tudo certo.
    log.warn(
      `filtro de público falhou, seguindo SEM ele — ${(err as Error).message}\n` +
        'Use --sem-filtro pra pular esta chamada de propósito.',
    );
    return { dentro: list, fora: [] };
  }

  const foraIdx = new Map<number, string>();
  for (const f of raw.fora) {
    if (f.indice >= 0 && f.indice < janela.length) foraIdx.set(f.indice, f.motivo.trim());
  }

  // A regra tem a última palavra sobre o que está escrito no título; a IA fica
  // com o que precisa de interpretação.
  const genero = generoDoPublico(publico);
  if (genero) {
    janela.forEach((s, i) => {
      const v = veredito(s.offer.title, genero);
      if (v === 'fora') foraIdx.set(i, genero === 'm' ? 'peça feminina' : 'peça masculina');
      else if (v === 'dentro') foraIdx.delete(i);
    });
  }

  // Só o que passou pela janela sai daqui. Nada que o filtro não olhou entra
  // no post — é isso que torna a garantia real em vez de estatística.
  const dentro = janela.filter((_, i) => !foraIdx.has(i));
  const fora = [...foraIdx].map(([i, motivo]) => ({ s: janela[i]!, motivo }));

  return { dentro, fora };
}
