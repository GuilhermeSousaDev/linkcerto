# Alerta de Preços

Acha ofertas reais na Shopee, mede o desconto contra o histórico que ele mesmo
coleta, e uma IA monta o post de TikTok que leva a pessoa pro grupo do WhatsApp.

```bash
npm run ideia -- --tema academia   # a IA monta o post (rápido, sem gerar imagem)
npm run photos                     # gera os cards com esse plano
npm run send                       # manda as ofertas pro grupo
```

Sem servidor, sem container, sem agendador.

---

## Setup

```bash
npm install
cp .env.example .env      # SHOPEE_APP_ID, SHOPEE_APP_SECRET, REMOTE_AI_API_KEY
                          # e AI_PUBLICO: pra quem o seu perfil fala

npm run db:up             # sobe o Postgres (docker compose)
npm run wa:login          # escaneia o QR code (uma vez só)
npm run wa:groups         # copie o JID do grupo pro .env
npm run deals             # confere o que sairia
```

O banco é **Postgres num container**. O `npm run db:up` sobe, o `db:down` para.
Nenhum comando funciona com ele parado — a mensagem de erro lembra disso.

A chave da IA é obrigatória pro conteúdo: `photos` e `ideia` param com erro sem
ela, em vez de gerar card genérico. Qualquer endpoint compatível com OpenAI
serve — o padrão é a [Groq](https://console.groq.com), que tem free tier.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run ideia` | A IA monta o post de hoje: capa, ordem, legenda, roteiro |
| `npm run photos` | Gera os cards 1080x1080 com o plano da IA |
| `npm run photos:send` | Manda os cards pro seu grupo pessoal (ponte pro celular) |
| `npm run deals` | Mostra as melhores ofertas e **salva o lote** |
| `npm run send` | Manda pro grupo do WhatsApp o lote que o `deals` mostrou |
| `npm run niches` | Lista os nichos prontos |
| `npm run capas` | Os retratos de capa que você tem, por casting |
| `npm run capas:prep` | Cria o `capas.json` e as pastas dele |
| `npm run capas:fetch` | Enche as pastas com retrato livre do Pexels |
| `npm run capas:check` | Folha de provas: como cada foto vai ser recortada |
| `npm run stats` | Quantos produtos e preços já foram coletados |
| `npm run wa:login` | Conecta o WhatsApp via QR |
| `npm run wa:groups` | Lista os grupos e seus JIDs |
| `npm run db:up` / `db:down` | Sobe / para o Postgres |

Opções: `--top N` (quantos), `--tema "…"` (o assunto do post),
`--grade` (post de catálogo, 9 produtos por slide com código),
`--keywords "a,b"` (os termos na mão), `--skip 1,4` (descarta
foto ruim), `--repetir` (aceita produto já postado), `--novo` (ignora o plano
salvo), `--lote F` (usa um lote salvo), `--sem-filtro` (não descarta por
público), `--db` (usa o banco em vez da Shopee), `--all` (mostra os descartados
e o motivo).

> Passando opção via npm, lembre do `--`:
> `npm run photos -- --top 8`

---

## O fluxo

O funil é **vídeo → perfil → grupo → link**. O post nunca entrega o link do
produto: o que ele vende é a entrada no grupo. Por isso o conteúdo é AI-only —
capa fixa é a capa que o seguidor já ignorou ontem.

```bash
npm run ideia -- --tema academia   # não gostou do gancho? roda de novo
npm run ideia -- --tema academia
npm run photos                     # 📋 usa o plano E a busca dele
npm run photos:send            # cai no seu WhatsApp pra postar pelo celular
```

O `ideia` é rápido de propósito: não baixa foto nenhuma, então dá pra iterar no
gancho por segundos até ficar bom. Só depois o `photos` gasta tempo com imagem.

### O que a IA decide

| | |
|---|---|
| **Ângulo** | a tese que amarra esses produtos num post só |
| **Capa** | a manchete do slide 1, mais 2 variantes pra testar depois |
| **Ordem** | qual produto abre e qual fecha — retenção, não desconto |
| **Etiqueta** | a frase amarela em cima do preço, uma por card |
| **Slide final** | o que tem no grupo e por que entrar |
| **Legenda** | com hashtags e uma pergunta no fim, pra puxar comentário |
| **Roteiro** | a fala dos 3 primeiros segundos e uma por slide |
| **Comentário fixado** | o primeiro comentário, que empurra pro perfil |
| **Resposta padrão** | pros "qual o link?" — cada resposta é mais uma visita |
| **Bio** | sugestão pro perfil, que é o degrau entre TikTok e grupo |

**A IA não inventa número.** Ela só enxerga o que medimos: preço, desconto,
baseline, nota e vendas. O que ela escreve ainda passa por um filtro que
descarta escassez inventada ("vagas limitadas", "só hoje") antes de virar
imagem — o grupo é o único ativo aqui, e copy que mente queima ele.

**Não existe plano B na copy.** Se a IA falhar, o comando falha e você roda de
novo — melhor isso que publicar card genérico.

### Quando a IA bate no limite

Cada **modelo** tem sua própria cota por minuto na Groq — não é por família.
Medido com o prompt real do plano:

| Modelo | Tokens/min | Serve de reserva? |
|---|---|---|
| `openai/gpt-oss-120b` (padrão) | 8.000 | — |
| `openai/gpt-oss-20b` | 8.000 (balde próprio) | **sim** — responde com o 120b já em 429 |
| `qwen/qwen3.6-27b` | 8.000 (balde próprio) | não — ver abaixo |
| `groq/compound-mini` | 70.000 no papel | não — ver abaixo |

```bash
REMOTE_AI_MODEL=openai/gpt-oss-120b
REMOTE_AI_FALLBACKS=openai/gpt-oss-20b
```

Dois modelos saíram da lista de reserva porque não funcionavam:

- **`qwen/qwen3.6-27b`** devolve `HTTP 400 json_validate_failed` com o prompt do
  plano mesmo de balde cheio: o `<think>` dele consome o `max_tokens` inteiro e
  o JSON nunca fecha. Falhava 100% das vezes, gastando ~6.900 tokens da cota
  dele pra não entregar nada.
- **`groq/compound-mini`** roteia por dentro pro `gpt-oss-120b` — o 429 dele
  cita o gpt-oss pelo nome. Os 70 mil tokens/min são de fachada: ele herda
  exatamente a cota da qual se está tentando fugir.

**O `max_tokens` é reservado antes de gerar a primeira letra.** O 429 diz na
cara: `Limit 8000, Used 7382, Requested 4826`. Com `max_tokens: 5000` cabia UMA
chamada por minuto — a segunda batia no limite mesmo sem ninguém ter usado os
tokens. Por isso o teto é 2.500 e os gpt-oss vão com `reasoning_effort: 'low'`:
o raciocínio caiu de 3.789 tokens pra 473 e o JSON saiu maior e válido.

Dois limites diferentes, com tratamento diferente:

- **TPM** (por minuto) — troca de modelo e tenta de novo. A espera sai do
  próprio 429 (`Please try again in 31.56s`), não de um chute: o balde reenche
  a 133 tokens/s, então os 20s fixos de antes nunca devolviam o suficiente.
- **TPD** (por dia) — falha na hora. Não volta esperando; volta na virada do dia.

Chave inválida (401) é fatal em qualquer caso: trocar de modelo não resolve.

### O plano é reaproveitado

O `photos` usa o plano mais recente de `data/plans/` **se for das últimas 6
horas**. É o que faz "rodei ideia, gostei, agora gero as fotos" ser verdade.

```bash
npm run photos -- --novo                                    # gera outro na hora
npm run photos -- --plano data/plans/2026-08-19-17-30.json  # escolhe qual
```

Um plano passado com `--plano` vale a qualquer idade.

O plano guarda também **os termos que trouxeram aqueles produtos**, então
`npm run photos` sozinho funciona depois de um `ideia --tema perfume`: ele não
pergunta de novo o que buscar.

Os **textos** vêm do arquivo, mas **preço, desconto e foto vêm da busca de
agora** — plano de ontem não imprime preço de ontem num card de hoje. Como é
JSON legível, dá pra abrir e corrigir uma manchete à mão antes de gerar.

> O `ideia` não avalia as fotos; o `photos` avalia. Um produto do plano pode
> cair no corte visual e sair do post — quando acontece, ele avisa.

---

## O tema

`--tema` é o assunto do post. Se ele nomeia uma **categoria**, também muda a
busca; se é só um **ângulo**, mexe apenas na copy:

| Você pede | O que acontece |
|---|---|
| `--tema academia` | categoria → busca `camiseta dry fit masculina`, `short academia masculino`… |
| `--tema roupa de frio` | categoria → `jaqueta masculina`, `blusa de frio masculina`… |
| `--tema achados que parecem caros` | ângulo → só a copy muda; a busca vem do `.env`/`--keywords` |

A IA recebe o `AI_PUBLICO` junto, então **mantém o público**: pedir academia
num perfil masculino traz short de compressão, não legging feminina.

Ângulo puro não diz o que buscar. Sem `SHOPEE_KEYWORDS` fixo, combine com um:

```bash
npm run ideia -- --keywords "perfume masculino" --tema achados que parecem caros
```

As aspas são opcionais — tudo até a próxima opção entra no tema:

```bash
npm run ideia -- --tema volta as aulas sem gastar
```

### Quem manda na busca

Do mais explícito pro mais inferido:

```bash
npm run photos -- --keywords "panela,air fryer"   # 1. os termos, na mão
npm run photos -- --tema academia                 # 2. tema, se for categoria
npm run photos                                    # 3. os termos do plano salvo
                                                  # 4. senão, SHOPEE_KEYWORDS
```

O catálogo do `npm run niches` continua existindo, mas só como **sugestão pro
`.env`** e como rede pra quando a IA está fora do ar — ele não conhece seu
público, e o `--tema` cobre os mesmos casos conhecendo.

**Não sobrou nenhum?** O comando para com erro. Sem termo a Shopee devolve o
feed geral (bicicleta, iPhone, secador) e o post sai incoerente — errar alto é
melhor que gerar um carrossel aleatório sem você perceber.

### `AI_PUBLICO` e o filtro de público

Essa linha do `.env` define pra quem o perfil fala:

```bash
AI_PUBLICO=homem 20-40 que quer parecer arrumado gastando pouco
```

Ela age em **duas etapas**, porque uma só não bastava:

**1. Na busca.** Os termos gerados carregam o público: `camiseta dry fit
masculina`, não `camiseta dry fit`. Termo neutro traz peça feminina.

**2. Nos resultados.** A busca da Shopee é frouxa e devolve item de outro
público mesmo com o termo certo. Antes de qualquer escolha, a IA lê os títulos
e descarta o que não serve:

```
🚫 41 fora do público (homem 20-40 que quer parecer arrumado gastando pouco):
   Calça Legging Benévola Feminina Poliamida Sem Costur — legging feminina
   Conjunto Academia Top Manga Curta Cropped Costa Aber — cropped feminino
```

Pega o que a peça **é**, não só a palavra escrita: "cropped costa aberta" cai
sem ter "feminina" no título. Vale pro `deals`, `send`, `ideia` e `photos`.

```bash
npm run deals -- --sem-filtro    # ver a lista crua, sem o filtro
```

> **É conservador de propósito**: na dúvida mantém, porque descartar item bom é
> pior que deixar passar um duvidoso — o corte visual e o `--skip` ainda vêm
> depois. Um ou outro ainda escapa.
>
> Olha os 80 primeiros por score e descarta o resto sem examinar. Se o filtro
> falhar (IA fora do ar), ele avisa em vez de fingir que filtrou.

---

## O grupo: `deals` → `send`

Mesmo mecanismo do `ideia` → `photos`, do outro lado do funil. O `deals` grava
o que te mostrou; o `send` manda exatamente aquilo.

```bash
npm run deals -- --tema perfume    # confere a lista
npm run send                       # 📋 manda ESSAS ofertas
```

Antes os dois faziam buscas independentes: você aprovava uma lista no `deals` e
o `send` saía atrás de outra, porque o `--tema` vira termos novos a cada
execução e o feed da Shopee muda no meio.

```bash
npm run send -- --novo                             # ignora o lote e busca de novo
npm run send -- --lote data/lotes/2026-08-20.json  # escolhe qual
```

Como no plano: o lote vale por 6 horas quando encontrado sozinho, e a qualquer
idade quando passado com `--lote`. Ele guarda os termos da busca, então o
`send` não pergunta de novo o que buscar.

**Preço vem sempre da busca de agora**, nunca do arquivo. E se algo ficou mais
caro entre um comando e outro, ele avisa antes de mandar:

```
⚠️  1 subiram de preço desde o deals:
   Perfume Masculino Feelin Impulse Deo Colônia — era R$ 89,95, agora R$ 125,93
   Rode "npm run deals" de novo pra refazer a lista.
```

Anunciar no grupo uma promoção que já acabou é o jeito mais rápido de perder
quem está lá.

> O histórico de preço é gravado em **toda** execução que busca — `deals`,
> `send`, `ideia` e `photos`. Não precisa rodar o `deals` só pra coletar.

---

## O que entra no banco

O banco guarda **só os produtos que você escolhe** — os que aparecem no `deals`,
no `ideia`, no `photos` e no `send`. O que a busca devolveu e você não usou não
é gravado.

O motivo está nos números de uma semana de coleta indiscriminada: 93.816
leituras de preço para capturar **507 mudanças reais** (3,7% dos produtos), com
36% dos produtos aparecendo uma vez e nunca mais.

```bash
npm run deals -- --top 3    # grava 3 leituras, não as 795 que a busca trouxe
```

> **O preço a pagar:** o baseline medido precisa de `BASELINE_MIN_SNAPSHOTS`
> leituras do MESMO produto ao longo de `BASELINE_MIN_DAYS` dias. Gravando só o
> escolhido — e com o cooldown de 14 dias impedindo reescolher — ele
> praticamente não se forma, e o "desconto medido por nós" morre junto.
>
> Se esse ângulo importa, ligue no `.env`:
>
> ```bash
> RECORD_KNOWN=true
> ```
>
> Aí os produtos **já conhecidos** ganham uma leitura a cada rodada, mas produto
> novo continua só entrando quando escolhido. Medido: +798 leituras por rodada,
> e zero produtos novos.

### Quem busca e quem só reaproveita

Só dois comandos escolhem produto: **`deals`** (pro grupo) e **`ideia`** (pro
post). Os outros dois reaproveitam essa escolha:

```
deals  ──escolhe e grava──▶  send    (pega por id, 43ms)
ideia  ──escolhe e grava──▶  photos  (pega por id)
```

Como o produtor grava o que escolheu, o consumidor não precisa varrer o feed
atrás dos mesmos produtos.

O **`photos`** pega por id no banco: uma query de 43ms no lugar de 25s de busca.

O **`send`** relê na Shopee, mas **só os produtos que vão sair** — 5 itens em
3,1s, contra 25s de varredura. É o que mantém honesto o aviso de preço:

```
⚠️  1 subiram de preço desde o deals:
   Perfume Árabe Lattafa Atheeri — era R$ 143,26, agora R$ 238,77
   Rode "npm run deals" de novo pra refazer a lista.
```

Anunciar no grupo uma promoção que já acabou é o jeito mais rápido de perder
quem está lá — por isso o `send` paga esses 3 segundos. Se a API não responder
por algum item, ele usa o preço do banco e avisa.

### `--db`: escolher do banco em vez da Shopee

Como só `deals` e `ideia` escolhem, o `--db` é deles:

```bash
npm run deals -- --db               # monta o lote com produtos já conhecidos
npm run ideia -- --db               # monta o post sem buscar nada
npm run deals -- --db --dias-db 3   # só leituras dos últimos 3 dias
```

Roda em menos de 1 segundo e não gasta cota da Shopee. O `send` e o `photos`
herdam essa escolha pelo lote/plano — não precisam da flag.

**O `--tema` continua valendo com `--db`**: em vez de virar busca, ele filtra os
títulos que já estão no banco, e o comando mostra por quais palavras:

```
💾 Do banco: 3667 produto(s) dos últimos 7 dias
   filtrado por "perfume": perfume, body
```

O vocabulário vem do substantivo que abre cada termo do tema ("camiseta dry fit
masculina" → "camiseta"): a palavra inteira casaria com meio banco.

> Leitura velha vira preço errado no grupo, então o `--db` só considera as dos
> últimos `DB_MAX_AGE_DAYS` dias (padrão 7).
>
> **Hoje ele ainda é magro:** o desconto anunciado pela loja só passou a ser
> gravado agora, então os 93 mil snapshots antigos não têm esse dado e caem em
> "sem_desconto". Isso se resolve sozinho conforme você usa os comandos.

---

## Por que o post de hoje não repete o de ontem

O ranking é estável: os mesmos campeões ficam no topo por semanas. Todo produto
que vira card fica registrado, e `photos`/`ideia` pulam o que saiu nos últimos
`POST_COOLDOWN_DAYS` dias (padrão 14):

```bash
npm run photos                  # "3 produto(s) fora: já foram card nos últimos 14 dias"
npm run photos -- --dias 30     # janela maior
npm run photos -- --repetir     # ignora (gerou e não postou)
```

A marca é gravada ao **gerar**, não ao postar — é quando sabemos quais produtos
viraram card.

É separado do controle do WhatsApp de propósito: são públicos diferentes. O
grupo pode receber hoje o produto que o TikTok mostrou semana passada — quem
está no grupo já converteu, e é lá que o link é entregue.

Rodou duas vezes no mesmo dia? A segunda vai pra `2026-08-19-2/`, pra não
misturar dois posts na mesma pasta. Nada é apagado.

---

## Os cards

Saem em `data/photos/<data>/`, já na ordem do post:

```
01-CAPA.jpg                  manchete da IA sobre um retrato (ver "A capa")
02-tenis-street-life.jpg     produtos
03-kit-4-camisetas.jpg
05-CTA.jpg                   o pedido final
originais/                   foto quadrada da Shopee, se quiser reenquadrar
00-LEGENDA.txt               legenda + roteiro + comentário fixado
00-PLANO.json                o plano inteiro, legível e editável
```

**Layout:** foto ocupando a tela toda; no rodapé, sobre um degradê, a etiqueta
da IA em amarelo, o preço grande, o nome em duas linhas e a prova social por
último. Selo de desconto em pílula no canto superior.

O CTA fica num slide separado de propósito: repetido em toda foto ele vira
moldura e o olho para de ver. No último slide a ação é o assunto — e é onde a
pessoa para de deslizar. Só `CTA_TEXT` e `PROFILE_HANDLE` vêm do `.env`; são
identidade, não copy.

No `00-LEGENDA.txt`, tudo abaixo da linha dupla é referência — roteiro,
comentário fixado, respostas prontas e os links de afiliado. **Não cole no
post.**

### A capa

A capa é o único slide que decide se alguém para de deslizar, e foto de produto
desfocada não para ninguém — quem para é **um rosto**. Então a capa tem uma
biblioteca própria de retratos, em `assets/capas/`, uma pasta por *casting*:

```
assets/capas/
  comedia/    humor, cara de deboche, expressão de meme
  luta/       lutador, boxe, MMA, intensidade
  academia/   treino, musculação, suor
  rico/       luxo, terno, ostentação
  perfume/    homem arrumado, luz dramática
  som/        fone de ouvido, música, foco
```

Esses seis saíram do que o perfil **realmente postou** — relógio, camisa social
e polo, roupa de academia e fone de ouvido — mais perfume, que está no plano.
Não há casting feminino nem de casa porque não há produto feminino nem de casa:
dos produtos que já viraram post, 100% são masculinos.

Casting é **tom, não categoria de produto**: um fone com ângulo de treino pede
`luta`, o mesmo fone com ângulo de "parece caro" pede `rico`. Quem escolhe a
pasta é a IA, a partir do `--tema`, no campo `capa.casting` do plano — que você
pode trocar à mão antes de rodar o `photos`.

**Pra vender outra coisa amanhã**, o catálogo é um arquivo: `capas.json` na
raiz. Acrescente a entrada, rode `npm run capas:prep` (cria a pasta) e
`npm run capas:fetch` (enche). Pasta criada na mão funciona mesmo sem estar no
`capas.json` — só entra no prompt da IA com o nome da pasta no lugar da
descrição.

```json
{
  "cozinha": {
    "descricao": "gente cozinhando, rotina de casa — panela, organizador",
    "busca": "person cooking kitchen face"
  }
}
```

Dentro da pasta, a foto entra por **rodízio**: a que faz mais tempo que não
aparece é a próxima (o controle fica em `data/capas-uso.json`). Sorteio
repetiria — com 6 fotos, 1 chance em 6 de repetir a capa de ontem, e capa
repetida em dois dias é o mesmo que capa fixa pra quem te segue. A recorrência
espaçada é o que dá cara de perfil em vez de post avulso.

**O tratamento é o que faz virar série.** Seis fotos de origens diferentes
passam por preto e branco de contraste duro, grão e recorte que procura o rosto
sozinho, e saem parecendo a mesma direção de arte. Por cima, papel off-white,
manchete preta alinhada à esquerda e o subtítulo grifado de amarelo. O que dá
identidade à capa não é a foto — é o que se faz com ela.

Pasta vazia não quebra nada: sem retrato, a capa volta a ser a foto do produto
desfocada, como antes.

```bash
npm run capas:prep    # cria as pastas, cada uma com um LEIA-ME dentro
npm run capas:fetch   # enche as de arquétipo com retrato livre do Pexels
npm run capas         # o que você tem hoje, por casting
```

`capas:fetch` pede `PEXELS_API_KEY` no `.env` (chave grátis e na hora em
pexels.com/api; as fotos são de uso comercial livre, sem atribuição
obrigatória). `--por-casting N` muda o alvo por pasta (padrão 6).

**Banco de imagem erra muito o que você pediu** — "boxer" devolve cachorro,
"headphones" devolve fone em cima de um sofá. Por isso existe o
`npm run capas:check`: ele monta uma folha de provas por casting, com cada foto
já tratada e recortada **como a capa vai recortar**, e o nome do arquivo do
lado. Apague as ruins de `assets/capas/<casting>/` e pronto — o rodízio se
ajusta sozinho, e o `capas:fetch` nunca traz de volta o que você apagou (ele
guarda os ids já baixados em `data/capas-vistas.json`).

A pasta `comedia` recebe cara de riso genérica do Pexels, o que segura um post
— mas o que funciona ali de verdade é rosto que o seu público **reconhece**, e
banco de imagem livre não tem rosto conhecido. Essas você põe à mão.

> **Não existe gerar isso de graça.** Dos 417 modelos do OpenRouter, 11 fazem
> saída de imagem e **todos são pagos** — não há variante `:free`. E mesmo
> pagando, os modelos de imagem do Google e da OpenAI recusam gerar pessoa real
> conhecida. Por isso a biblioteca é de arquivo: é o único caminho que entrega
> rosto conhecido, e ainda por cima é o de graça.

> **Rosto de pessoa real em post monetizado é uso comercial de imagem** — é o
> motivo de a pasta `comedia` ser manual. Quem entra ali é escolha sua.

### A grade e os códigos

`--grade` troca o formato do post: em vez de um card por produto, sai uma
**grade de catálogo** — 9 produtos por slide, em miniatura, com um código
impresso embaixo de cada um.

```bash
npm run ideia -- --tema camisa masculina --grade   # plano com 18 produtos
npm run photos                                     # segue o plano, sai em grade
```

O `--grade` vive no **plano**: quem pediu a grade pediu no `ideia`, e o `photos`
lê isso do arquivo. Passar `--grade` no `photos` ainda funciona e ganha do
arquivo — serve pra re-renderizar em grade um plano que nasceu de cards, sem
gerar copy nova.

Como a grade come 9 produtos por slide, ela puxa **27** por padrão em vez dos 8
do post normal (`--top` continua mandando).

**O código não vem da Shopee.** A API de afiliado não tem campo de código
nenhum — os 25 campos do `ProductOfferV2` só identificam produto por `itemId` e
`shopId`, dois inteiros longos que ninguém digita num comentário. O código é
invenção nossa, derivado do id do produto: alfabeto sem vogal (nenhum código
forma palavra) e sem `I`/`O` (que viram `1` e `0` na tela do celular).

E é ele que muda o que o post pede. O card único entrega tudo — foto, preço,
nome — e a pessoa assiste satisfeita e vai embora. A grade entrega o produto e o
código: pra saber preço e link ela **tem que comentar**. Comentário empurra o
vídeo no algoritmo e abre a janela de direct, que é por onde o convite do grupo
passa.

A tabela `código → produto → link` sai no `00-LEGENDA.txt`, abaixo da linha
dupla. É o que você consulta quando o direct chega escrito só `CHB-DNA-UZU`.

O corte visual (`MIN_IMAGE_SCORE`) **sai de cena na grade**, por padrão. Ele
existe pra barrar recorte de catálogo em fundo branco, que num card de tela
cheia entrega cara de marketplace — mas a grade é exatamente uma vitrine de
recortes em fundo branco, e ali eles são o formato certo, não o defeito.

### O link de afiliado

É o que faz o post render dinheiro, e é o mais fácil de perder de vista: um
link sem rastreio funciona igual pra quem clica, compra igual, e não paga nada
pra você. Dois cuidados, os dois já resolvidos no código:

**`SHOPEE_SUB_ID` só aceita letras e números.** Hífen e underscore voltam como
`error [11001]: Params Error : invalid sub id`, e a emissão do link falha em
silêncio — o post sai com o link cru da Shopee. O padrão antigo era `wa-group`,
que caía exatamente nisso. Agora é `wagroup`, e um valor inválido derruba o
comando na largada em vez de custar comissão sem avisar.

**O link fica guardado.** O feed devolve `offerLink` junto do produto, mas o
`photos` alcança os produtos por id, a partir do plano salvo — e o banco não
guardava esse campo, então toda legenda saía com o link cru. Agora `offer` tem
a coluna `offer_link`, e o que ainda faltar é emitido e gravado antes de gerar
as imagens:

```
🔗 3 link(s) de afiliado emitidos e guardados.
```

Produto que já estava no banco de antes preenche sozinho na primeira vez que
entrar num post. Se a emissão falhar, o comando avisa em vez de seguir calado:

```
⚠️  2 produto(s) sem link de afiliado — a legenda vai sair com o
   link cru da Shopee, que NÃO paga comissão. Rode de novo mais tarde.
```

### "A partir de": o preço que não é o preço

A Shopee devolve `price` (o menor entre as variações) e `priceMax` (o maior).
Numa busca real por `camisa masculina`, **35 dos 50 produtos** tinham faixa — um
deles anunciava R$ 67,90 com variações até R$ 133,56.

O card imprimia só o menor, como se fosse **o** preço. Agora:

* card único: o preço ganha um **A PARTIR DE** em cima;
* grade: o preço sai com um `+` (`R$ 67,90+`), que é o que cabe numa célula;
* a IA recebe a faixa no briefing e o teto de `"menos de X"` passa a ser a
  variação mais cara, não o menor preço — antes dava pra prometer "tudo abaixo
  de 100" numa lista com um produto que chega a 133.

### A foto é escolhida, não sorteada

Muito "produto" da Shopee é recorte de catálogo em fundo branco, que dá cara de
marketplace. Cada candidato tem a foto pontuada (proporção de branco +
entropia) e o que fica abaixo de `MIN_IMAGE_SCORE` é descartado.

```bash
npm run photos -- --min-image 0.3   # afrouxa o corte
npm run photos -- --visual          # ordena pela qualidade da foto
```

Banner de loja (com texto e selo da própria Shopee) passa nesse teste — não dá
pra detectar sem OCR. Olhe o resultado e descarte na mão:

```bash
npm run photos -- --skip 1,4        # pula o 1º e o 4º e puxa os próximos
```

### Levar os cards pro celular

```bash
npm run photos:send                 # manda a pasta mais recente
npm run photos:send -- --dir data/photos/2026-08-17
npm run photos:send -- --as-image   # vai pra galeria, mas recomprimido
```

Vai como **documento** por padrão, pra manter a qualidade.

Depois das imagens vão os textos, **um por mensagem**, com um rótulo antes de
cada um:

| | |
|---|---|
| 📝 **Legenda** | o que você cola na hora de publicar |
| 📌 **Comentário fixado** | o primeiro comentário, que você fixa depois de postar |

Rótulo e texto em mensagens separadas de propósito: no celular você copia
segurando a mensagem, e ela vem inteira — rótulo junto do texto significaria
apagar "LEGENDA:" à mão toda vez, dentro do app do TikTok.

Os dois saem do `00-PLANO.json`, que tem os campos separados. Post antigo, sem
esse arquivo, ainda manda a legenda (extraída do `00-LEGENDA.txt`) e avisa que
o comentário não foi junto.

---

## Como ele escolhe as ofertas

Filtros primeiro — nota mínima, mínimo de vendas, desconto entre `MIN_DISCOUNT`
e `MAX_DISCOUNT` (queda de 90% é erro de preço ou isca, não promoção).

Depois pontua de 0 a 100: desconto pesa mais, comissão pesa pouco de propósito
— ordenar por comissão transforma o grupo em spam.

### Dois modos, automático

**🏷️ anunciado** — sem histórico ainda. Usa o desconto que a Shopee declara.
Funciona na primeira execução, mas *lojas inflam o preço "de"*.

**✅ histórico** — já temos `BASELINE_MIN_SNAPSHOTS` leituras ao longo de
`BASELINE_MIN_DAYS` dias. O desconto é medido contra o preço que **nós**
observamos, que loja nenhuma forja.

Toda execução grava os preços, e os produtos migram de *anunciado* pra
*histórico* sozinhos. Rodar alguns dias seguidos é o que deixa o sistema
confiável — e é o único ângulo do perfil que ninguém copia sem medir preço.

---

## Escolha um nicho

A decisão mais importante do grupo: quem entra por um produto e vê outros vinte
sem relação silencia o grupo.

```bash
npm run niches                      # sugestões por categoria, com a comissão
```

Copie a linha pro `.env` (`SHOPEE_KEYWORDS=…`) ou teste sem editar nada com
`--keywords`.

> **Comissão importa mais que ticket.** Moda e perfumaria pagam 15-20%,
> eletrônico 4-7%. Eletrônico tem ticket maior, mas converte muito menos em
> canal de impulso.

---

## Arquivos

```
src/
  cli.ts              controller: lê os argumentos, chama os serviços, imprime
  cli/saida.ts        tudo que aparece no terminal

  services/           o que o cli chama — uma função por passo do fluxo
    ofertas.ts        o que buscar, o que sobrou, o que é de outro público
    conteudo.ts       plano do post, escolha das fotos, geração dos cards
    grupo.ts          lote, mensagem e envio pro WhatsApp

  ai/                 client.ts (transporte) · plano.ts · busca.ts · publico.ts
  domain/             scoring.ts · niches.ts · lote.ts · mensagem.ts
  infra/              config.ts · logger.ts · db.ts (Postgres) · shopee.ts · whatsapp.ts
  media/              cards.ts (render 1080x1080) · imagescore.ts
  util/               args.ts · arquivo.ts · texto.ts
```

**A regra da casa:** serviço não imprime e não lê `process.argv`. Eles recebem
opções e devolvem dados (inclusive os `avisos` a mostrar); quem decide o que vai
pra tela é o `cli`. É o que permite testar a lógica sem capturar console.

Sessão do WhatsApp em `data/wa-auth/`. **Não apague** — perder isso significa
escanear o QR de novo.

O banco vive no volume Docker `automations_db`, não em `data/`. Para ver os
dados, conecte qualquer cliente em `localhost:5433` (base `alerta`, usuário e
senha `alerta`).

> ⚠️ `docker compose down -v` apaga o volume e **leva o histórico de preço
> junto** — é o ativo que leva semanas pra reconstruir. Sem o `-v`, o `down` só
> para o container e os dados ficam. Backup:
>
> ```bash
> docker exec alerta-precos-db pg_dump -U alerta alerta > backup.sql
> ```

---

## Avisos

**WhatsApp pode banir.** Baileys é cliente não-oficial. Os intervalos entre
mensagens são aleatórios (8–20s) de propósito. Considere um número secundário.

**Links de afiliado precisam ser identificados** — o rodapé da mensagem já faz
isso automaticamente.

**Shopee:** as páginas do feed são disjuntas, por isso a busca varre
`SHOPEE_PAGES` páginas por execução.

`productOfferV2` **aceita** filtro por item — mas o `itemId` tem que ir como
**string**. Como número, a API responde `wrong type` e zero nós, o que já levou
a concluir (errado) que o filtro era ignorado. É o que o `send` usa pra
reconferir preço sem varrer o feed.

A API **tem** `productCatId` e ele funciona (testado: `100017` volta moda
feminina, `100011` moda masculina). Não é usado aqui porque a taxonomia é por
categoria, não por público — não cobre "mulher 25-40 que compra por impulso", e
exigiria manter um mapa de IDs à mão. O filtro de público resolve o mesmo
problema de forma geral.

**A IA erra.** Ela já tentou colar a etiqueta de um produto na foto de outro e
inventar "vagas limitadas" — os dois casos têm proteção no código, mas leia o
que ela escreveu antes de postar.
