import { z } from 'zod';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { brl } from '../domain/mensagem.js';
import type { Scored } from '../domain/scoring.js';
import { clip } from '../util/texto.js';
import { aiEnabled, askJson } from './client.js';
import { LIMITS } from './limites.js';
import { conferirTextosGerais, etiquetaMente } from './precos.js';
import * as cta from './cta.js';

const log = logger.child({ mod: 'plano' });

const schema = z.object({
  angulo: z.string(),
  capa: z.object({
    titulo: z.string(),
    subtitulo: z.string().default(''),
    variantes: z.array(z.string()).default([]),
  }),
  ordem: z.array(z.coerce.number().int()).default([]),
  slides: z
    .array(
      z.object({
        indice: z.coerce.number().int(),
        // O modelo repete o nome do produto junto do índice. Ver `matchIndex`:
        // é o que impede a etiqueta de um item cair na foto de outro.
        produto: z.string().default(''),
        etiqueta: z.string(),
        fala: z.string().default(''),
      }),
    )
    .default([]),
  cta: z.object({
    headline: z.string(),
    linha1: z.string().default(''),
    linha2: z.string().default(''),
  }),
  legenda: z.string(),
  hashtags: z.array(z.string()).default([]),
  roteiro: z.object({ gancho: z.string().default('') }).default({ gancho: '' }),
  comentario_fixado: z.string().default(''),
  resposta_padrao: z.string().default(''),
  bio: z.string().default(''),
});

export interface PostPlan {
  /** O que você pediu em `--tema`, se pediu. Vazio quando a IA escolheu sozinha. */
  tema: string;
  /**
   * Os termos que trouxeram estes produtos da Shopee.
   *
   * Ficam salvos pra que `photos` reaproveite o plano sem você repetir o
   * `--tema`: o plano sabe o que buscar, então não faz sentido perguntar.
   */
  termos: string[];
  /** A tese do post: o que amarra esses produtos num conteúdo só. */
  angulo: string;
  capa: { titulo: string; subtitulo: string; variantes: string[] };
  cta: { headline: string; linha1: string; linha2: string };
  /** Legenda pronta pra colar, hashtags incluídas. */
  legenda: string;
  /** Só a abertura falada. O resto do roteiro mora em cada item, ver `itens`. */
  roteiro: { gancho: string };
  /** Primeiro comentário, fixado. Empurra pro perfil sem parecer anúncio. */
  comentarioFixado: string;
  /** Resposta pronta pros "qual o link?" — cada uma é mais uma visita ao perfil. */
  respostaPadrao: string;
  bio: string;
  /**
   * Produtos na ordem escolhida pela IA. `etiqueta` é o que vai impresso no
   * card; `fala` é o que se diz por cima dele no vídeo.
   */
  itens: { s: Scored; etiqueta: string; fala: string }[];
}

const MENTIRA =
  /(vagas?|vaga)\s*(limitad|restant)|últim[ao]s?\s*(vagas?|unidades?|horas?)|fecha\s*(hoje|amanhã|em breve)|só\s*(hoje|até)\s|encerra\s*(hoje|amanhã)|acaba\s*(hoje|amanhã)/i;

function semMentira(text: string, campo: string): string {
  if (!text || !MENTIRA.test(text)) return text;
  log.warn({ campo, texto: text }, 'IA inventou escassez — descartado');
  return '';
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Qual produto essa etiqueta descreve, de verdade.
 *
 * O modelo erra o índice com frequência — na primeira rodada de teste ele
 * colou "conforto elástico" no relógio e "preço de relógio" na bermuda. Como
 * ele também repete o nome do produto, o nome desempata: se o texto ecoado bate
 * melhor com outro item, o nome ganha do número. Trocar a etiqueta de foto é o
 * tipo de erro que só aparece depois de publicado.
 */
function matchIndex(
  list: Scored[],
  slide: { indice: number; produto: string },
  usados: Set<number>,
): number {
  const livre = (i: number) => i >= 0 && i < list.length && !usados.has(i);

  const tokens = norm(slide.produto)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);

  let best = -1;
  let bestHits = 0;
  if (tokens.length >= 2) {
    list.forEach((s, i) => {
      // Produtos com título quase igual — dois "VETRA Relógio Luxo" de preços
      // diferentes — casariam no mesmo índice, e o segundo sobrescrevia o
      // primeiro: um produto ficava com duas etiquetas e outro com nenhuma.
      if (usados.has(i)) return;
      const hits = tokens.filter((t) => norm(s.offer.title).includes(t)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = i;
      }
    });
  }

  if (bestHits >= 2 && livre(best)) return best;
  if (livre(slide.indice)) return slide.indice;

  // O nome não reconheceu e o índice já foi usado: pega o primeiro que sobrou,
  // em vez de descartar a etiqueta.
  return list.findIndex((_, i) => !usados.has(i));
}

/**
 * O que a IA pode usar. Tudo aqui é medido por nós ou veio da Shopee — e o
 * prompt proíbe qualquer número que não esteja nesta lista.
 */
function briefing(list: Scored[]): string {
  const precos = list.map((s) => s.offer.price);
  const faixa =
    `FAIXA DE PREÇO DA LISTA: R$ ${Math.min(...precos).toFixed(2)} a ` +
    `R$ ${Math.max(...precos).toFixed(2)}. Qualquer "menos de X" que você ` +
    `escrever tem que ser maior que o mais caro.

`;

  return faixa + list
    .map((s, i) => {
      const pct = Math.round(s.discount * 100);
      const campos = [
        `preco ${brl(s.offer.price)}`,
        `desconto ${pct}% (${s.mode === 'history' ? 'medido por nos' : 'anunciado pela loja'})`,
      ];
      if (s.mode === 'history' && s.baseline) campos.push(`preco normal medido ${brl(s.baseline)}`);
      if (s.isLowest) campos.push('MENOR PRECO QUE JA VIMOS');
      if (s.offer.rating) campos.push(`nota ${s.offer.rating.toFixed(1)}`);
      if (s.offer.sold) campos.push(`${s.offer.sold.toLocaleString('pt-BR')} vendidos`);
      return `[${i}] ${s.offer.title.replace(/\s+/g, ' ').slice(0, 90)}\n    ${campos.join(' · ')}`;
    })
    .join('\n');
}

const SYSTEM = `Você é diretor de conteúdo de um perfil brasileiro de achadinhos no TikTok.

O funil é: vídeo → perfil → grupo do WhatsApp. O post NUNCA entrega o link do
produto — o link mora no grupo. O que o post vende é a entrada no grupo. Quem
assiste e sai não serve pra nada; quem toca no perfil serve.

Regras que valem pra cada linha que você escrever:

1. Só existe o que está nos DADOS. Nunca invente preço, marca, material, frete,
   prazo, cupom, "últimas unidades" ou "só hoje".
2. Português do Brasil falado, como quem manda áudio pra um amigo. Proibido:
   "confira", "imperdível", "não perca", "corre lá", "clique agora", "aproveite",
   "queridas", "arrase". Isso tem cara de anúncio e a pessoa desliza.
3. Frase curta. Se dá pra cortar uma palavra, corte.
4. A capa decide o post inteiro. Precisa de lacuna de curiosidade (a pessoa
   PRECISA ver o que vem depois) ou de choque de preço. Nada de "achadinhos da
   Shopee" genérico — isso passou na timeline dela mil vezes hoje.
5. O slide final precisa dar um motivo concreto pra ir no perfil: o que ela
   perde se não entrar no grupo. "Link na bio" sozinho não é motivo.
6. Não prometa o que o grupo não faz. O grupo é grátis, aberto e não tem vaga
   limitada, prazo pra fechar nem cupom exclusivo. Escassez inventada é a
   forma mais rápida de perder quem entrou.

Responda SOMENTE com JSON válido, sem nenhum texto em volta.`;

function userPrompt(list: Scored[], termos: string[], tema?: string): string {
  const publico = config.AI_PUBLICO || 'não informado — deduza pelos produtos';
  const perfil = config.PROFILE_HANDLE || 'não informado';
  const medidos = list.filter((s) => s.mode === 'history').length;

  // O tema é a lente, não um filtro: os produtos já foram escolhidos pelo
  // scoring. O que ele muda é o ângulo, a capa e o roteiro — dois posts com os
  // mesmos produtos e temas diferentes são dois posts diferentes.
  const bloco = tema
    ? `\nTEMA DE HOJE: ${tema}
O ângulo, a capa, as etiquetas e o roteiro têm que sair desse tema. Se algum
produto não conversa direto com ele, encaixe mesmo assim — o tema é a lente
pela qual o post é contado, não uma regra de quais produtos entram.\n`
    : '';

  return `NICHO / termos de busca: ${termos.join(', ') || 'variado'}
PÚBLICO: ${publico}
PERFIL: ${perfil}${bloco}
${
  medidos
    ? `${medidos} destes têm preço normal MEDIDO por nós ao longo do tempo. Esse é o diferencial do perfil: os outros perfis repetem o desconto que a loja declarou.`
    : 'Nenhum tem histórico medido ainda — os descontos são os que a loja anuncia. Não afirme que "medimos" nada.'
}

DADOS (só isso existe):
${briefing(list)}

Devolva este JSON. Os limites de caractere são o espaço real dentro da imagem:
o que passar é CORTADO no meio da frase, então prefira ficar bem abaixo do teto
a escrever uma linha que não cabe.

{
  "angulo": "em uma frase, a tese do post: o que amarra esses produtos",
  "capa": {
    "titulo": "manchete do primeiro slide, no máximo ${LIMITS.titulo} caracteres — mire em 30",
    "subtitulo": "complemento curto, no máximo ${LIMITS.subtitulo} — mire em 24",
    "variantes": ["outra manchete inteira, até ${LIMITS.titulo}", "mais uma, até ${LIMITS.titulo}"]
  },
  "ordem": [índices dos produtos na ordem em que aparecem no post],
  "slides": [
    {
      "indice": 0,
      "produto": "as 3 primeiras palavras do produto [0], pra confirmar de qual você está falando",
      "etiqueta": "frase que vai NO card desse produto, até ${LIMITS.etiqueta} — mire em 30",
      "fala": "o que se diz por cima desse slide no vídeo, uma frase"
    }
  ],
  "cta": {
    "headline": "pergunta do último slide, até ${LIMITS.ctaHeadline}",
    "linha1": "o que tem no grupo, até ${LIMITS.ctaLinha}",
    "linha2": "por que entrar agora, até ${LIMITS.ctaLinha}"
  },
  "legenda": "2 a 3 linhas, terminando numa pergunta que dê vontade de comentar. Sem hashtags e sem link aqui.",
  "hashtags": ["6 a 8 hashtags, misturando grandes e de nicho"],
  "roteiro": { "gancho": "o que você FALA nos 3 primeiros segundos, até ${LIMITS.gancho}" },
  "comentario_fixado": "UMA frase de abertura do comentário fixado, sobre os produtos do post — o convite pro grupo é colado depois, não escreva ele. MÁX 80",
  "resposta_padrao": "UMA frase de abertura pra responder 'qual o link?' — o convite é colado depois. MÁX 100",
  "bio": "o que o perfil entrega, em poucas palavras — sem CTA e sem link, são colados depois. MÁX 40"
}

Sobre "ordem": abra com o produto que segura a pessoa e guarde o mais chocante
pro fim — o final é o que decide se ela vai no perfil. Não é o mesmo que
ordenar por desconto.

Sobre "etiqueta": é a frase que aparece SOBRE a foto, logo acima do preço. Ela
diz por que AQUELE produto merece o slide (uma comparação, o uso, o absurdo do
preço). Nunca repita o nome do produto — ele já está escrito no card abaixo.

Confira antes de responder: cada etiqueta precisa falar do produto do "indice"
que ela cita. Etiqueta de camisa na foto do relógio destrói o post inteiro.
Um slide por produto, sem pular nenhum.`;
}

// ─── Geração ────────────────────────────────────────────────────────────────

/**
 * Ordem devolvida pela IA, saneada: índice fora de faixa ou repetido cai, e o
 * que ela esqueceu entra no fim, na ordem do scoring. Um índice errado não pode
 * custar um produto do post.
 */
function resolveOrder(ordem: number[], total: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of ordem) {
    if (Number.isInteger(i) && i >= 0 && i < total && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  for (let i = 0; i < total; i++) if (!seen.has(i)) out.push(i);
  return out;
}

/** Junta legenda e hashtags, normalizando o '#' que a IA às vezes esquece. */
function withHashtags(legenda: string, tags: string[]): string {
  const clean = tags
    .map((t) => t.trim().replace(/\s+/g, '').replace(/^#*/, '#'))
    .filter((t) => t.length > 2)
    .slice(0, 8);
  return clean.length ? `${legenda.trim()}\n\n${clean.join(' ')}` : legenda.trim();
}

/**
 * Monta o plano do post a partir das ofertas que já passaram pelos filtros.
 * Lança se a IA estiver desligada ou falhar — quem chama decide se cai pra copy
 * fixa ou aborta.
 */
export async function postPlan(
  list: Scored[],
  termos: string[],
  tema?: string,
): Promise<PostPlan> {
  if (!aiEnabled()) throw new Error('REMOTE_AI_API_KEY não está no .env');
  if (!list.length) throw new Error('sem ofertas pra planejar');

  log.info(
    { produtos: list.length, modelo: config.REMOTE_AI_MODEL, tema: tema ?? null },
    'pedindo o plano do post',
  );

  const mensagens = [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: userPrompt(list, termos, tema) },
  ];

  let raw = await askJson(schema, mensagens);

  // Capa e slide final valem pra lista inteira: se prometem "menos de 100" e
  // existe item de R$ 139, o post inteiro nasce mentindo — e isso vai impresso
  // na capa. Uma correção dirigida acerta mais que insistir na mesma pergunta.
  const gerais = () => [
    { campo: 'capa.titulo', texto: raw.capa.titulo },
    { campo: 'capa.subtitulo', texto: raw.capa.subtitulo },
    { campo: 'cta.linha1', texto: raw.cta.linha1 },
    { campo: 'cta.linha2', texto: raw.cta.linha2 },
  ];

  let queixas = conferirTextosGerais(gerais(), list);
  if (queixas.length) {
    log.warn(`preço errado na copy, pedindo correção: ${queixas.map((q) => q.motivo).join(' | ')}`);
    raw = await askJson(schema, [
      ...mensagens,
      {
        role: 'user' as const,
        content:
          'Você errou o preço. Corrija e devolva o JSON inteiro de novo:\n' +
          queixas.map((q) => `- "${q.texto}" (${q.campo}): ${q.motivo}`).join('\n') +
          '\nOu troque a frase por uma que não cite preço nenhum.',
      },
    ]);
    queixas = conferirTextosGerais(gerais(), list);
    if (queixas.length) {
      throw new Error(
        'A IA insistiu num preço que a lista não cumpre:\n' +
          queixas.map((q) => `  "${q.texto}" — ${q.motivo}`).join('\n') +
          '\nRode de novo, ou reduza a faixa com --top.',
      );
    }
  }

  const porProduto = new Map<number, { etiqueta: string; fala: string }>();
  const usados = new Set<number>();

  for (const s of raw.slides) {
    const i = matchIndex(list, s, usados);
    if (i < 0) break; // acabaram os produtos livres
    usados.add(i);

    const produto = list[i];
    let etiqueta = semMentira(clip(s.etiqueta, LIMITS.etiqueta), 'etiqueta');

    // "só 12 reais" numa etiqueta de produto de R$ 109,99 — sem card é melhor
    // que card mentindo, e o card renderiza bem sem a faixa amarela.
    if (produto && etiqueta && etiquetaMente(etiqueta, produto)) {
      log.warn(`etiqueta com preço errado, descartada: "${etiqueta}"`);
      etiqueta = '';
    }

    porProduto.set(i, { etiqueta, fala: s.fala.trim() });
  }

  const ordem = resolveOrder(raw.ordem, list.length);

  return {
    tema: tema ?? '',
    termos,
    angulo: raw.angulo.trim(),
    capa: {
      titulo: clip(raw.capa.titulo, LIMITS.titulo),
      subtitulo: clip(raw.capa.subtitulo, LIMITS.subtitulo),
      variantes: raw.capa.variantes.map((v) => clip(v, LIMITS.titulo)).filter(Boolean),
    },
    cta: {
      headline: clip(raw.cta.headline, LIMITS.ctaHeadline),
      linha1: semMentira(clip(raw.cta.linha1, LIMITS.ctaLinha), 'cta.linha1'),
      linha2: semMentira(clip(raw.cta.linha2, LIMITS.ctaLinha), 'cta.linha2'),
    },
    legenda: withHashtags(raw.legenda, raw.hashtags),
    roteiro: { gancho: clip(raw.roteiro.gancho, LIMITS.gancho) },
    comentarioFixado: cta.comentarioFixado(semMentira(raw.comentario_fixado, 'comentario_fixado')),
    respostaPadrao: cta.respostaPadrao(semMentira(raw.resposta_padrao, 'resposta_padrao')),
    bio: cta.bio(raw.bio),
    itens: ordem.map((i) => ({
      s: list[i]!,
      etiqueta: porProduto.get(i)?.etiqueta ?? '',
      fala: porProduto.get(i)?.fala ?? '',
    })),
  };
}

// ─── Reaproveitar um plano ──────────────────────────────────────────────────

/**
 * Formato do arquivo salvo. Tolerante de propósito: o plano é feito pra você
 * abrir e corrigir uma manchete antes de gerar as fotos, e um campo faltando
 * não pode derrubar o comando.
 */
const savedSchema = z.object({
  tema: z.string().default(''),
  termos: z.array(z.string()).default([]),
  angulo: z.string().default(''),
  capa: z
    .object({
      titulo: z.string().default(''),
      subtitulo: z.string().default(''),
      variantes: z.array(z.string()).default([]),
    })
    .default({ titulo: '', subtitulo: '', variantes: [] }),
  cta: z
    .object({
      headline: z.string().default(''),
      linha1: z.string().default(''),
      linha2: z.string().default(''),
    })
    .default({ headline: '', linha1: '', linha2: '' }),
  legenda: z.string().default(''),
  roteiro: z.object({ gancho: z.string().default('') }).default({ gancho: '' }),
  comentario_fixado: z.string().default(''),
  resposta_padrao: z.string().default(''),
  bio: z.string().default(''),
  slides: z
    .array(
      z.object({
        id: z.string(),
        etiqueta: z.string().default(''),
        fala: z.string().default(''),
      }),
    )
    .default([]),
});

/** O que um plano salvo pede: quais produtos, em que ordem, e de que busca. */
export function planResumo(raw: string): { ids: string[]; termos: string[] } {
  const parsed = savedSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error('plano inválido: ' + z.prettifyError(parsed.error).slice(0, 160));
  }
  return {
    ids: parsed.data.slides.map((s) => s.id).filter(Boolean),
    termos: parsed.data.termos,
  };
}

/**
 * Reconstrói o plano em cima das ofertas de AGORA.
 *
 * Os textos vêm do arquivo, mas preço, desconto e foto vêm da busca desta
 * execução — plano de ontem não pode imprimir o preço de ontem num card de
 * hoje. Produto que sumiu da busca simplesmente não entra, e o chamador avisa.
 */
export function loadPlan(raw: string, disponiveis: Scored[]): PostPlan {
  const p = savedSchema.parse(JSON.parse(raw));
  const porId = new Map(disponiveis.map((s) => [s.offer.id, s]));

  const itens = p.slides
    .map((sl) => {
      const s = porId.get(sl.id);
      return s ? { s, etiqueta: clip(sl.etiqueta, LIMITS.etiqueta), fala: sl.fala.trim() } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    tema: p.tema,
    termos: p.termos,
    angulo: p.angulo,
    capa: {
      titulo: clip(p.capa.titulo, LIMITS.titulo),
      subtitulo: clip(p.capa.subtitulo, LIMITS.subtitulo),
      variantes: p.capa.variantes.map((v) => clip(v, LIMITS.titulo)).filter(Boolean),
    },
    cta: {
      headline: clip(p.cta.headline, LIMITS.ctaHeadline),
      // Vale mesmo em plano editado à mão: escassez inventada não vira imagem.
      linha1: semMentira(clip(p.cta.linha1, LIMITS.ctaLinha), 'cta.linha1'),
      linha2: semMentira(clip(p.cta.linha2, LIMITS.ctaLinha), 'cta.linha2'),
    },
    legenda: p.legenda,
    roteiro: { gancho: p.roteiro.gancho },
    // Passa pelo builder de novo: plano salvo antes do CTA existir sai daqui
    // com o convite, sem precisar gerar tudo outra vez.
    comentarioFixado: cta.comentarioFixado(p.comentario_fixado),
    respostaPadrao: cta.respostaPadrao(p.resposta_padrao),
    bio: cta.bio(p.bio),
    itens,
  };
}

/** Versão serializável do plano — é o que vai pro 00-PLANO.json. */
export function planToJson(plan: PostPlan): string {
  return JSON.stringify(
    {
      gerado_em: new Date().toISOString(),
      modelo: config.REMOTE_AI_MODEL,
      tema: plan.tema,
      termos: plan.termos,
      angulo: plan.angulo,
      capa: plan.capa,
      cta: plan.cta,
      legenda: plan.legenda,
      roteiro: plan.roteiro,
      comentario_fixado: plan.comentarioFixado,
      resposta_padrao: plan.respostaPadrao,
      bio: plan.bio,
      slides: plan.itens.map((it, i) => ({
        posicao: i + 1,
        // O id é o que permite reaproveitar este plano depois: o `photos --ia`
        // reencontra o produto por ele. Sem isso o arquivo é só um relatório.
        id: it.s.offer.id,
        etiqueta: it.etiqueta,
        fala: it.fala,
        produto: it.s.offer.title,
        preco: it.s.offer.price,
        desconto: Math.round(it.s.discount * 100),
        link: it.s.offer.offerLink ?? it.s.offer.url,
      })),
    },
    null,
    2,
  );
}
