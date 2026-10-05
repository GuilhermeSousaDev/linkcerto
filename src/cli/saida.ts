import { brl } from '../domain/mensagem.js';
import type { Scored } from '../domain/scoring.js';
import { rotuloProduto } from '../domain/produto.js';
import type { PostPlan, ForaDoPublico } from '../ai/index.js';
import type { ImageScore } from '../media/imagescore.js';
import type { SearchIntent } from '../domain/intencao.js';
import type { BuscaSobDemanda, Resultado } from '../services/sobDemanda.js';

/** Tudo que o usuário vê no terminal. Nenhum serviço imprime — só daqui. */

export const linha = (s = '') => console.log(s);
export const avisos = (list: string[]) => list.forEach((a) => linha(a));

const TIPO: Record<NonNullable<Scored['dealType']>, string> = {
  oferta: '🔥 OFERTA',
  menor_preco: '🏆 MENOR PREÇO',
  achado: '⭐ ACHADO',
};

/**
 * Uma oferta da lista. Com `diversidade` (o `--all`), explica o score: cada
 * componente e o motivo — é o que permite ajustar o algoritmo olhando o porquê.
 */
export function oferta(s: Scored, i: number, foto?: ImageScore, diversidade?: number): void {
  const tipo = s.dealType ? TIPO[s.dealType] : '—';
  // Só o desconto medido aparece como "-X%". O da loja não é afirmação nossa.
  const queda = s.realDiscount !== null ? `  -${Math.round(s.realDiscount * 100)}% medido` : '';
  const preco = s.offer.priceMax !== null ? `a partir de ${brl(s.offer.price)}` : brl(s.offer.price);

  linha(`${String(i + 1).padStart(2)}. [${s.score.toFixed(0).padStart(3)}] ${tipo}${queda}  ${preco}`);
  linha(`    ${s.offer.title.slice(0, 70)}`);
  const rotulo = rotuloProduto(s.produto);
  if (rotulo) linha(`    ${rotulo}`);
  if (s.baseline) {
    linha(`    preço normal medido: ${brl(s.baseline)}${s.isLowest ? '  🏆 menor já visto' : ''}`);
  }
  linha(
    `    ⭐ ${s.offer.rating ?? '-'} · ${s.offer.sold ?? 0} vendidos · comissão ${((s.offer.commissionRate ?? 0) * 100).toFixed(0)}%`,
  );
  if (s.reenvioDe !== undefined) linha(`    🔻 reenvio: mandamos por ${brl(s.reenvioDe)}`);
  if (foto) linha(`    foto: ${foto.score}  (branco ${foto.whiteRatio} · entropia ${foto.entropy})`);
  if (diversidade !== undefined) {
    const c = s.componentes;
    linha(
      `    score ${s.score} · type ${s.dealType} · modo ${s.mode}` +
        (diversidade < 1 ? ` · diversidade ×${diversidade.toFixed(2)}` : ''),
    );
    linha(
      `    quality ${c.quality} · price ${c.price} · social ${c.social} · ` +
        `lowest ${c.lowest} · commission ${c.commission}`,
    );
    linha(`    motivo: "${s.motivo}"`);
  }
  linha();
}

/** No `--all`: o que passou nos filtros mas ficou abaixo do MIN_SCORE. */
export function abaixoDoCorte(list: Scored[]): void {
  if (!list.length) return;
  linha(`\nAbaixo do score mínimo (${list.length}):`);
  for (const s of list.slice(0, 10)) {
    linha(`   [${s.score.toFixed(0).padStart(3)}] ${s.offer.title.slice(0, 50)} — ${s.motivo}`);
  }
  if (list.length > 10) linha(`   … e mais ${list.length - 10}`);
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

  const faixaDe = (it: PostPlan['itens'][number]) =>
    it.s.offer.priceMax !== null ? `${brl(it.s.offer.price)}+` : brl(it.s.offer.price);

  if (p.grade) {
    // Na grade o que importa por produto é o código: é ele que a pessoa comenta
    // e é por ele que o direct chega.
    linha('\n🧾 GRADE (9 por slide, nesta ordem)');
    p.itens.forEach((it, i) => {
      linha(
        `   ${String(i + 1).padStart(2)}. ${it.codigo}  ${faixaDe(it).padStart(10)}  ` +
          it.s.offer.title.slice(0, 44),
      );
    });
    linha('\n   A tabela código → link vai pro 00-LEGENDA.txt.');
  } else {
    linha('\n📸 SLIDES (nesta ordem)');
    p.itens.forEach((it, i) => {
      linha(`   ${String(i + 1).padStart(2)}. ${it.etiqueta || '— (sem frase)'}`);
      linha(`       ${faixaDe(it)} · ${it.s.offer.title.slice(0, 52)}`);
      if (it.fala) linha(`       🗣️  ${it.fala}`);
    });
  }

  // Card sem etiqueta ainda renderiza (foto, preço, nome, prova social), só
  // perde a faixa amarela. Vale avisar: ou a IA pulou o produto, ou a etiqueta
  // dela citava um preço que não era o daquele item e foi descartada.
  const semFrase = p.grade ? 0 : p.itens.filter((it) => !it.etiqueta).length;
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

// ─── Busca sob demanda ──────────────────────────────────────────────────────

const lista = (v: string[]) => v.join(', ');

/** O pedido como o sistema entendeu. Com `avisos` (o `--debug`), o que foi corrigido na IA. */
export function intencao(i: SearchIntent, avisos: string[]): void {
  linha('\n🔎 BUSCA SOB DEMANDA\n');
  linha(`Pedido:\n   ${i.originalQuery}\n`);
  linha('Busca estruturada:');
  const campos: [string, string | null][] = [
    ['Produto', i.product],
    ['Categoria', [i.category, i.subcategory].filter(Boolean).join(' › ') || null],
    ['Público', i.audience],
    ['Marca', lista(i.brand) || null],
    ['Modelo', i.model],
    ['Cor', lista(i.color) || null],
    ['Tamanho', lista(i.size) || null],
    ['Material', lista(i.material) || null],
    ['Finalidade', lista(i.purpose) || null],
    ['Características', lista(i.features) || null],
    ['Preço mínimo', i.priceMin !== null ? brl(i.priceMin) : null],
    ['Preço máximo', i.priceMax !== null ? brl(i.priceMax) : null],
    ['Excluir', lista(i.exclusions) || null],
  ];
  for (const [nome, v] of campos) if (v) linha(`   ${nome}: ${v}`);
  linha(`   Keywords: ${i.keywords.join(' | ')}`);
  if (i.confidence < 0.6) linha(`   ⚠️  pedido vago (confiança ${i.confidence.toFixed(2)}) — detalhe mais se puder`);
  if (i.audience === 'infantil') linha('   ⚠️  produto infantil é sempre descartado pelos filtros do LinkCerto');
  for (const a of avisos) linha(`   ℹ️  ${a}`);
}

function resultado(r: Resultado, i: number, debug: boolean, foraDoOrcamento = false): void {
  const s = r.s;
  const o = s.offer;
  linha(`${String(i + 1).padStart(2)}. ${o.title.slice(0, 80)}`);
  linha(
    o.priceMax !== null
      ? `    a partir de ${brl(o.price)} (variações até ${brl(o.priceMax)})`
      : `    ${brl(o.price)}`,
  );
  if (r.orcamento.parcial) linha('    ⚠️  só algumas variações cabem no orçamento — confira a que a pessoa quer');
  if (foraDoOrcamento) {
    const onde = r.orcamento.lado === 'abaixo' ? 'abaixo do mínimo pedido' : 'acima do orçamento';
    linha(`    ⚠️  ${brl(r.orcamento.distancia)} ${onde}`);
  }
  const social: string[] = [];
  if (o.rating) social.push(`⭐ ${o.rating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
  if (o.sold) social.push(`🛒 ${o.sold.toLocaleString('pt-BR')} vendidos`);
  if (social.length) linha(`    ${social.join(' · ')}`);

  // Histórico: só afirma o que mediu. Sem baseline, diz isso — nada de "-X%".
  if (s.mode === 'history' && s.baseline) {
    const real = s.realDiscount ?? 0;
    linha(
      real > 0
        ? `    📉 ${Math.round(real * 100)}% abaixo do preço acompanhado (${brl(s.baseline)})`
        : `    📊 no preço de sempre (${brl(s.baseline)})`,
    );
    if (s.isLowest) linha('    🏆 menor preço que já acompanhamos');
  } else {
    linha('    ℹ️  sem histórico suficiente — desconto não verificado');
  }

  linha(`    Match: ${r.match.score} · Score: ${r.final.toFixed(0)}`);
  if (debug) {
    const c = s.componentes;
    linha(
      `    curadoria ${s.score} (quality ${c.quality} · price ${c.price} · social ${c.social} · ` +
        `lowest ${c.lowest} · commission ${c.commission}) · tipo ${s.dealType ?? '—'}`,
    );
    if (r.match.tem.length) linha(`    ✓ ${lista(r.match.tem)}`);
    if (r.match.falta.length) linha(`    ✗ ${lista(r.match.falta)}`);
    linha(`    motivo: "${s.motivo}"`);
  }
  linha(`    🔗 ${o.offerLink ?? o.url}`);
  linha();
}

/**
 * O resultado é só pra você: nenhum texto pronto pro cliente. Você escolhe o
 * que mandar, quanto e como.
 */
export function buscaSobDemanda(r: BuscaSobDemanda, debug: boolean): void {
  if (debug) {
    linha('\n### SEARCH');
    linha(`   queries executadas: ${r.queries}`);
    linha(`   produtos encontrados: ${r.encontrados}`);
    linha(`   após deduplicação: ${r.unicos}`);
    linha(`   descartes: ${JSON.stringify(r.descartes)}`);
  }
  linha(`\nForam encontrados: ${r.unicos} produtos`);
  linha(`Após filtros: ${r.aprovados} produtos\n`);

  if (r.resultados.length) {
    linha(`TOP ${r.resultados.length}:\n`);
    r.resultados.forEach((x, i) => resultado(x, i, debug));
  } else {
    linha('Não encontrei opções que atendam simultaneamente aos critérios.\n');
  }

  // Sem resultado, os próximos são a resposta; com resultado, só no debug.
  if (r.proximos.length && (!r.resultados.length || debug)) {
    linha(`### PRÓXIMOS DO PEDIDO (${r.proximos.length}) — passaram na qualidade, fora do orçamento\n`);
    r.proximos.forEach((x, i) => resultado(x, i, debug, true));
  }
}
