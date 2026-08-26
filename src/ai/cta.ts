import { config } from '../infra/config.js';
import { clip } from '../util/texto.js';
import { LIMITS } from './limites.js';

/**
 * O convite pro grupo é sempre o mesmo — por isso não é a IA que escreve.
 *
 * Os três campos (`comentario_fixado`, `resposta_padrao`, `bio`) voltavam
 * vazios do modelo em toda rodada. O schema tem `.default('')`, então passava
 * calado e o post ia pro ar sem nenhum caminho pro WhatsApp: o funil terminava
 * no vídeo. Aqui o convite é montado do .env e o texto da IA entra só como
 * abertura, quando vem.
 *
 * A palavra existe porque link de convite direto não funciona no TikTok: na
 * legenda ele não é clicável e ainda cheira a spam, e a bio só aceita link
 * clicável em conta Business. Comentário vira alcance e o convite vai no
 * direct, que é o caminho que sobra.
 */

/** A palavra que a pessoa comenta pra receber o convite. Vazia = link na bio. */
function palavra(): string {
  return config.GRUPO_PALAVRA.trim().toUpperCase();
}

/**
 * Junta a abertura da IA com o convite, sem nunca cortar o convite.
 *
 * O `clip` sozinho cortaria pelo fim, que é justamente onde está o CTA. Aqui o
 * convite reserva o espaço dele primeiro e a abertura entra só se couber
 * inteira: cortada, ela emenda no convite no meio da frase ("...antes de
 * montar essa Comenta LINK"), e frase quebrada custa mais que a abertura vale.
 */
function juntar(abertura: string, convite: string, max: number, sep = ' '): string {
  const a = clip(abertura, max);
  if (!a) return convite;
  // Já veio com o CTA dentro (plano reaproveitado, ou a IA acertou sozinha).
  if (palavra() && a.toUpperCase().includes(palavra())) return a;

  return a.length <= max - convite.length - sep.length ? `${a}${sep}${convite}` : convite;
}

/** Primeiro comentário, fixado logo depois de postar. */
export function comentarioFixado(daIa: string): string {
  const p = palavra();
  const convite = p
    ? `Comenta "${p}" que eu mando o grupo no seu direct 👇`
    : `Grupo com todos os links no ${config.CTA_TEXT.toLowerCase()} 👇`;
  return juntar(daIa, convite, LIMITS.comentario);
}

/** Resposta pros "qual o link?" — cada uma é mais um comentário no post. */
export function respostaPadrao(daIa: string): string {
  const p = palavra();
  const convite = p
    ? `Comenta "${p}" aqui que eu te mando o convite do grupo no direct 🤝`
    : `Tá tudo no grupo — ${config.CTA_TEXT.toLowerCase()} 🤝`;
  return juntar(daIa, convite, LIMITS.resposta);
}

/**
 * Bio do perfil. Cabe pouco: 80 caracteres no TikTok, contando o convite.
 */
export function bio(daIa: string): string {
  const p = palavra();
  const convite = p ? `comenta ${p} p/ entrar no grupo` : config.CTA_TEXT.toLowerCase();
  // Separador em vez de espaço: a bio da IA não vem pontuada, e "achadinho da
  // Shopee comenta LINK" vira uma frase só.
  return juntar(daIa, convite, LIMITS.bio, ' • ');
}
