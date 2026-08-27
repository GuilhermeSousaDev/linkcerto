import { brl } from '../domain/mensagem.js';
import type { Scored } from '../domain/scoring.js';
import type { PostPlan, ForaDoPublico } from '../ai/index.js';
import type { ImageScore } from '../media/imagescore.js';

/** Tudo que o usuário vê no terminal. Nenhum serviço imprime — só daqui. */

export const linha = (s = '') => console.log(s);
export const avisos = (list: string[]) => list.forEach((a) => linha(a));

export function oferta(s: Scored, i: number, foto?: ImageScore): void {
  const pct = Math.round(s.discount * 100);
  const modo = s.mode === 'history' ? '✅ histórico' : '🏷️  anunciado';

  linha(`${String(i + 1).padStart(2)}. [${s.score.toFixed(0).padStart(3)}] ${modo}  -${pct}%  ${brl(s.offer.price)}`);
  linha(`    ${s.offer.title.slice(0, 70)}`);
  if (s.baseline) {
    linha(`    preço normal medido: ${brl(s.baseline)}${s.isLowest ? '  🏆 menor já visto' : ''}`);
  }
  linha(
    `    ⭐ ${s.offer.rating ?? '-'} · ${s.offer.sold ?? 0} vendidos · comissão ${((s.offer.commissionRate ?? 0) * 100).toFixed(0)}%`,
  );
  if (foto) linha(`    foto: ${foto.score}  (branco ${foto.whiteRatio} · entropia ${foto.entropy})`);
  linha();
}

export function foraDoPublico(fora: ForaDoPublico[], publico: string): void {
  if (!fora.length) return;
  linha(`\n🚫 ${fora.length} fora do público (${publico}):`);
  for (const f of fora.slice(0, 8)) linha(`   ${f.s.offer.title.slice(0, 52)} — ${f.motivo}`);
  if (fora.length > 8) linha(`   … e mais ${fora.length - 8}`);
}

/** O plano na ordem em que ele é usado na hora de postar. */
export function plano(p: PostPlan): void {
  if (p.tema) linha(`\n🎨 TEMA\n   ${p.tema}`);
  linha(`\n🎬 ÂNGULO\n   ${p.angulo}\n`);

  linha(`🖼️  CAPA\n   ${p.capa.titulo}`);
  if (p.capa.subtitulo) linha(`   ${p.capa.subtitulo}`);
  // Sem rosto a capa cai na foto do produto desfocada. Dizer qual é o caso
  // aqui evita a pergunta "por que a capa saiu diferente da de ontem?".
  linha(
    p.capa.casting
      ? `   retrato: ${p.capa.casting}`
      : '   retrato: nenhum — capa na foto do produto (npm run capas)',
  );
  if (p.capa.variantes.length) {
    linha('   outras opções de capa:');
    p.capa.variantes.forEach((v) => linha(`     • ${v}`));
  }

  linha('\n📸 SLIDES (nesta ordem)');
  p.itens.forEach((it, i) => {
    linha(`   ${String(i + 1).padStart(2)}. ${it.etiqueta || '— (sem frase)'}`);
    linha(`       ${brl(it.s.offer.price)} · ${it.s.offer.title.slice(0, 52)}`);
    if (it.fala) linha(`       🗣️  ${it.fala}`);
  });

  // Card sem etiqueta ainda renderiza (foto, preço, nome, prova social), só
  // perde a faixa amarela. Vale avisar: ou a IA pulou o produto, ou a etiqueta
  // dela citava um preço que não era o daquele item e foi descartada.
  const semFrase = p.itens.filter((it) => !it.etiqueta).length;
  if (semFrase) {
    linha(
      `\n⚠️  ${semFrase} de ${p.itens.length} slides sem frase — o card sai sem a faixa\n` +
        '   amarela. Rode de novo se quiser todos com ela.',
    );
  }

  linha(`\n🎯 SLIDE FINAL\n   ${p.cta.headline}\n   ${p.cta.linha1}\n   ${p.cta.linha2}`);
  if (p.roteiro.gancho) linha(`\n🗣️  FALA DOS 3 PRIMEIROS SEGUNDOS\n   "${p.roteiro.gancho}"`);

  linha(`\n📝 LEGENDA\n${p.legenda.split('\n').map((x) => `   ${x}`).join('\n')}`);
  linha(`\n📌 COMENTÁRIO FIXADO\n   ${p.comentarioFixado}`);
  linha(`\n💬 RESPOSTA PRO "qual o link?"\n   ${p.respostaPadrao}`);
  if (p.bio) linha(`\n👤 SUGESTÃO DE BIO\n   ${p.bio}`);
  linha();
}

export function proximoPasso(linhas: [string, string][]): void {
  const larg = Math.max(...linhas.map(([cmd]) => cmd.length));
  for (const [cmd, nota] of linhas) linha(`  ${cmd.padEnd(larg)}  ${nota}`);
  linha();
}
