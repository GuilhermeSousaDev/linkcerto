import { config } from '../infra/config.js';
import {
  jaConhecidos,
  ofertasDoBanco,
  ofertasPorIds,
  postedSince,
  guardarOfferLink,
  quantasNoBanco,
  record,
} from '../infra/db.js';
import { affiliateLink, fetchByIds, fetchOffers } from '../infra/shopee.js';
import { findNiche, keywords } from '../domain/niches.js';
import { rank, type Scored } from '../domain/scoring.js';
import { aiEnabled, filtrarPublico, searchTerms, type ForaDoPublico } from '../ai/index.js';

/**
 * Escolha das ofertas: o que buscar, o que sobreviveu e o que foi descartado.
 *
 * Nada aqui imprime. Os serviços devolvem `avisos` e quem decide como mostrar é
 * o cli — é o que permite testar essa camada sem capturar console.
 */

export interface PedidoDeBusca {
  /** `--keywords`: os termos na mão, ganham de todo o resto. */
  manual?: string;
  /** `--tema`: vira busca se for categoria; se for ângulo, não mexe. */
  tema?: string;
  /** Só pra montar a mensagem de erro com o comando que a pessoa digitou. */
  comando: string;
}

export interface Termos {
  termos: string[];
  avisos: string[];
}

/**
 * O que buscar, do mais explícito pro mais inferido: `--keywords`, `--tema`, o
 * arquivo reaproveitado e por fim `SHOPEE_KEYWORDS`.
 *
 * O `--tema` participar disso conserta um erro de projeto: ele só mudava o
 * texto, então "--tema academia" saía com camisa social embaixo de uma capa
 * escrita "treino".
 *
 * O catálogo de nichos continua existindo, mas só como sugestão impressa
 * (`npm run niches`) e como rede pra quando a IA está fora do ar — ele não é
 * mais um jeito de pedir a busca. Escolher entre `--tema` e `--niche` era uma
 * decisão a mais pra chegar no mesmo lugar, já que o `--tema` cobre os dois
 * casos e ainda conhece o público do perfil.
 */
export async function resolverTermos(p: PedidoDeBusca): Promise<Termos> {
  const avisos: string[] = [];
  const base = keywords();

  if (p.manual) return { termos: keywords(p.manual), avisos };

  if (!base.length && !p.tema) {
    throw new Error(
      'Sem termos de busca. Diga o assunto:\n' +
        `  npm run ${p.comando} -- --tema academia\n` +
        `  npm run ${p.comando} -- --keywords "camisa masculina,tenis masculino"\n` +
        'Ou volte a fixar um nicho no SHOPEE_KEYWORDS do .env (npm run niches sugere).',
    );
  }

  if (!p.tema) return { termos: base, avisos };

  // Sem keywords fixas, AI_PUBLICO é a única coisa que diz pra quem o perfil
  // fala — vazio, "academia" volta com legging feminina.
  if (!base.length && !config.AI_PUBLICO) {
    avisos.push(
      '\n⚠️  AI_PUBLICO vazio no .env e sem SHOPEE_KEYWORDS: a IA vai adivinhar\n' +
        '   pra quem você fala. Ex: AI_PUBLICO=homem 20-35 que gasta pouco',
    );
  }

  // A IA ganha do catálogo: o nicho pronto é genérico e não sabe o público do
  // perfil. O catálogo só entra quando ela não pode responder.
  if (!aiEnabled()) {
    const achado = findNiche(p.tema);
    if (achado) {
      avisos.push(`\n📚 IA desligada — tema "${p.tema}" caiu no nicho "${achado.nome}"`);
      return { termos: achado.niche.keywords, avisos };
    }
    return { termos: base, avisos };
  }

  let daIA: string[] = [];
  try {
    daIA = await searchTerms(p.tema, base);
  } catch (err) {
    avisos.push(`⚠️  Não consegui converter o tema em busca (${(err as Error).message}).`);
    const achado = findNiche(p.tema);
    if (achado) return { termos: achado.niche.keywords, avisos };
  }

  if (daIA.length) {
    avisos.push(`\n💡 Tema "${p.tema}" virou busca: ${daIA.join(', ')}`);
    return { termos: daIA, avisos };
  }

  // Ângulo editorial não diz o que buscar. Com nicho fixo é ótimo — só a copy
  // muda. Sem nicho, o feed geral daria um carrossel aleatório com uma capa
  // muito bem escrita em cima.
  if (!base.length) {
    throw new Error(
      `"${p.tema}" é um ângulo, não uma categoria de produto — não dá pra buscar por isso.\n` +
        'Combine com o que buscar:\n' +
        `  npm run ${p.comando} -- --keywords "perfume masculino" --tema ${p.tema}\n` +
        'Ou fixe o nicho no SHOPEE_KEYWORDS do .env (npm run niches sugere).',
    );
  }

  avisos.push(`\n💡 "${p.tema}" é ângulo, não categoria — a busca continua a de sempre.`);
  return { termos: base, avisos };
}

/**
 * Busca na Shopee e pontua.
 *
 * O que NÃO acontece mais aqui: gravar tudo que voltou. Guardar as centenas de
 * ofertas de cada rodada custava 93 mil leituras pra capturar 507 mudanças de
 * preço reais, e 36% dos produtos apareciam uma vez só e nunca mais. Quem grava
 * agora é `registrar()`, com o que foi de fato escolhido.
 *
 * Com `RECORD_KNOWN=true` os produtos que JÁ estão no banco continuam ganhando
 * leitura a cada rodada — é o que mantém o baseline medido crescendo sem deixar
 * produto novo entrar.
 */
export async function buscar(termos: string[]): Promise<Scored[]> {
  const offers = await fetchOffers(termos);

  if (config.RECORD_KNOWN) {
    const conhecidos = await jaConhecidos(offers.map((o) => o.id));
    await record(offers.filter((o) => conhecidos.has(o.id)));
  }

  return rank(offers);
}

/**
 * Vocabulário do tema, pra filtrar títulos no banco.
 *
 * Usa o substantivo que abre cada termo ("camiseta dry fit masculina" →
 * "camiseta"): é o que identifica a categoria. A palavra inteira do termo
 * ("masculina") casaria com meio banco e não diz nada sobre o assunto.
 */
async function vocabulario(tema: string): Promise<string[]> {
  const palavras = new Set<string>();
  for (const p of tema.split(/\s+/)) if (p.length >= 4) palavras.add(p.toLowerCase());

  const doNicho = findNiche(tema);
  const termos = doNicho
    ? doNicho.niche.keywords
    : await searchTerms(tema, []).catch(() => [] as string[]);

  for (const t of termos) {
    const cabeca = t.split(/\s+/)[0];
    if (cabeca && cabeca.length >= 4) palavras.add(cabeca.toLowerCase());
  }
  return [...palavras];
}

/**
 * Ofertas que já estão no banco, sem tocar na Shopee.
 *
 * É o `--db`. Com `tema`, filtra pelo vocabulário dele — sem isso o `--tema`
 * virava enfeite aqui: não mexia na seleção, mas ia pra IA do mesmo jeito, e o
 * post saía com capa de academia em cima de perfume.
 */
export async function buscarNoBanco(
  dias: number,
  tema?: string,
): Promise<{ ofertas: Scored[]; total: number; palavras: string[] }> {
  const palavras = tema ? await vocabulario(tema) : [];
  const total = await quantasNoBanco(dias, palavras);
  const offers = await ofertasDoBanco(dias, 2000, palavras);
  return { ofertas: await rank(offers), total, palavras };
}

/**
 * Os produtos de uma seleção salva (lote do `deals`, plano do `ideia`).
 *
 * Sem busca: quem escolheu já gravou, então reencontrar é uma query por id.
 * O preço é o da última leitura que temos, não uma consulta nova à Shopee.
 */
export async function porIds(ids: string[]): Promise<Scored[]> {
  return rank(await ofertasPorIds(ids));
}

/**
 * Relê na Shopee só os produtos de uma seleção salva.
 *
 * O lote guarda o preço de quando você aprovou. Entre aquele momento e o envio
 * a promoção pode ter acabado, e anunciar no grupo um preço que não existe mais
 * é o jeito mais rápido de perder quem está lá. São 15 chamadas, não uma
 * varredura de 25s.
 *
 * O que a API não devolver cai pro registro do banco, marcado em `semResposta`
 * — é melhor mandar com o preço conhecido e avisar do que sumir com a oferta.
 */
export async function conferirPrecos(
  ids: string[],
): Promise<{ ofertas: Scored[]; semResposta: number }> {
  const frescos = await fetchByIds(ids);
  const porId = new Map(frescos.map((o) => [o.id, o]));

  const doBanco = await ofertasPorIds(ids.filter((id) => !porId.has(id)));
  for (const o of doBanco) porId.set(o.id, o);

  const ofertas = await rank(ids.map((id) => porId.get(id)).filter((o) => o !== undefined));
  return { ofertas, semResposta: doBanco.length };
}

/**
 * Grava o que foi escolhido — e só isso.
 *
 * Chamado depois da seleção, em `deals`, `ideia`, `photos` e `send`. É o que
 * faz o banco guardar histórico dos produtos que você usa, e não de tudo que a
 * Shopee devolveu naquele minuto.
 */
export async function registrar(list: Scored[]): Promise<void> {
  await record(list.map((s) => s.offer));
}

/**
 * Garante link de afiliado em todo produto que vai virar post.
 *
 * O `send` já fazia isso por conta própria (ver `grupo.enviar`), mas o post do
 * TikTok não: ele lia `offerLink ?? url` direto, e como os produtos chegam do
 * banco pelo id, o `offerLink` vinha nulo e o legenda saía com o link cru da
 * Shopee. Post bonito, sem rastreio nenhum — venda feita por ele não pagava
 * comissão. Agora o banco guarda o link (ver `offer.offer_link`), e o que ainda
 * faltar é emitido aqui e gravado, pra não ser emitido de novo amanhã.
 *
 * Falha em emitir não derruba o post: cai no link cru, avisando, que é o
 * comportamento que já existia — só que agora visível.
 */
export async function garantirLinks(list: Scored[]): Promise<number> {
  const faltando = list.filter((s) => !s.offer.offerLink);
  let emitidos = 0;

  for (const s of faltando) {
    const link = await affiliateLink(s.offer);
    if (link === s.offer.url) continue; // a emissão falhou; `affiliateLink` já avisou
    s.offer.offerLink = link;
    await guardarOfferLink(s.offer.id, link);
    emitidos++;
  }

  return emitidos;
}

export const aprovadas = (list: Scored[], comFoto = false): Scored[] =>
  list.filter((s) => !s.rejected && (!comFoto || s.offer.imageUrl));

export interface CorteDePublico {
  dentro: Scored[];
  fora: ForaDoPublico[];
}

/** Descarta o que é de outro público. Ver `ai/publico.ts`. */
export async function porPublico(list: Scored[], ignorar: boolean): Promise<CorteDePublico> {
  if (ignorar) return { dentro: list, fora: [] };
  return filtrarPublico(list);
}

/**
 * Tira o que já virou card nos últimos `dias`.
 *
 * O ranking é estável: sem essa janela o post de hoje sai igual ao de ontem,
 * porque os mesmos campeões seguem no topo por semanas.
 */
export async function semRepetidos(
  list: Scored[],
  dias: number,
  ignorar: boolean,
): Promise<{ dentro: Scored[]; cortados: number }> {
  if (ignorar) return { dentro: list, cortados: 0 };

  const jaPostados = await postedSince(dias);
  const dentro = list.filter((s) => !jaPostados.has(s.offer.id));
  return { dentro, cortados: list.length - dentro.length };
}

export const cooldownPadrao = () => config.POST_COOLDOWN_DAYS;
