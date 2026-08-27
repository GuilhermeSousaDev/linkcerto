import { writeFileSync } from 'node:fs';
import { config } from '../infra/config.js';
import { markPosted } from '../infra/db.js';
import type { Scored } from '../domain/scoring.js';
import { loadPlan, planResumo, planToJson, postPlan, type PostPlan } from '../ai/index.js';
import { scoreMany, type ImageScore } from '../media/imagescore.js';
import { makePhotos, type PhotoOut } from '../media/cards.js';
import { pastaDoDia, type Salvo } from '../util/arquivo.js';

/** O post: plano da IA, escolha das fotos e geração dos cards. */

export interface PlanoSalvo {
  /** id do produto → posição no post. */
  ordem: Map<string, number>;
  /** Os termos que trouxeram esses produtos. */
  termos: string[];
  /** Se este plano foi feito pra sair em grade de catálogo. */
  grade: boolean;
}

/**
 * Lê um plano salvo. `null` quando não dá pra reaproveitar — aí o chamador
 * gera um novo em vez de falhar.
 */
export function lerPlanoSalvo(salvo: Salvo): { plano: PlanoSalvo | null; aviso?: string } {
  try {
    const { ids, termos, grade } = planResumo(salvo.raw);
    if (!ids.length) {
      return { plano: null, aviso: `⚠️  ${salvo.file} não tem os ids dos produtos (plano antigo).` };
    }
    return { plano: { ordem: new Map(ids.map((id, i) => [id, i])), termos, grade } };
  } catch (err) {
    return { plano: null, aviso: `⚠️  Não consegui ler ${salvo.file} (${(err as Error).message}).` };
  }
}

export interface EscolhaVisual {
  picked: Scored[];
  notas: Map<Scored, ImageScore>;
  /** Quantos entraram na avaliação — com plano, quantos dele foram achados. */
  encontrados: number;
  /** Reprovados no corte visual. */
  descartadas: number;
}

/**
 * Escolhe os produtos do post pela qualidade da foto.
 *
 * Muito "produto" da Shopee é recorte de catálogo em fundo branco, que dá cara
 * de marketplace no vídeo. Com plano, avalia exatamente o que ele pede; sem
 * plano, avalia um pool maior que o necessário pra ter de onde escolher.
 */
export async function escolherPelaFoto(
  pool: Scored[],
  opts: { topN: number; minImagem: number; ordenarPorFoto: boolean; ordem?: Map<string, number> },
): Promise<EscolhaVisual> {
  const candidatos = opts.ordem
    ? pool.filter((s) => opts.ordem!.has(s.offer.id))
    : pool.slice(0, Math.max(opts.topN * 3, opts.topN + 10));

  const notas = await scoreMany(candidatos, (s) => s.offer.imageUrl);
  const aprovadas = candidatos
    .map((s) => ({ s, img: notas.get(s) }))
    .filter((x) => x.img && x.img.score >= opts.minImagem);

  if (opts.ordenarPorFoto) aprovadas.sort((a, b) => b.img!.score - a.img!.score);

  // Com plano quem manda na ordem é ele, e o `--top` não se aplica: o conjunto
  // de produtos já foi decidido lá.
  const picked = opts.ordem
    ? aprovadas.sort((a, b) => opts.ordem!.get(a.s.offer.id)! - opts.ordem!.get(b.s.offer.id)!).map((x) => x.s)
    : aprovadas.slice(0, opts.topN).map((x) => x.s);

  return {
    picked,
    notas,
    encontrados: candidatos.length,
    descartadas: candidatos.length - aprovadas.length,
  };
}

/**
 * O plano do post: reaproveitado do `ideia` quando existe, gerado na hora
 * quando não. Os textos vêm do arquivo, mas preço e foto vêm da busca de agora
 * — plano de ontem não imprime preço de ontem num card de hoje.
 */
export async function planoDoPost(
  produtos: Scored[],
  opts: {
    termos: string[];
    tema?: string;
    salvo?: Salvo | null;
    reaproveitar: boolean;
    /** Post de catálogo em grade. Ignorado ao reaproveitar: o plano já sabe. */
    grade?: boolean;
  },
): Promise<PostPlan> {
  if (opts.salvo && opts.reaproveitar) {
    const salvo = loadPlan(opts.salvo.raw, produtos);
    // O `--grade` na linha de comando ganha do arquivo: permite renderizar em
    // grade um plano que nasceu de cards, sem gerar copy nova.
    return opts.grade ? { ...salvo, grade: true } : salvo;
  }
  return postPlan(produtos, opts.termos, opts.tema, opts.grade ?? false);
}

export interface PostGerado {
  dir: string;
  cards: PhotoOut[];
}

/** Renderiza os cards e marca os produtos como usados. */
export async function gerarPost(plan: PostPlan): Promise<PostGerado> {
  const dir = pastaDoDia('data/photos');
  const cards = await makePhotos(plan, dir);

  writeFileSync(`${dir}/00-PLANO.json`, planToJson(plan), 'utf8');

  // Marcado ao gerar, não ao postar: é aqui que sabemos quais produtos viraram
  // card. Gerou e desistiu? `--repetir` ignora a marca.
  await markPosted(plan.itens.map((it) => it.s.offer.id));

  return { dir, cards };
}

export const corteVisualPadrao = () => config.MIN_IMAGE_SCORE;
