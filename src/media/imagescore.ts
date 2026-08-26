import sharp from 'sharp';
import { logger } from '../infra/logger.js';

const log = logger.child({ mod: 'imagescore' });

/**
 * Mede o quanto uma foto de produto "chama atenção" num vídeo.
 *
 * A Shopee devolve uma imagem só por produto (confirmado por introspecção: nem
 * `productOfferV2` nem o feed de catálogo têm galeria). Como não dá pra buscar
 * fotos melhores, o caminho é escolher melhor entre as que existem.
 *
 * Dois sinais, validados numa amostra de 500 itens do feed de lojas oficiais:
 *
 *   whiteRatio  fração de pixels quase brancos. Recorte de catálogo em fundo
 *               branco fica ~0.8; foto ambientada fica ~0.01.
 *   entropy     riqueza visual. Catálogo ~1.8, foto ambientada ~7.4.
 *
 * Os extremos observados foram um relógio sobre skyline noturno (0.01 / 7.44)
 * e um filtro de combustível recortado em branco (0.83 / 1.84).
 *
 * Limite honesto: isto separa foto ambientada de recorte de catálogo. NÃO
 * detecta banner de marketing com texto do vendedor — banner pode ter entropia
 * alta e passar. Pra esses continua valendo o `--skip`.
 */
export interface ImageScore {
  score: number;
  whiteRatio: number;
  entropy: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

async function scoreImage(url: string): Promise<ImageScore | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    const img = sharp(buf);
    const stats = await img.stats();

    // 64x64 em cinza é resolução de sobra pra medir área branca e custa quase nada.
    const small = await img.clone().resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer();
    let white = 0;
    for (const v of small) if (v > 238) white++;
    const whiteRatio = white / small.length;

    const entropy = stats.entropy;

    // Fundo branco pesa mais: é o que mais denuncia "foto de marketplace".
    const score =
      0.6 * (1 - clamp01(whiteRatio / 0.7)) + 0.4 * clamp01(entropy / 7);

    return {
      score: Number(score.toFixed(3)),
      whiteRatio: Number(whiteRatio.toFixed(3)),
      entropy: Number(entropy.toFixed(2)),
    };
  } catch (err) {
    log.debug({ url, err: (err as Error).message }, 'falha ao pontuar imagem');
    return null;
  }
}

/** Pontua várias em paralelo, com limite pra não martelar o CDN. */
export async function scoreMany<T>(
  items: T[],
  urlOf: (item: T) => string | null,
  concurrency = 6,
): Promise<Map<T, ImageScore>> {
  const out = new Map<T, ImageScore>();
  const queue = [...items];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const url = urlOf(item);
        if (!url) continue;
        const s = await scoreImage(url);
        if (s) out.set(item, s);
      }
    }),
  );

  return out;
}
