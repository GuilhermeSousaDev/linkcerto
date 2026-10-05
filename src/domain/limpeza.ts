import { ehInfantil } from './infantil.js';
import { veredito, type Genero } from './genero.js';

/**
 * O que não vale guardar no banco.
 *
 * A busca da Shopee é frouxa: "academia" traz panela, "perfume masculino" traz
 * body splash feminino. Tudo isso entrava no banco e ficava lá, inflando o
 * `--db` com produto que nunca ia pro grupo. Aqui moram as regras de corte —
 * quem garante que nada usado seja apagado é a query (`sent`/`posted` nunca
 * entram na lista de candidatos).
 */

/**
 * Categorias que o perfil não vende. Lista negra e não branca: o que o grupo
 * vende muda com o `--tema`, o que ele NUNCA vende é bem mais estável.
 */
const FORA_DO_NICHO = new RegExp(
  [
    'panelas?', 'frigideiras?', 'cozedor', 'cuscuzeira?', 'pipoqueira', 'hermetic[oa]s?',
    'utensilios?', 'liquidificador', 'cafeteira', 'air ?fryer', 'sanduicheira', 'chaleira',
    'amaciante', 'sabao', 'detergente', 'aromatizador(es)?', 'difusor', 'vassoura', 'rodo',
    'travesseiros?', 'lencol', 'edredom', 'cortinas?', 'tapetes?',
    'pet', 'cachorros?', 'gatos?', 'coleira', 'comedouro',
    'furadeira', 'parafusadeira', 'chave de fenda', 'ferramentas?',
    'maquiagem', 'batom', 'esmaltes?', 'cilios',
    // Peça feminina mesmo sem a palavra "feminina" no título.
    'vestidos?', 'saias?', 'sutias?', 'calcinhas?', 'biquinis?', 'cropped', 'maio',
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
);

export type MotivoLimpeza = 'infantil' | 'outro_genero' | 'fora_do_nicho';

/** `null` = vale guardar. `genero` é o do AI_PUBLICO; sem ele, gênero não corta. */
export function motivoLimpeza(titulo: string, genero: Genero | null): MotivoLimpeza | null {
  if (ehInfantil(titulo)) return 'infantil';
  const t = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (FORA_DO_NICHO.test(t)) return 'fora_do_nicho';
  if (genero && veredito(titulo, genero) === 'fora') return 'outro_genero';
  return null;
}
