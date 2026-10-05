/** Palavra que não pode terminar uma frase — sobra de corte, lê como erro. */
const DANGLING =
  /[\s,;:+\-–—]+(e|ou|de|do|da|dos|das|com|sem|sobre|por|pelos?|pra|para|que|em|no|na|nos|nas|ao|aos|à|às|um|uma|uns|umas|a|o|os|as|é|só|mais|meu|sua?|seus?|teu|tua|te|me|se|lhe|vai|vou|vão|tá|pode|quer|qual|quais|quem|como|onde)$/i;

/**
 * Corta um texto no limite, sem deixar frase pela metade.
 *
 * O corte por caractere adora parar em "camisa, tênis, bermuda e"; a pontuação
 * solta e a preposição órfã saem até sobrar algo que se lê como frase.
 */
export function clip(text: string, max: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cut =
    t.length <= max
      ? t
      : (() => {
          const c = t.slice(0, max);
          const sp = c.lastIndexOf(' ');
          return sp > max * 0.6 ? c.slice(0, sp) : c;
        })();

  // O corte por caractere adora parar em "camisa, tênis, bermuda e". Tira a
  // pontuação solta e a preposição órfã até sobrar algo que se lê como frase.
  let out = cut.trim().replace(/[\s,;:+\-–—]+$/, '');
  while (DANGLING.test(out)) out = out.replace(DANGLING, '');
  return out.trim();
}

/**
 * Escassez inventada sobre o grupo. O prompt já proíbe, mas o modelo escorrega
 * (o primeiro teste cuspiu "Entra agora, vagas limitadas" no slide final) e
 * mentira impressa em imagem não tem como voltar atrás. O que casar aqui é
 * descartado e o slide cai na frase fixa do .env.
 */
