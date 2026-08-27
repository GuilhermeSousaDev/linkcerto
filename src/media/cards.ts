import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { brl } from '../domain/mensagem.js';
import { pegarFoto } from './capas.js';
import type { PostPlan } from '../ai/index.js';
import type { Scored } from '../domain/scoring.js';

const log = logger.child({ mod: 'photo' });

/**
 * Card quadrado 1080x1080.
 *
 * Quadrado porque é o que o template do CapCut realmente usa — gerar 9:16 e
 * deixar ele recortar o centro jogava metade dos pixels fora e fazia o produto
 * aparecer pequeno e mole.
 */
const S = 1080;

/** Montserrat: padrão de varejo/promoção. A DejaVu do sistema entregava "script". */
const FONT = 'Montserrat';
const ACCENT = '#E8FF3A';
const INK = '#0B0F0A';
/**
 * O off-white da capa com retrato. Branco puro (#FFF) endurecia a borda contra
 * o preto e branco da foto e dava cara de slide; o papel levemente quente
 * parece impresso, que é o efeito que a capa procura.
 */
const PAPEL = '#F2EFE9';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Tira emoji e símbolos do título.
 *
 * Vendedor enche o título de ✨🔥⭐ pra ganhar destaque na busca da Shopee, e a
 * Montserrat não tem esses glifos — saíam como quadradinhos no card.
 */
function cleanTitle(title: string): string {
  return title
    // Traço longo e aspa curva: a IA usa muito e nem toda variante da Montserrat
    // traz o glifo — quando falta, sai quadradinho no meio da frase.
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu,
      '',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—|•]+/, '')
    .trim();
}

/**
 * Largura aproximada de um texto. Montserrat ExtraBold fica em torno de 0.62 da
 * altura por caractere — estimativa suficiente pra dimensionar pílula e evitar
 * que o preço estoure a largura do card.
 */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.62;
}

function fitSize(text: string, ideal: number, maxWidth: number): number {
  const w = textWidth(text, ideal);
  return w <= maxWidth ? ideal : Math.floor((maxWidth / w) * ideal);
}

interface Pill {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  bg: string;
  fg: string;
}

function pillSvg(p: Pill): string {
  const padX = p.fontSize * 0.55;
  const h = Math.round(p.fontSize * 1.85);
  const w = Math.round(textWidth(p.text, p.fontSize) + padX * 2);
  const r = Math.round(h / 2);
  return `
    <rect x="${p.x}" y="${p.y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${p.bg}"/>
    <text x="${p.x + w / 2}" y="${p.y + h / 2}" fill="${p.fg}"
          font-family="${FONT}" font-weight="800" font-size="${p.fontSize}"
          text-anchor="middle" dominant-baseline="central">${esc(p.text)}</text>`;
}

/** Quebra o título em linhas que cabem na largura, com reticências no corte. */
function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, size) > maxWidth) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.slice(0, maxLines);
  if (out.length === maxLines && words.join(' ') !== out.join(' ')) {
    out[out.length - 1] = `${out[out.length - 1]}…`;
  }
  return out;
}

/**
 * Bloco inferior: preço grande, nome abaixo, prova social por último — tudo em
 * branco sobre um degradê.
 *
 * A Shopee não expõe descrição do produto na API de ofertas, então a última
 * linha traz nota, vendas e loja — pra uma oferta isso convence mais que texto
 * de vitrine, de qualquer forma.
 */
function overlaySvg(s: Scored, etiqueta = ''): string {
  const pct = Math.round(s.discount * 100);
  const price = brl(s.offer.price);
  const margin = 56;
  const maxW = S - margin * 2;

  const priceSize = fitSize(price, 124, maxW);
  const nameSize = 40;
  const subSize = 32;
  const tagSize = 38;

  const nameLines = wrap(cleanTitle(s.offer.title), nameSize, maxW, 2);

  // A etiqueta é a linha da IA: diz por que ESTE produto merece o slide. Vai
  // acima do preço porque o olho lê de baixo pra cima aqui — preço, nome, e a
  // etiqueta é o que sobra pra justificar o que a pessoa acabou de ver.
  const tag = etiqueta ? cleanTitle(etiqueta).toUpperCase() : '';

  // Empilhado a partir da base, pra nunca vazar por baixo.
  const subY = S - 52;
  const nameBottomY = subY - subSize - 22;
  const nameTopY = nameBottomY - (nameLines.length - 1) * (nameSize + 8);
  const priceY = nameTopY - nameSize - 30;
  const tagY = priceY - Math.round(priceSize * 0.78) - 20;
  // Com etiqueta o degradê sobe mais: ela é amarela e fina, e no primeiro teste
  // caiu na parte clara do gradiente em cima da sola branca de um tênis.
  const scrimTop = tag ? tagY - tagSize - 180 : priceY - priceSize - 110;

  const social: string[] = [];
  if (s.offer.rating) social.push(`${s.offer.rating.toFixed(1)} estrelas`);
  if (s.offer.sold) social.push(`${s.offer.sold.toLocaleString('pt-BR')} vendidos`);
  if (s.offer.shopName) social.push(s.offer.shopName);

  const parts: string[] = [];

  parts.push(`
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000" stop-opacity="0"/>
        <stop offset="45%" stop-color="#000" stop-opacity="0.62"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.94"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${scrimTop}" width="${S}" height="${S - scrimTop}" fill="url(#scrim)"/>`);

  parts.push(pillSvg({ text: `-${pct}%`, x: margin, y: 52, fontSize: 54, bg: ACCENT, fg: INK }));

  if (s.isLowest) {
    parts.push(
      pillSvg({
        text: 'MENOR PREÇO',
        x: margin,
        y: 52 + Math.round(54 * 1.85) + 18,
        fontSize: 30,
        bg: '#FFFFFF',
        fg: INK,
      }),
    );
  }

  // Preço "de" riscado ao lado do atual — é o que faz a oferta parecer oferta.
  // Com histórico usa o baseline medido; sem histórico, a âncora da loja.
  const anchor =
    s.mode === 'history' && s.baseline && s.baseline > s.offer.price
      ? s.baseline
      : s.offer.vendorDiscount && s.offer.vendorDiscount < 1
        ? s.offer.price / (1 - s.offer.vendorDiscount)
        : null;

  if (tag) {
    parts.push(`
    <text x="${margin}" y="${tagY}" fill="${ACCENT}"
          font-family="${FONT}" font-weight="800"
          font-size="${fitSize(tag, tagSize, maxW)}">${esc(tag)}</text>`);
  }

  parts.push(`
    <text x="${margin}" y="${priceY}" fill="#FFFFFF"
          font-family="${FONT}" font-weight="800" font-size="${priceSize}">${esc(price)}</text>`);

  if (anchor) {
    // Mesma linha de base do preço: lido como "por X, era Y". Acima ficava
    // solto no meio da foto e não se conectava ao valor atual.
    const oldSize = Math.round(priceSize * 0.36);
    parts.push(`
    <text x="${margin + textWidth(price, priceSize) + 20}" y="${priceY}"
          fill="#FFFFFF" opacity="0.85" text-decoration="line-through"
          font-family="${FONT}" font-weight="600" font-size="${oldSize}">${esc(brl(anchor))}</text>`);
  }

  nameLines.forEach((line, i) => {
    parts.push(`
    <text x="${margin}" y="${nameTopY + i * (nameSize + 8)}" fill="#FFFFFF"
          font-family="${FONT}" font-weight="600" font-size="${nameSize}">${esc(line)}</text>`);
  });

  if (social.length) {
    parts.push(`
    <text x="${margin}" y="${subY}" fill="#FFFFFF" opacity="0.78"
          font-family="${FONT}" font-weight="500" font-size="${subSize}">${esc(social.join('  ·  '))}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${parts.join('')}</svg>`;
}



/**
 * Capa: o gancho do post.
 *
 * Usa a foto do primeiro produto bem desfocada como fundo — dá contexto visual
 * sem competir com o texto, e evita a tela chapada que parece slide de
 * apresentação. O escurecimento é uma camada de opacidade FIXA, não `brightness`
 * proporcional: foto escura ficava preta.
 */
function coverSvg(capa: PostPlan['capa']): string {
  const maxW = S - 120;
  const title = cleanTitle(capa.titulo).toUpperCase();
  const subtitle = cleanTitle(capa.subtitulo);
  const lines = wrap(title, 96, maxW, 3);
  const size = Math.min(96, ...lines.map((l) => fitSize(l, 96, maxW)));

  const lineH = size + 16;
  const blockH = lines.length * lineH;
  const startY = Math.round(S / 2 - blockH / 2 + size * 0.35);

  const parts: string[] = [
    `<rect x="0" y="0" width="${S}" height="${S}" fill="#000" fill-opacity="0.55"/>`,
  ];

  lines.forEach((line, i) => {
    parts.push(`
    <text x="${S / 2}" y="${startY + i * lineH}" fill="#FFFFFF"
          font-family="${FONT}" font-weight="800" font-size="${size}"
          text-anchor="middle">${esc(line)}</text>`);
  });

  if (subtitle) {
    parts.push(`
    <text x="${S / 2}" y="${startY + lines.length * lineH + 24}" fill="${ACCENT}"
          font-family="${FONT}" font-weight="700" font-size="${fitSize(subtitle, 46, maxW)}"
          text-anchor="middle">${esc(subtitle)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${parts.join('')}</svg>`;
}

// ─── Capa com retrato ───────────────────────────────────────────────────────

/**
 * Onde o retrato entra e até onde o papel ainda cobre ele.
 *
 * O texto vive no papel e o rosto embaixo, com só uma faixa de encontro: sem a
 * fusão a borda reta do JPEG cortava a cabeça da pessoa numa linha dura e o
 * card virava colagem. Com ela, o retrato parece impresso no papel.
 *
 * A faixa é curta de propósito. Na primeira versão o papel descia até 60% da
 * altura pra "garantir" a leitura da manchete, e lavava justamente o rosto —
 * que é a única coisa pela qual a capa existe.
 */
const RETRATO_TOP = 400;
const FUSAO_ATE = 620;
/** O texto termina aqui. Abaixo é do rosto. */
const TEXTO_FUNDO = 470;
/** E começa aqui: menos que isso e a primeira linha sai cortada pelo topo. */
const TEXTO_TOPO = 90;

/**
 * Preto e branco de contraste duro, com grão.
 *
 * É o tratamento que faz seis fotos de origens diferentes virarem uma série: o
 * que dá identidade à capa não é a foto, é o que se faz com ela. Foto colorida
 * de banco de imagem entrega banco de imagem; a mesma foto assim entrega
 * editorial.
 */
/**
 * Onde o assunto deve cair dentro da faixa, de 0 (topo) a 1 (base).
 *
 * O número tem que respeitar o PAPEL, não só a foto: a fusão só termina em
 * `FUSAO_ATE`, o que em coordenada de faixa é ~0.29. Ancorar o assunto em 0.3
 * punha o rosto exatamente embaixo da parte ainda coberta — o card saía com um
 * queixo e um paletó, sem rosto nenhum.
 *
 * 0.48 deixa o rosto logo abaixo de onde o papel acaba, com a testa roçando a
 * cauda da fusão. É também onde a capa de referência põe os olhos: por volta de
 * 70% da altura total do card.
 */
const ASSUNTO_Y = 0.48;
/** Quanto ampliar antes de recortar. Foto de banco costuma vir com o assunto
 * pequeno demais no meio da cena; 1.25 aproxima sem estourar a nitidez. */
const ZOOM = 1.25;

/**
 * Recorta a foto POSICIONANDO o assunto, em vez de recortar e torcer.
 *
 * O `fit: cover` com `attention` sozinho decide o recorte pela saliência e
 * ignora a diagramação: como a manchete ocupa o topo do card, o rosto precisa
 * cair num lugar específico, e não no centro da janela. Aqui a janela do
 * `attention` serve só pra DESCOBRIR onde está o assunto — quem decide o
 * enquadramento é o layout.
 */
async function enquadrar(src: string, w: number, h: number): Promise<Buffer> {
  const largura = Math.round(w * ZOOM);

  // Sonda: o `cropOffset` vem negativo e já na escala de saída, então dá pra
  // ler direto onde o sharp centrou a janela do assunto.
  const { info } = await sharp(src)
    .resize(largura, Math.round(h * ZOOM), { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer({ resolveWithObject: true });

  const escalada = await sharp(src)
    .resize({ width: largura })
    .toBuffer({ resolveWithObject: true });

  const altura = escalada.info.height;
  const centro = -(info.cropOffsetTop ?? 0) + (h * ZOOM) / 2;
  const limite = (n: number, max: number) => Math.max(0, Math.min(Math.round(n), Math.max(0, max)));

  return sharp(escalada.data)
    .extract({
      left: limite(-(info.cropOffsetLeft ?? 0), largura - w),
      top: limite(centro - ASSUNTO_Y * h, altura - h),
      width: Math.min(w, largura),
      height: Math.min(h, altura),
    })
    .toBuffer();
}

async function tratar(src: string, w: number, h: number): Promise<Buffer> {
  const base = await sharp(await enquadrar(src, w, h))
    .resize(w, h, { fit: 'cover' })
    .greyscale()
    // No cinza natural o retrato empata de densidade com o papel e o card fica
    // sem peso — é o passo que mais muda a capa.
    .linear(1.32, -26)
    .sharpen({ sigma: 1.0, m1: 0.5, m2: 2.0 })
    .toColourspace('srgb')
    .png()
    .toBuffer();

  // Gaussiano de média 128 em soft-light: mexe na textura sem mexer no brilho
  // médio, então o contraste ajustado acima continua valendo.
  const grao = await sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      // O ruído sobrescreve o fundo; `background` está aqui só porque o tipo
      // de `create` exige. O cinza médio é o mesmo 128 da média do gaussiano.
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 10 },
    },
  })
    .png()
    .toBuffer();

  return sharp(base).composite([{ input: grao, blend: 'soft-light' }]).png().toBuffer();
}

/** A faixa onde o papel se dissolve em cima do retrato. */
function fusaoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <defs>
      <!--
        Quatro paradas, não duas: a rampa linear de opacidade em cima de uma
        foto escura lia como uma FAIXA horizontal de névoa, com início e fim
        visíveis. Segurar o papel no começo e derrubar rápido no fim tira a
        borda e deixa a dissolução parecendo impressão.
      -->
      <linearGradient id="fusao" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${PAPEL}" stop-opacity="1"/>
        <stop offset="30%" stop-color="${PAPEL}" stop-opacity="0.95"/>
        <stop offset="62%" stop-color="${PAPEL}" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="${PAPEL}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${RETRATO_TOP}" width="${S}" height="${FUSAO_ATE - RETRATO_TOP}"
          fill="url(#fusao)"/>
  </svg>`;
}

/**
 * Manchete preta no papel, alinhada à esquerda, com o subtítulo grifado.
 *
 * Montada de baixo pra cima, ancorada em `TEXTO_FUNDO`: assim manchete de uma
 * linha e de três terminam na mesma altura e nenhuma das duas invade o rosto.
 * Ancorada no topo, a de três linhas descia até a boca da pessoa.
 */
function capaClaraSvg(capa: PostPlan['capa']): string {
  const margem = 60;
  const maxW = S - margem * 2;

  const title = cleanTitle(capa.titulo).toUpperCase();

  const sub = cleanTitle(capa.subtitulo).toUpperCase();
  const subSize = sub ? fitSize(sub, 52, maxW - 40) : 0;
  const subH = sub ? Math.round(subSize * 1.5) : 0;

  const subTop = TEXTO_FUNDO - subH;
  const ultimaLinha = sub ? subTop - 30 : TEXTO_FUNDO;

  /**
   * O maior corpo que cabe em LARGURA e em ALTURA.
   *
   * A altura é a parte que faltava: encolher só pela largura deixava três
   * linhas de 112 empilhadas num espaço de 272px, e como o bloco é ancorado
   * embaixo, o que sobrava saía pra fora do card — a manchete longa perdia a
   * primeira linha, cortada pelo topo.
   */
  const disponivel = ultimaLinha - TEXTO_TOPO;
  let size = 112;
  let lines = wrap(title, size, maxW, 3);
  let lineH = Math.round(size * 1.02) + 10;

  while (size > 44 && (lines.length - 1) * lineH + size > disponivel) {
    size -= 4;
    lines = wrap(title, size, maxW, 3);
    lineH = Math.round(size * 1.02) + 10;
  }
  // Ainda pode sobrar uma linha larga demais (palavra única e comprida).
  size = Math.min(size, ...lines.map((l) => fitSize(l, size, maxW)));
  lineH = Math.round(size * 1.02) + 10;

  const primeiraLinha = ultimaLinha - (lines.length - 1) * lineH;

  const parts: string[] = [];

  lines.forEach((line, i) => {
    parts.push(`
    <text x="${margem}" y="${primeiraLinha + i * lineH}" fill="${INK}"
          font-family="${FONT}" font-weight="800" font-size="${size}"
          letter-spacing="-2">${esc(line)}</text>`);
  });

  if (sub) {
    // Bloco amarelo, não texto amarelo: o #E8FF3A é o mesmo do resto do
    // carrossel, mas em cima do papel claro ele sumia. Atrás de texto preto
    // vira marca-texto — e é o que o olho acha logo depois da manchete.
    const padX = Math.round(subSize * 0.42);
    const w = Math.round(textWidth(sub, subSize) + padX * 2);
    parts.push(`
    <rect x="${margem}" y="${subTop}" width="${w}" height="${subH}" fill="${ACCENT}"/>
    <text x="${margem + padX}" y="${subTop + subH / 2}" fill="${INK}"
          font-family="${FONT}" font-weight="800" font-size="${subSize}"
          dominant-baseline="central">${esc(sub)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${parts.join('')}</svg>`;
}

/**
 * Folha de provas: cada foto do casting, já tratada e recortada como a capa
 * vai recortar, numa grade só.
 *
 * Existe porque banco de imagem livre erra muito o que você pediu — "boxer"
 * devolve cachorro, "headphones" devolve fone em cima de um sofá — e o erro só
 * aparece quando o post já está pronto. Aqui aparece antes, com o nome do
 * arquivo do lado, pra você apagar os ruins em dez segundos.
 */
export async function folhaDeProvas(fotos: string[], out: string): Promise<void> {
  const COLS = 3;
  const CW = 360;
  const CH = Math.round((CW * (S - RETRATO_TOP)) / S);
  const ROTULO = 34;
  const linhas = Math.ceil(fotos.length / COLS);
  const W = COLS * CW;
  const H = linhas * (CH + ROTULO);

  const celulas = await Promise.all(
    fotos.map(async (foto, i) => ({
      input: await tratar(foto, CW, CH),
      left: (i % COLS) * CW,
      top: Math.floor(i / COLS) * (CH + ROTULO),
    })),
  );

  const rotulos = fotos
    .map((foto, i) => {
      const nome = foto.split(/[\\/]/).pop() ?? '';
      const x = (i % COLS) * CW + 10;
      const y = Math.floor(i / COLS) * (CH + ROTULO) + CH + 23;
      return `<text x="${x}" y="${y}" fill="${INK}" font-family="${FONT}"
                    font-weight="700" font-size="20">${esc(nome)}</text>`;
    })
    .join('');

  await sharp({ create: { width: W, height: H, channels: 3, background: PAPEL } })
    .composite([
      ...celulas,
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rotulos}</svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(out);
}

/** Papel + retrato tratado + fusão + manchete. */
async function renderCapaComRetrato(
  foto: string,
  capa: PostPlan['capa'],
  out: string,
): Promise<void> {
  const retrato = await tratar(foto, S, S - RETRATO_TOP);

  const papel = await sharp({
    create: { width: S, height: S, channels: 3, background: PAPEL },
  })
    .png()
    .toBuffer();

  await sharp(papel)
    .composite([
      { input: retrato, top: RETRATO_TOP, left: 0 },
      { input: Buffer.from(fusaoSvg()), top: 0, left: 0 },
      { input: Buffer.from(capaClaraSvg(capa)), top: 0, left: 0 },
    ])
    .jpeg({ quality: 94, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(out);
}

/**
 * Último slide, só o pedido.
 *
 * Separado dos cards de propósito: CTA repetido em toda foto vira moldura e o
 * olho para de ver. Aqui é a única imagem em que a ação é o assunto — e é onde a
 * pessoa para de deslizar.
 */
function ctaSvg(plano: PostPlan['cta']): string {
  const maxW = S - 120;
  const head = cleanTitle(plano.headline);
  const headSize = fitSize(head, 108, maxW);
  // É o único slide em que o pedido é o assunto — por isso o que tem no grupo e
  // o porquê de entrar hoje são escritos pela IA em cima das ofertas do dia, e
  // não uma frase fixa que vira moldura de tanto se repetir.
  const linha1 = cleanTitle(plano.linha1);
  const linha2 = cleanTitle(plano.linha2);
  const cta = config.CTA_TEXT;
  const ctaSize = 46;
  const pillW = Math.round(textWidth(cta, ctaSize) + ctaSize * 1.1);
  const pillY = Math.round(S / 2 + 120);

  const parts: string[] = [
    `<rect x="0" y="0" width="${S}" height="${S}" fill="#000" fill-opacity="0.62"/>`,
    `<text x="${S / 2}" y="${S / 2 - 80}" fill="${ACCENT}" font-family="${FONT}"
       font-weight="800" font-size="${headSize}" text-anchor="middle">${esc(head)}</text>`,
    `<text x="${S / 2}" y="${S / 2 + 6}" fill="#FFFFFF" font-family="${FONT}"
       font-weight="600" font-size="${fitSize(linha1, 44, maxW)}" text-anchor="middle">${esc(linha1)}</text>`,
    `<text x="${S / 2}" y="${S / 2 + 68}" fill="#FFFFFF" font-family="${FONT}"
       font-weight="600" font-size="${fitSize(linha2, 44, maxW)}" text-anchor="middle" opacity="0.85">${esc(linha2)}</text>`,
    pillSvg({
      text: cta,
      x: Math.round((S - pillW) / 2),
      y: pillY,
      fontSize: ctaSize,
      bg: ACCENT,
      fg: INK,
    }),
  ];

  if (config.PROFILE_HANDLE) {
    parts.push(`
    <text x="${S / 2}" y="${pillY + Math.round(ctaSize * 1.85) + 68}" fill="#FFFFFF"
          font-family="${FONT}" font-weight="700" font-size="40"
          text-anchor="middle" opacity="0.9">${esc(config.PROFILE_HANDLE)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${parts.join('')}</svg>`;
}

/**
 * A foto da Shopee é 800x800 e não existe versão maior no CDN (testado). Subir
 * pra 1080 sempre custa nitidez; lanczos3 + unsharp recuperam boa parte.
 */
async function renderCard(src: string, svg: string, out: string): Promise<void> {
  const base = await sharp(src)
    .resize(S, S, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 1.1, m1: 0.6, m2: 2.2 })
    .toBuffer();

  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 94, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(out);
}

export interface PhotoOut {
  rank: number;
  title: string;
  path: string;
}

function slug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`imagem HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Gera o carrossel a partir do plano da IA.
 *
 * O plano é obrigatório: quem manda na ordem dos slides, na capa, na frase de
 * cada card e no slide final é ele. Post genérico não existe mais aqui — capa
 * fixa é a mesma capa que o seguidor já ignorou ontem.
 */
export async function makePhotos(plan: PostPlan, outDir: string): Promise<PhotoOut[]> {
  const items = plan.itens.filter((it) => it.s.offer.imageUrl);
  if (!items.length) throw new Error('nenhuma oferta com imagem');

  const origDir = join(outDir, 'originais');
  mkdirSync(origDir, { recursive: true });

  const out: PhotoOut[] = [];

  // Numeração: 01 é a capa, produtos no meio, CTA fecha. Assim o post já sai na
  // ordem certa ao importar tudo de uma vez.
  for (const [i, it] of items.entries()) {
    const rank = i + 2;
    const base = `${String(rank).padStart(2, '0')}-${slug(it.s.offer.title)}`;
    const original = resolve(origDir, `${base}.jpg`);
    await download(it.s.offer.imageUrl as string, original);

    const path = resolve(outDir, `${base}.jpg`);
    await renderCard(original, overlaySvg(it.s, it.etiqueta), path);
    out.push({ rank, title: it.s.offer.title, path });
  }

  const first = items[0];
  if (first) {
    const src = resolve(origDir, `02-${slug(first.s.offer.title)}.jpg`);

    // Com retrato a capa é outra coisa: papel claro, manchete preta e um rosto
    // embaixo. Sem retrato — pasta vazia, casting que a IA não escolheu — cai
    // na foto do produto desfocada, que é o que sempre foi. O fallback importa:
    // ninguém deve precisar ter foto na pasta pra conseguir gerar um post.
    const capaPath = resolve(outDir, '01-CAPA.jpg');
    const retrato = plan.capa.casting ? pegarFoto(plan.capa.casting) : null;

    if (retrato) {
      await renderCapaComRetrato(retrato, plan.capa, capaPath);
    } else {
      const coverBg = await sharp(src).resize(S, S, { fit: 'cover' }).blur(24).toBuffer();
      await sharp(coverBg)
        .composite([{ input: Buffer.from(coverSvg(plan.capa)), top: 0, left: 0 }])
        .jpeg({ quality: 94, mozjpeg: true })
        .toFile(capaPath);
    }

    const ctaBg = await sharp(src).resize(S, S, { fit: 'cover' }).blur(30).toBuffer();
    await sharp(ctaBg)
      .composite([{ input: Buffer.from(ctaSvg(plan.cta)), top: 0, left: 0 }])
      .jpeg({ quality: 94, mozjpeg: true })
      .toFile(resolve(outDir, `${String(items.length + 2).padStart(2, '0')}-CTA.jpg`));
  }

  const produtos = items.map((it) => it.s);

  // Abaixo da linha vai tudo que NÃO é pra colar no post: links de afiliado,
  // roteiro do vídeo e as respostas prontas. Fica no mesmo arquivo porque na
  // hora de postar, no celular, abrir dois é atrito que ninguém vence.
  const referencia: string[] = [];
  {
    referencia.push('COMENTÁRIO FIXADO (fixe você mesmo, logo depois de postar)');
    referencia.push(plan.comentarioFixado, '');
    referencia.push('RESPOSTA PRONTA pros "qual o link?"');
    referencia.push(plan.respostaPadrao, '');
    if (config.GRUPO_URL) {
      // Fica aqui embaixo de propósito: é pra copiar e colar no direct de quem
      // comentar a palavra. Na legenda do post o TikTok não deixa clicar e
      // ainda trata convite de WhatsApp como spam.
      referencia.push('CONVITE DO GRUPO (cole no direct — nunca na legenda)');
      referencia.push(`  ${config.GRUPO_URL}`, '');
    }
    if (plan.roteiro.gancho) {
      referencia.push('ROTEIRO');
      referencia.push(`  0. (3 primeiros segundos) ${plan.roteiro.gancho}`);
      // Numerado pela posição do slide, não pela ordem das falas: é assim que
      // você vai procurar na hora de gravar.
      referencia.push(
        ...items.map((it, i) => (it.fala ? `  ${i + 1}. ${it.fala}` : '')).filter(Boolean),
        '',
      );
    }
    if (plan.capa.variantes.length) {
      referencia.push('OUTRAS CAPAS (pra testar se este post não performar)');
      referencia.push(...plan.capa.variantes.map((v) => `  • ${v}`), '');
    }
  }

  writeFileSync(
    resolve(outDir, '00-LEGENDA.txt'),
    [
      plan.legenda,
      '',
      '═'.repeat(60),
      'DAQUI PRA BAIXO É REFERÊNCIA — NÃO COLE NO POST',
      '═'.repeat(60),
      '',
      ...referencia,
      ...produtos.map(
        (s, i) => `[${i + 1}] ${brl(s.offer.price)} — ${s.offer.offerLink ?? s.offer.url}`,
      ),
    ].join('\n') + '\n',
    'utf8',
  );

  log.info({ produtos: out.length, dir: outDir }, 'cards gerados');
  return out;
}
