import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../infra/config.js';
import { markSent, ultimoEnvio } from '../infra/db.js';
import { affiliateLink } from '../infra/shopee.js';
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

/** Tira o que já foi enviado e não ficou mais barato desde então. */
export async function naoRepetidas(list: Scored[]): Promise<Scored[]> {
  const enviados = await ultimoEnvio(list.map((s) => s.offer.id));
  return list.filter((s) => {
    const antes = enviados.get(s.offer.id);
    return antes === undefined || s.offer.price <= antes * (1 - config.RESEND_DROP);
  });
}

export async function montarMensagens(list: Scored[]): Promise<Outbound[]> {
  const messages: Outbound[] = [];
  for (const s of list) {
    const link = await affiliateLink(s.offer);
    messages.push({ text: formatDeal(s, link), imageUrl: s.offer.imageUrl });
  }
  return messages;
}

/** Envia e marca cada oferta assim que ela sai, não no fim do lote. */
export async function enviar(jid: string, list: Scored[]): Promise<number> {
  const messages = await montarMensagens(list);
  const wa = new WhatsApp();
  try {
    await wa.connect();
    return await wa.sendMany(jid, messages, async (i) => {
      const s = list[i];
      if (s) await markSent(s.offer.id, s.offer.price);
    });
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
  opts: { asImage: boolean; legenda?: string },
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
    if (opts.legenda) await wa.send(jid, { text: opts.legenda });
  } finally {
    await wa.close();
  }
}

/** Só a parte de cima do 00-LEGENDA.txt — abaixo da linha dupla é referência. */
export function legendaDaPasta(dir: string): string | null {
  const file = join(dir, '00-LEGENDA.txt');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('═'.repeat(60))[0]?.trim() || null;
}
