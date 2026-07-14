# Programa de Saúde Financeira — Marco Souza × Engeval

Site gamificado de educação financeira para colaboradores da fábrica. O colaborador
entra com matrícula + PIN, conversa com um Orientador Financeiro (GPT), cumpre missões,
ganha pontos e sobe de nível. O gestor acompanha tudo por um painel próprio.

```
├── index.html        → colaborador: login, painel, missões e chat
├── gestor.html       → gestor: ranking, conversas, aprovações e prêmios (senha)
├── api/
│   ├── auth.js       → cadastro e login (matrícula + PIN)
│   ├── chat.js       → Orientador Financeiro (contém o prompt)
│   ├── missions.js   → envio de missões, pontuação, validação
│   └── admin.js      → painel do gestor
├── lib/
│   ├── missions.js   → CATÁLOGO: trilhas, missões, pontos e níveis (edite aqui)
│   └── store.js      → banco de dados e autenticação
└── assets/logo-engeval.png
```

---

## Como o jogo funciona

**Princípio:** pontua-se **comportamento**, não situação financeira. Quem está endividado
pontua igual a quem já está no azul. Isso evita punir quem mais precisa de ajuda — e evita
que a pessoa minta para o Orientador para "parecer bem".

**7 trilhas · 14 missões:** Diagnóstico, Orçamento, Dívidas, Cartão, Reserva, Objetivos e Hábitos.

**Níveis (marcos garantidos — bateu, ganhou):**

| Nível | Pontos | Nome |
|---|---|---|
| 1 | 0 | Iniciante |
| 2 | 300 | Organizado |
| 3 | 800 | No controle |
| 4 | 1.500 | Construtor |
| 5 | 2.500 | Referência |

Cumprir todas as missões uma vez rende ~1.725 pontos. Os níveis 4 e 5 exigem **constância**
(check-ins semanais, dívidas quitadas, reserva mantida) — não dá para chegar lá só clicando.

---

## Como o colaborador comprova o que fez

Cinco níveis de rigor, com pontos proporcionais:

| Tipo | Como comprova | Quem aprova |
|---|---|---|
| `form` | preenche um formulário estruturado (orçamento, dívidas, plano) | **o GPT confere a coerência** e libera na hora |
| `quiz` | acerta as perguntas da lição | automático |
| `checkin` | autodeclaração semanal (vale pouco, mas gera sequência) | automático |
| `proof` | envia foto/PDF (acordo, extrato, quitação) | **o gestor aprova** — só então os pontos entram |

A ideia central: **a prova nasce do próprio ato**. A missão "monte seu orçamento" não é
cumprida dizendo "montei" — é cumprida preenchendo o orçamento ali dentro. O preenchimento
é a prova. O GPT recusa preenchimentos aleatórios (ex.: "111, 111, 111").

Reforços contra fraude, sem burocracia:
- **Consistência no tempo** — os check-ins repetem os mesmos números por semanas; uma história
  inventada não se sustenta, e o gestor enxerga saltos incoerentes.
- **Comprovante só onde vale prêmio** — as missões de maior pontuação exigem documento.
- **Gancho para o RH** — há um campo "validado pelo RH" no painel, para quando a fábrica
  confirmar se pode conferir consignado/adiantamento pela folha (a prova mais forte e barata
  que existe nesse contexto).

---

## Publicação

### Passo 1 — GitHub
Crie um repositório e suba todos os arquivos (dá para arrastar em *Add file → Upload files*).

### Passo 2 — Vercel
1. https://vercel.com → **Add New… → Project** → selecione o repositório.
2. Em **Environment Variables**, adicione:

   | Name | Valor |
   |---|---|
   | `OPENAI_API_KEY` | sua chave `sk-...` da OpenAI |
   | `ADMIN_PASSWORD` | senha do painel do gestor |

3. **Deploy**.

### Passo 3 — Banco de dados (obrigatório)
Sem ele, ninguém consegue nem se cadastrar.

1. No projeto, aba **Storage → Create Database**.
2. Escolha **Upstash → Redis** (Marketplace; tem plano gratuito).
3. Conecte ao projeto — a Vercel cria sozinha `KV_REST_API_URL` e `KV_REST_API_TOKEN`.
4. **Redeploy** (Deployments → menu do último deploy → Redeploy).

### Passo 4 — Cadastre os prêmios
Abra `https://SEU-SITE.vercel.app/gestor.html`, entre com a `ADMIN_PASSWORD` e vá em
**Prêmios**. Preencha os níveis 2 a 5. Enquanto estiverem vazios, o colaborador vê apenas
"os prêmios estão sendo definidos" — e continua acumulando pontos normalmente.

---

## Os dois endereços

| Quem | Endereço | Acesso |
|---|---|---|
| Colaborador | `SEU-SITE.vercel.app` | matrícula + PIN (ele mesmo cria no 1º acesso) |
| Gestor | `SEU-SITE.vercel.app/gestor.html` | `ADMIN_PASSWORD` |

O painel do gestor não tem link no site do colaborador e está marcado para não aparecer
em buscadores.

---

## Privacidade (importante)

O gestor **vê as conversas e os comprovantes** — foi a opção escolhida. Por isso:

- A tela de login **avisa isso de forma explícita** ao colaborador, antes de ele entrar.
  Não remova esse aviso: além do risco legal (LGPD), a confiança do programa depende dele.
- O prompt do Orientador **nunca pede** CPF, senha, número de cartão ou código de SMS.
- Recomendo ter uma política de privacidade simples e comunicar o programa abertamente
  (o que é registrado, quem vê, para quê).

---

## Ajustar o programa

Quase tudo está em **`lib/missions.js`**:
- mudar pontos de uma missão → campo `points`
- criar/remover missões → edite o array `missions` de cada trilha
- mudar as faixas de nível → array `LEVELS`
- mudar o bônus de sequência → `STREAK_BONUS`

O prompt do Orientador está em `api/chat.js`, dentro de `SYSTEM_PROMPT`.
