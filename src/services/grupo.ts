import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../infra/config.js';
import { markSent, ultimoEnvio } from '../infra/db.js';
import type { LinkAfiliado } from '../infra/shopee.js';
import { garantirLinks, type LinksEmitidos } from './ofertas.js';
import { WhatsApp, type Outbound } from '../infra/whatsapp.js';
import { formatDeal } from '../domain/mensagem.js';
import { casarLote, lerLote, type Lote } from '../domain/lote.js';
import type { Scored } from '../domain/scoring.js';
import type { Salvo } from '../util/arquivo.js';

/** O outro lado do funil: o que vai pro grupo do WhatsApp. */

export function exigirGrupo(): string {
  if (!config.WA_GROUP_JID) {
    throw new Error('WA_GROUP_JID não está no .env — rode "npm run wa:groups"');
  }
  return config.WA_GROUP_JID;
}

export interface SelecaoDoLote {
  picked: Scored[];
  sumiram: number;
  subiu: { s: Scored; antes: number }[];
}

export const lerLoteSalvo = (salvo: Salvo): Lote => lerLote(salvo.raw);

/** Casa o lote aprovado no `deals` com as ofertas de agora. */
export function ofertasDoLote(lote: Lote, disponiveis: Scored[]): SelecaoDoLote {
  return casarLote(lote, disponiveis);
}

/**
 * Tira o que já foi enviado e não ficou mais barato desde então.
 *
 * O que volta por ter caído RESEND_DROP desde o último envio sai marcado em
 * `reenvioDe`, pra mensagem dizer que é uma nova queda — e não parecer que o
 * grupo está repetindo produto.
 */
export async function naoRepetidas(list: Scored[]): Promise<Scored[]> {
  const enviados = await ultimoEnvio(list.map((s) => s.offer.id));
  return list.filter((s) => {
    const antes = enviados.get(s.offer.id);
    if (antes === undefined) return true;
    if (s.offer.price > antes * (1 - config.RESEND_DROP)) return false;
    s.reenvioDe = antes;
    return true;
  });
}

export interface Preparada {
  s: Scored;
  link: LinkAfiliado;
  msg: Outbound;
}

/**
 * As mensagens do grupo, cada uma com o link de afiliado emitido com o Sub ID
 * do grupo. Produto sem link de afiliado NENHUM fica de fora (`semLink`): o
 * `productLink` cru não paga comissão, e antes ele ia pro grupo em silêncio.
 */
export async function montarMensagens(
  list: Scored[],
): Promise<{ prontas: Preparada[]; semLink: Scored[] } & Omit<LinksEmitidos, 'semLink'>> {
  const r = await garantirLinks(list, 'grupo');
  const prontas: Preparada[] = [];
  const semLink: Scored[] = [];
  for (const s of list) {
    if (!s.link) {
      semLink.push(s);
      continue;
    }
    prontas.push({ s, link: s.link, msg: { text: formatDeal(s, s.link.link), imageUrl: s.offer.imageUrl } });
  }
  return { ...r, prontas, semLink };
}

/**
 * Envia e marca cada oferta assim que ela sai, não no fim do lote — com o
 * link exato, os Sub IDs e o texto, pra cruzar depois com o relatório da Shopee.
 */
export async function enviar(jid: string, prontas: Preparada[]): Promise<number> {
  const wa = new WhatsApp();
  try {
    await wa.connect();
    return await wa.sendMany(
      jid,
      prontas.map((p) => p.msg),
      async (i) => {
        const p = prontas[i];
        if (!p) return;
        await markSent(p.s.offer.id, p.s.offer.price, {
          link: p.link.link,
          subIds: p.link.subIds,
          origem: p.link.origem,
          mensagem: p.msg.text,
        });
      },
    );
  } finally {
    await wa.close();
  }
}

// ─── Ponte pro celular ──────────────────────────────────────────────────────

export function exigirGrupoPessoal(): string {
  if (!config.WA_PERSONAL_GROUP_JID) {
    throw new Error(
      'WA_PERSONAL_GROUP_JID não está no .env.\n' +
        'Crie um grupo só seu, rode "npm run wa:groups" e copie o JID pra lá.',
    );
  }
  return config.WA_PERSONAL_GROUP_JID;
}

/** A pasta de cards mais recente. O sufixo "-2" é a 2ª rodada do mesmo dia. */
export function ultimaPastaDeCards(escolhida?: string): string {
  const raiz = 'data/photos';
  const dir =
    escolhida ??
    (existsSync(raiz)
      ? join(
          raiz,
          readdirSync(raiz)
            .filter((d) => /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(d))
            .sort()
            .pop() ?? '',
        )
      : '');

  if (!dir || !existsSync(dir)) {
    throw new Error('Nenhuma pasta de fotos encontrada. Rode "npm run photos" antes.');
  }
  return dir;
}

export const cardsDaPasta = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => join(dir, f));

/**
 * Manda os cards pro seu grupo pessoal, pra baixar no celular e postar no app.
 *
 * A legenda vai por último de propósito: fica no fim da conversa, fácil de
 * copiar sem rolar pra cima.
 */
export async function enviarCards(
  jid: string,
  files: string[],
  opts: { asImage: boolean; legenda?: string | null; comentarioFixado?: string | null },
  aoEnviar: (i: number, file: string) => void,
): Promise<void> {
  const wa = new WhatsApp();
  try {
    await wa.connect();
    for (const [i, f] of files.entries()) {
      await wa.sendFile(jid, f, { asImage: opts.asImage });
      aoEnviar(i, f);
      if (i < files.length - 1) {
        const espera =
          config.WA_MIN_DELAY_MS + Math.random() * (config.WA_MAX_DELAY_MS - config.WA_MIN_DELAY_MS);
        await new Promise((r) => setTimeout(r, espera));
      }
    }

    // Rótulo e texto vão em mensagens SEPARADAS. No celular você copia segurando
    // a mensagem, e ela vem inteira: rótulo junto do texto significa apagar
    // "LEGENDA:" à mão toda vez, dentro do app do TikTok.
    if (opts.legenda) {
      await wa.send(jid, { text: '📝 LEGENDA — copie a próxima mensagem' });
      await wa.send(jid, { text: opts.legenda });
    }
    // Por último porque é o que você usa por último: depois de publicado, é o
    // primeiro comentário do post, que você mesmo fixa.
    if (opts.comentarioFixado) {
      await wa.send(jid, { text: '📌 COMENTÁRIO FIXADO — poste e fixe logo depois' });
      await wa.send(jid, { text: opts.comentarioFixado });
    }
  } finally {
    await wa.close();
  }
}

/** Só a parte de cima do 00-LEGENDA.txt — abaixo da linha dupla é referência. */
function legendaDoTxt(dir: string): string | null {
  const file = join(dir, '00-LEGENDA.txt');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('═'.repeat(60))[0]?.trim() || null;
}

export interface TextosDoPost {
  legenda: string | null;
  comentarioFixado: string | null;
}

/**
 * Os textos que você vai colar no celular.
 *
 * Lidos do 00-PLANO.json, não do .txt: o JSON tem os campos separados, enquanto
 * o .txt é um relatório pra humano ler. Puxar o comentário fixado de lá seria
 * caçar um título entre linhas, e qualquer ajuste no relatório quebraria o
 * envio em silêncio. O .txt fica como reserva só pra legenda, que é a primeira
 * coisa do arquivo e por isso dá pra extrair com segurança.
 */
export function textosDaPasta(dir: string): TextosDoPost {
  const plano = join(dir, '00-PLANO.json');

  if (existsSync(plano)) {
    try {
      const p = JSON.parse(readFileSync(plano, 'utf8')) as {
        legenda?: string;
        comentario_fixado?: string;
      };
      return {
        legenda: p.legenda?.trim() || legendaDoTxt(dir),
        comentarioFixado: p.comentario_fixado?.trim() || null,
      };
    } catch {
      // Plano ilegível não impede o envio: a legenda ainda sai do .txt.
    }
  }

  return { legenda: legendaDoTxt(dir), comentarioFixado: null };
}
