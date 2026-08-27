import { createHash } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'shopee' });

export interface Offer {
  id: string; // `${shopId}_${itemId}`
  title: string;
  url: string;
  /** Affiliate link handed back by the feed — already trackable. */
  offerLink: string | null;
  imageUrl: string | null;
  /**
   * O MENOR preço entre as variações. É o que a Shopee chama de `price`, e é
   * igual ao `priceMin` na prática.
   */
  price: number;
  /**
   * O MAIOR preço entre as variações, quando existe faixa.
   *
   * `null` quando o produto tem preço único. Importa porque anunciar "R$ 67,90"
   * num produto cujas variações vão até R$ 133,56 é isca: a pessoa chega na
   * página e o preço é outro. Ver `temFaixa`.
   */
  priceMax: number | null;
  /** Vendor-declared discount, 0..1. Marketing copy — treat with suspicion. */
  vendorDiscount: number | null;
  rating: number | null;
  sold: number | null;
  /** Fractional, e.g. 0.08 for 8%. */
  commissionRate: number | null;
  shopName: string | null;
}

/**
 * Shopee Affiliate Open API — verified working 2026-08-17.
 *
 * Sobre reler um produto específico: `itemId` FUNCIONA, mas só como string.
 * Passado como número o servidor devolve "wrong type" e zero nós — o que já
 * levou a concluir, errado, que o filtro era ignorado. Ver `fetchByIds`.
 */
const PRODUCT_OFFER_QUERY = `
query ProductOffer($page: Int, $limit: Int, $keyword: String, $sortType: Int, $listType: Int) {
  productOfferV2(page: $page, limit: $limit, keyword: $keyword, sortType: $sortType, listType: $listType) {
    nodes {
      itemId shopId productName productLink offerLink imageUrl
      price priceMin priceMax priceDiscountRate sales ratingStar
      commissionRate shopName
    }
    pageInfo { page limit hasNextPage }
  }
}
`;

const ITEM_QUERY = `
query Item($itemId: Int64) {
  productOfferV2(itemId: $itemId, limit: 1) {
    nodes {
      itemId shopId productName productLink offerLink imageUrl
      price priceMin priceMax priceDiscountRate sales ratingStar
      commissionRate shopName
    }
  }
}
`;

const SHORT_LINK_MUTATION = `
mutation GenerateShortLink($input: ShortLinkInput!) {
  generateShortLink(input: $input) { shortLink }
}
`;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signed request. The signature covers the exact body bytes, so the serialized
 * payload is built once and reused for signing and sending — re-serializing
 * would produce a different string and a 401.
 */
async function request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { SHOPEE_APP_ID: appId, SHOPEE_APP_SECRET: secret } = config;
  if (!appId || !secret) {
    throw new Error('Missing SHOPEE_APP_ID / SHOPEE_APP_SECRET in .env');
  }

  const payload = JSON.stringify({ query, variables });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const ts = Math.floor(Date.now() / 1000); // seconds, ~5 min window
    const sig = createHash('sha256').update(`${appId}${ts}${payload}${secret}`).digest('hex');

    try {
      const res = await fetch(config.SHOPEE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sig}`,
        },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429 || res.status >= 500) throw new Error(`retryable HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const json = (await res.json()) as { data?: T; errors?: unknown[] };
      if (json.errors?.length) {
        // Contract mismatch, not transient — don't retry.
        throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
      }
      if (!json.data) throw new Error('empty response');
      return json.data;
    } catch (err) {
      const msg = (err as Error).message;
      const retryable = msg.startsWith('retryable') || msg.includes('timeout') || msg.includes('fetch');
      if (!retryable || attempt === 3) throw err;
      await sleep(2 ** attempt * 500);
    }
  }
  throw new Error('unreachable');
}

interface FeedResponse {
  productOfferV2: {
    nodes: Record<string, unknown>[];
    pageInfo: { hasNextPage: boolean };
  };
}

function toOffer(n: Record<string, unknown>): Offer | null {
  const price = num(n['price']) ?? num(n['priceMin']);
  if (price === null || price <= 0) return null;

  let commissionRate = num(n['commissionRate']);
  if (commissionRate !== null && commissionRate > 1) commissionRate = commissionRate / 100;

  const rate = num(n['priceDiscountRate']);
  const vendorDiscount = rate !== null && rate > 0 && rate < 100 ? rate / 100 : null;

  // Só conta como faixa se o topo for mesmo mais alto: a maioria dos produtos
  // devolve priceMax igual ao price, e tratar isso como faixa poria "a partir
  // de" em card de produto que tem um preço só.
  const max = num(n['priceMax']);
  const priceMax = max !== null && max > price * 1.02 ? max : null;

  return {
    id: `${n['shopId']}_${n['itemId']}`,
    title: String(n['productName'] ?? ''),
    url: String(n['productLink'] ?? ''),
    offerLink: (n['offerLink'] as string) || null,
    imageUrl: (n['imageUrl'] as string) || null,
    price,
    priceMax,
    vendorDiscount,
    rating: num(n['ratingStar']),
    sold: num(n['sales']),
    commissionRate,
    shopName: (n['shopName'] as string) || null,
  };
}

/** Varre páginas disjuntas do feed para um termo (ou o feed geral, se vazio). */
async function sweep(
  keyword: string,
  pages: number,
  into: Map<string, Offer>,
): Promise<void> {
  for (let page = 1; page <= pages; page++) {
    const data = await request<FeedResponse>(PRODUCT_OFFER_QUERY, {
      page,
      limit: config.SHOPEE_PAGE_SIZE,
      keyword,
      sortType: 2, // mais vendidos
      listType: 0,
    });

    for (const node of data.productOfferV2?.nodes ?? []) {
      const offer = toOffer(node);
      if (offer) into.set(offer.id, offer);
    }

    if (!data.productOfferV2?.pageInfo?.hasNextPage) break;
    if (page < pages) await sleep(400);
  }
}

/**
 * Busca as ofertas.
 *
 * Com termos, busca um a um — é isso que mantém o grupo em um nicho só. Sem
 * termos, cai no feed geral de mais vendidos, que traz produto aleatório e
 * quebra a coerência do funil.
 */
export async function fetchOffers(
  keywords: string[] = [],
  pages = config.SHOPEE_PAGES,
): Promise<Offer[]> {
  const byId = new Map<string, Offer>();

  if (keywords.length === 0) {
    await sweep('', pages, byId);
    log.info({ pages, found: byId.size }, 'ofertas do feed geral');
    return [...byId.values()];
  }

  for (const [i, keyword] of keywords.entries()) {
    const before = byId.size;
    await sweep(keyword, pages, byId);
    log.info({ keyword, novos: byId.size - before }, 'termo buscado');
    if (i < keywords.length - 1) await sleep(400);
  }

  log.info({ termos: keywords.length, found: byId.size }, 'ofertas do nicho');
  return [...byId.values()];
}

/**
 * Relê produtos específicos, um por um.
 *
 * É o que permite o `send` conferir o preço só do que vai sair, em vez de
 * varrer o feed inteiro atrás dos mesmos 15 produtos. O id vai como string
 * porque o escalar Int64 da API recusa número.
 *
 * O que não voltar simplesmente não entra no resultado — quem chama decide se
 * cai pro preço do banco ou descarta.
 */
export async function fetchByIds(ids: string[]): Promise<Offer[]> {
  const out: Offer[] = [];

  for (const [i, id] of ids.entries()) {
    const itemId = id.split('_')[1];
    if (!itemId) continue;

    try {
      const data = await request<FeedResponse>(ITEM_QUERY, { itemId });
      for (const node of data.productOfferV2?.nodes ?? []) {
        const offer = toOffer(node);
        if (offer && offer.id === id) out.push(offer);
      }
    } catch (err) {
      log.warn({ id, err: (err as Error).message }, 'não consegui reler o produto');
    }

    if (i < ids.length - 1) await sleep(300);
  }

  log.info({ pedidos: ids.length, encontrados: out.length }, 'preços reconferidos');
  return out;
}

/** The feed usually returns a ready affiliate link; mint one only if it didn't. */
export async function affiliateLink(offer: Offer): Promise<string> {
  if (offer.offerLink) return offer.offerLink;
  try {
    const data = await request<{ generateShortLink: { shortLink: string } }>(
      SHORT_LINK_MUTATION,
      // Sub id vazio vai como lista vazia, não como [''] — a API aceita as duas
      // primeiras e recusa a terceira.
      { input: { originUrl: offer.url, subIds: config.SHOPEE_SUB_ID ? [config.SHOPEE_SUB_ID] : [] } },
    );
    return data.generateShortLink?.shortLink || offer.url;
  } catch (err) {
    log.warn({ id: offer.id, err: (err as Error).message }, 'short link failed, using product URL');
    return offer.url;
  }
}
