import { config } from './infra/config.js';
import { logger } from './infra/logger.js';
import { close, stats } from './infra/db.js';
import { WhatsApp } from './infra/whatsapp.js';
import { listNiches } from './domain/niches.js';
import { avisoDeAlta, loteToJson } from './domain/lote.js';
import { planToJson } from './ai/index.js';
import * as ofertas from './services/ofertas.js';
import * as conteudo from './services/conteudo.js';
import * as grupo from './services/grupo.js';
import * as out from './cli/saida.js';
import { comando, flag, frase, num, numeros, texto } from './util/args.js';
import { idadeEmTexto, salvar, ultimoSalvo } from './util/arquivo.js';

/**
 * Controller: lê os argumentos, chama os serviços, imprime o resultado.
 * Nenhuma regra de negócio mora aqui.
 */

const HELP = `
Alerta de Preços

  npm run deals       Mostra as melhores ofertas e salva o lote (não envia)
  npm run send        Manda pro grupo do WhatsApp o lote que o deals mostrou
  npm run ideia       A IA monta o post de hoje: capa, ordem, legenda, roteiro
  npm run photos      Gera os cards 1080x1080 com o plano da IA
  npm run photos:send Manda os cards pro seu grupo pessoal (ponte pro celular)
  npm run niches      Sugestões de termos por nicho, com a comissão típica
  npm run wa:login    Conecta o WhatsApp via QR code (uma vez só)
  npm run wa:groups   Lista seus grupos e os JIDs
  npm run stats       Quantos produtos/preços já foram coletados

  Opções:  --tema "…"    O assunto. Se for categoria, muda a busca também
           --niche N     Um nicho pronto do catálogo (npm run niches)
           --keywords    "a,b" — os termos na mão
           --top N       Quantos mostrar/enviar (padrão: ${config.TOP_N})
           --skip 1,4    Descarta ofertas da lista (foto ruim) e puxa as próximas
           --all         Mostra também os descartados e o motivo
           --dias N      Dias sem repetir um produto (padrão: ${config.POST_COOLDOWN_DAYS})
           --repetir     Ignora essa janela
           --sem-filtro  Não descarta produto de outro público (AI_PUBLICO)
           --db          No deals/ideia: escolhe do banco, sem buscar na Shopee
           --dias-db N   Idade máxima da leitura no --db (padrão: ${config.DB_MAX_AGE_DAYS})
           --novo        Ignora o plano/lote salvo e refaz do zero
           --plano F     Usa um plano salvo específico (data/plans/….json)
           --lote F      Usa um lote salvo específico (data/lotes/….json)
`;

const pedidoDeBusca = () => ({
  manual: texto('keywords'),
  niche: frase('niche') ?? frase('nicho'),
  tema: frase('tema'),
  comando,
});

/**
 * Busca → aprova → tira quem é de outro público.
 *
 * Só os PRODUTORES passam por aqui (`deals` e `ideia`). Quem consome uma
 * seleção salva — `send` e `photos` — pega os produtos por id no banco, porque
 * quem escolheu já gravou.
 */
async function selecionar(opts: { comFoto?: boolean } = {}) {
  let termos: string[] = [];
  let scored;

  if (flag('db')) {
    // `--db` não toca na Shopee: usa o que já foi coletado. O tema, se vier,
    // filtra os títulos — senão ele iria pra IA sem ter mexido na seleção, e o
    // post sairia com capa de academia em cima de perfume.
    const dias = num('dias-db', config.DB_MAX_AGE_DAYS);
    const tema = frase('tema');
    const r = await ofertas.buscarNoBanco(dias, tema);
    scored = r.ofertas;

    out.linha(`\n💾 Do banco: ${r.total} produto(s) dos últimos ${dias} dias`);
    if (tema) out.linha(`   filtrado por "${tema}": ${r.palavras.join(', ')}`);

    if (tema && !r.total) {
      throw new Error(
        `Nada no banco casa com "${tema}".\n` +
          'Rode sem --db pra buscar na Shopee, ou aumente a janela com --dias-db.',
      );
    }
  } else {
    const r = await ofertas.resolverTermos(pedidoDeBusca());
    termos = r.termos;
    out.avisos(r.avisos);
    out.linha(`\n🎯 Buscando: ${termos.join(', ')}`);
    scored = await ofertas.buscar(termos);
  }

  const aprovadas = ofertas.aprovadas(scored, opts.comFoto);
  const { dentro, fora } = await ofertas.porPublico(aprovadas, flag('sem-filtro'));
  out.foraDoPublico(fora, config.AI_PUBLICO);

  return { termos, scored, elegiveis: dentro };
}

/** Aplica a janela de não-repetição e conta o que ficou de fora. */
async function novos(list: Awaited<ReturnType<typeof selecionar>>['elegiveis']) {
  const r = await ofertas.semRepetidos(list, num('dias', ofertas.cooldownPadrao()), flag('repetir'));

  if (r.cortados) out.linha(`${r.cortados} produto(s) fora: já viraram card recentemente`);
  if (!r.dentro.length && list.length) {
    out.linha('\n⚠️  Todos os aprovados já foram postados. Use --repetir ou troque o tema.');
  }
  return r.dentro;
}

async function deals(): Promise<void> {
  const { termos, scored, elegiveis } = await selecionar();

  out.linha(`\n${elegiveis.length} ofertas passaram nos filtros (de ${scored.length})\n`);
  const lista = elegiveis.slice(0, num('top', config.TOP_N));
  lista.forEach((s, i) => out.oferta(s, i));

  // Só o que você viu vira histórico. Ver `services/ofertas.registrar`.
  await ofertas.registrar(lista);

  if (lista.length) {
    out.linha(`Lote salvo em ${salvar('data/lotes', loteToJson(termos, lista))}`);
    out.proximoPasso([
      ['npm run send', 'manda ESTAS ofertas'],
      ['npm run deals', 'não gostou? vale sempre o mais recente'],
      ['npm run send -- --novo', 'ignora o lote e busca de novo'],
    ]);
  }

  if (flag('all')) {
    const motivos: Record<string, number> = {};
    for (const s of scored) if (s.rejected) motivos[s.rejected] = (motivos[s.rejected] ?? 0) + 1;
    out.linha(`Descartados: ${JSON.stringify(motivos)}`);
  }

  if (!elegiveis.some((s) => s.mode === 'history')) {
    out.linha(
      'ℹ️  Nenhum produto tem histórico ainda, então os descontos acima são os\n' +
        '   anunciados pela Shopee. Rode alguns dias seguidos e o sistema passa\n' +
        '   a medir o preço real sozinho.',
    );
  }
}

async function send(): Promise<void> {
  const jid = grupo.exigirGrupo();
  const salvo = ultimoSalvo('data/lotes', texto('lote'), flag('novo'));
  const lote = salvo ? grupo.lerLoteSalvo(salvo) : null;

  if (salvo && lote) {
    out.linha(`\n📋 Usando o lote de ${salvo.file} (${idadeEmTexto(salvo.idade)}).`);
    out.linha('   --novo busca de novo · --lote <arquivo> escolhe qual.');
  }

  // Com lote, nada de varrer o feed: relê na Shopee só os produtos que vão
  // sair, pra pegar preço que mudou depois que você aprovou a lista.
  let elegiveis;
  if (lote) {
    const r = await ofertas.conferirPrecos(lote.ofertas.map((o) => o.id));
    elegiveis = r.ofertas;
    if (r.semResposta) {
      out.linha(`
⚠️  ${r.semResposta} sem resposta da Shopee — usando o preço do banco.`);
    }
  } else {
    elegiveis = (await selecionar()).elegiveis;
  }

  let candidatos = elegiveis.slice(0, num('top', config.TOP_N));
  if (lote) {
    const r = grupo.ofertasDoLote(lote, elegiveis);
    candidatos = r.picked;

    if (r.sumiram) out.linha(`\n⚠️  ${r.sumiram} oferta(s) do lote sumiram da busca.`);
    if (r.subiu.length) {
      out.linha(`\n⚠️  ${r.subiu.length} subiram de preço desde o deals:`);
      avisoDeAlta(r.subiu).forEach((l) => out.linha(l));
      out.linha('   Rode "npm run deals" de novo pra refazer a lista.');
    }
  }

  const picked = await grupo.naoRepetidas(candidatos);
  if (!picked.length) {
    logger.info('nada novo pra enviar');
    return;
  }

  out.linha(`\nEnviando ${picked.length} ofertas:\n`);
  picked.forEach((s, i) => out.oferta(s, i));
  await ofertas.registrar(picked);

  logger.info({ enviadas: await grupo.enviar(jid, picked) }, 'enviado');
}

async function ideia(): Promise<void> {
  const { termos, elegiveis } = await selecionar();
  const picked = (await novos(elegiveis)).slice(0, num('top', 8));

  if (!picked.length) {
    out.linha('Nenhuma oferta passou nos filtros — sem material pra post.');
    return;
  }

  await ofertas.registrar(picked);

  const plan = await conteudo.planoDoPost(picked, {
    termos,
    tema: frase('tema'),
    reaproveitar: false,
  });
  out.plano(plan);

  out.linha(`Salvo em ${salvar('data/plans', planToJson(plan))}`);
  out.proximoPasso([
    ['npm run photos', 'gera os cards com ESTE plano'],
    ['npm run ideia', 'não gostou? vale sempre o mais recente'],
    ['npm run photos -- --novo', 'ignora o plano e gera outra copy'],
  ]);
}

async function photos(): Promise<void> {
  const salvo = ultimoSalvo('data/plans', texto('plano'), flag('novo'));
  const lido = salvo ? conteudo.lerPlanoSalvo(salvo) : null;
  if (lido?.aviso) out.linha(lido.aviso);

  const planoSalvo = lido?.plano ?? null;
  if (salvo && planoSalvo) {
    out.linha(`\n📋 Usando o plano de ${salvo.file} (${idadeEmTexto(salvo.idade)}).`);
    out.linha('   --novo gera outro do zero · --plano <arquivo> escolhe qual.');
  }

  // Mesma lógica do `send`: com plano, o `ideia` já escolheu e gravou esses
  // produtos — reencontrar é uma query por id, não uma varredura da Shopee.
  const daBusca = planoSalvo ? null : await selecionar({ comFoto: true });
  const termos = daBusca?.termos ?? [];
  const elegiveis = planoSalvo
    ? (await ofertas.porIds([...planoSalvo.ordem.keys()])).filter((s) => s.offer.imageUrl)
    : daBusca!.elegiveis;

  const skip = numeros('skip');
  const pool = (await novos(elegiveis)).filter((_, i) => !skip.has(i + 1));

  out.linha('\nAvaliando as fotos...');
  const escolha = await conteudo.escolherPelaFoto(pool, {
    topN: num('top', config.TOP_N),
    minImagem: Number(texto('min-image') ?? conteudo.corteVisualPadrao()),
    ordenarPorFoto: flag('visual'),
    ordem: planoSalvo?.ordem,
  });

  if (!escolha.picked.length) {
    // Separar os dois motivos importa: "não achei o produto" e "achei mas a
    // foto é ruim" pedem ações opostas, e o `ideia` não avalia foto — então
    // esse segundo caso é o comum quando o nicho é de foto em fundo branco.
    if (planoSalvo && !escolha.encontrados) {
      out.linha('\nNenhum produto do plano foi encontrado na busca de agora.');
      out.linha('Gere outro plano: npm run photos -- --novo');
    } else {
      out.linha(`\nAs ${escolha.encontrados} fotos avaliadas reprovaram no corte visual.`);
      out.linha('Afrouxe com --min-image 0.3, ou troque o tema.');
      if (planoSalvo) out.linha('O plano não olha foto; só o photos olha.');
    }
    return;
  }

  if (planoSalvo && escolha.picked.length < planoSalvo.ordem.size) {
    out.linha(
      `\n⚠️  ${planoSalvo.ordem.size - escolha.picked.length} produto(s) do plano ficaram de fora ` +
        '(sumiram da busca, já viraram card ou a foto não passou).',
    );
  }

  out.linha(`${escolha.descartadas} descartadas por foto fraca (fundo branco / catálogo)\n`);
  escolha.picked.forEach((s, i) => out.oferta(s, i, escolha.notas.get(s)));

  const plan = await conteudo.planoDoPost(escolha.picked, {
    termos,
    tema: frase('tema'),
    salvo,
    reaproveitar: Boolean(planoSalvo),
  });
  out.plano(plan);

  const { dir, cards } = await conteudo.gerarPost(plan);

  out.linha(`Prontas — ${cards.length} cards 1080x1080 em ${dir}/\n`);
  for (const c of cards) out.linha(`  ${String(c.rank).padStart(2)}. ${c.title.slice(0, 55)}`);
  out.linha('\n  originais/       foto quadrada da Shopee, se quiser reenquadrar');
  out.linha('  00-LEGENDA.txt   legenda do post + roteiro + comentário fixado');
  out.linha('  00-PLANO.json    o plano inteiro, legível e editável\n');
  out.linha('Foto ruim? Rode de novo com --skip 1,4 pra puxar as seguintes.\n');
}

async function photosSend(): Promise<void> {
  const jid = grupo.exigirGrupoPessoal();
  const dir = grupo.ultimaPastaDeCards(texto('dir'));
  const files = grupo.cardsDaPasta(dir);

  if (!files.length) {
    out.linha(`Nenhum .jpg em ${dir}`);
    return;
  }

  const asImage = flag('as-image');
  out.linha(`\nEnviando ${files.length} cards de ${dir}`);
  out.linha(
    asImage
      ? 'Como IMAGEM: cai na galeria, mas o WhatsApp recomprime.\n'
      : 'Como DOCUMENTO: mantém a qualidade. No celular abre em Documentos.\n',
  );

  await grupo.enviarCards(
    jid,
    files,
    { asImage, legenda: grupo.legendaDaPasta(dir) ?? undefined },
    (i, f) => out.linha(`  ${i + 1}/${files.length}  ${f.split('/').pop()}`),
  );

  out.linha('\nPronto. Baixe no celular e poste pelo app do TikTok.\n');
}

async function waLogin(): Promise<void> {
  const wa = new WhatsApp();
  await wa.connect(180_000);
  logger.info('WhatsApp conectado. Agora rode "npm run wa:groups".');
  await wa.close();
}

async function waGroups(): Promise<void> {
  const wa = new WhatsApp();
  await wa.connect();
  const groups = await wa.groups();
  await wa.close();

  if (!groups.length) {
    logger.warn('Nenhum grupo. Crie o grupo, mande uma mensagem nele e tente de novo.');
    return;
  }
  out.linha('\nCopie o JID do grupo pro WA_GROUP_JID no .env:\n');
  for (const g of groups) out.linha(`  ${g.subject}\n    ${g.jid}\n`);
}

const COMANDOS: Record<string, () => Promise<void> | void> = {
  deals,
  send,
  ideia,
  photos,
  'photos:send': photosSend,
  'wa:login': waLogin,
  'wa:groups': waGroups,
  niches: () => out.linha(listNiches()),
  stats: async () => console.table(await stats()),
};

async function main(): Promise<void> {
  // Conteúdo é AI-only: falha aqui, antes de buscar na Shopee e baixar foto.
  if ((comando === 'photos' || comando === 'ideia') && !config.REMOTE_AI_API_KEY) {
    throw new Error(
      'REMOTE_AI_API_KEY não está no .env — sem ela não sai post.\n' +
        'Pegue uma chave em console.groq.com e veja o .env.example.',
    );
  }

  const fn = COMANDOS[comando];
  if (!fn) {
    out.linha(HELP);
    return;
  }
  await fn();
}

main()
  .catch((err) => {
    logger.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(close);
