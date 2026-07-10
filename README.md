# Bússola — Orientação de Finanças Pessoais

Um site simples que conversa com o **GPT** para ajudar as pessoas a organizar a vida
financeira. A interface fica no `index.html` e uma pequena função de servidor
(`api/chat.js`) guarda a sua chave da API em segredo e fala com a OpenAI.

```
bussola-financeira/
├── index.html        → a página que o público vê (o chat)
├── api/
│   └── chat.js       → função de servidor; é AQUI que você cola o seu prompt
├── package.json
├── .env.example      → modelo das variáveis de ambiente
├── .gitignore
└── README.md
```

---

## Passo 0 — Antes de começar você vai precisar de

1. Uma conta no **GitHub** — https://github.com
2. Uma conta na **Vercel** — https://vercel.com (pode entrar com o GitHub)
3. Uma **chave da API da OpenAI** — https://platform.openai.com/api-keys
   - A API é paga por uso (por tokens). Ative um método de pagamento em
     *Billing* na plataforma da OpenAI. Modelos como `gpt-4o-mini` têm custo baixo.

---

## Passo 1 — Cole o seu prompt

Abra `api/chat.js` e substitua o texto dentro de `SYSTEM_PROMPT` (entre as crases `` ` ``)
pelo seu prompt pronto. É só esse trecho que muda o comportamento do assistente.

---

## Passo 2 — Suba o projeto para o GitHub

**Opção A — pelo site (sem instalar nada):**
1. Em https://github.com/new crie um repositório (ex.: `bussola-financeira`).
2. Na página do repositório, clique em **Add file → Upload files**.
3. Arraste **todos os arquivos desta pasta** (incluindo a pasta `api`) e confirme
   em **Commit changes**.

**Opção B — pelo terminal (se você usa Git):**
```bash
git init
git add .
git commit -m "Primeira versão da Bússola"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/bussola-financeira.git
git push -u origin main
```

---

## Passo 3 — Publique na Vercel

1. Acesse https://vercel.com e entre com o GitHub.
2. **Add New… → Project** e selecione o repositório `bussola-financeira`.
3. Não precisa mudar nada em *Build & Output* (é um site estático + função).
4. Abra **Environment Variables** e adicione:

   | Name             | Value                        |
   |------------------|------------------------------|
   | `OPENAI_API_KEY` | sua chave `sk-...` da OpenAI |

   (Opcional: `OPENAI_MODEL` = `gpt-4o` para usar um modelo mais capaz.)
5. Clique em **Deploy** e aguarde alguns segundos.

Pronto — a Vercel vai te dar um link público, algo como
`https://bussola-financeira.vercel.app`. Esse é o link para compartilhar. ✅

> Cada vez que você alterar o prompt (ou qualquer arquivo) e enviar para o GitHub,
> a Vercel republica sozinha.

---

## Testar na sua máquina (opcional)

```bash
npm i -g vercel      # instala a CLI da Vercel
vercel dev           # roda o site + a função localmente
```
Crie um arquivo `.env.local` (baseado em `.env.example`) com sua `OPENAI_API_KEY`.
Abrir só o `index.html` direto no navegador **não** funciona, porque a parte que fala
com o GPT precisa do servidor (`vercel dev` ou a publicação na Vercel).

---

## "Conectar ao GPT" — os dois sentidos

Este projeto usa a **API do GPT (OpenAI)**: o site envia o seu prompt + a mensagem do
usuário e recebe a resposta. É o caminho para ter um site próprio, com link público.

Se em vez disso você quisesse um **GPT personalizado dentro do ChatGPT** (na loja de GPTs),
esse é outro produto — ele vive dentro do ChatGPT e não vira um site com link próprio.
Para um ambiente público na web, como você pediu, a API é o caminho certo.

---

## Identidade visual e parceria

O site já vem com a identidade da **Engeval** (paleta azul + o logotipo em
`assets/logo-engeval.png`) e um co-branding de parceria no cabeçalho e no rodapé.

- **Sua marca pessoal:** no `index.html`, procure `Sua Marca` (aparece no cabeçalho,
  em `class="personal-name"`, e no rodapé). Troque pelo nome da sua marca. Se você tiver
  um logotipo próprio, coloque o arquivo em `assets/` e substitua o texto `Sua Marca`
  por uma `<img>` — há um comentário no código marcando o ponto exato.
- **Logotipo Engeval:** está em `assets/logo-engeval.png`. Para trocar por outra versão
  (ex.: fundo branco), substitua esse arquivo mantendo o nome.

## Personalização rápida

- **Textos e boas-vindas:** edite o cabeçalho e a seção de boas-vindas no `index.html`.
- **Sugestões iniciais:** altere os botões dentro de `<div class="chips">`.
- **Cores:** ajuste as variáveis no topo do `<style>` (`--blue`, `--blue-deep`,
  `--cyan`, etc.) — são as cores da Engeval.
- **Modelo do GPT:** variável `OPENAI_MODEL` na Vercel.
