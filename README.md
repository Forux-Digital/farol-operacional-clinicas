# Farol Operacional

Dashboard de governanca operacional para gestores de clinicas odontologicas.  
Monitora a saude das conversas no Chatwoot em tempo real, identificando filas paradas e operadores inativos.

## O que faz

- **Semaforo por unidade** — cada clinica recebe status verde/amarelo/vermelho baseado em conversas na fila (sem operador) e conversas paradas (operador inativo >48h)
- **Ranking de operadores** — lista quem tem mais conversas paradas, com drill-down por conversa e link direto pro Chatwoot
- **Permissao por conta** — gerentes veem todas as unidades SP; lideres veem apenas suas unidades atribuidas
- **Hyperlinks Chatwoot** — cada conversa e unidade tem link clicavel que abre direto no Chatwoot

## Stack tecnica

| Camada     | Tecnologia                                      |
|------------|--------------------------------------------------|
| Backend    | Node.js + Express                                |
| Banco      | PostgreSQL (Chatwoot, read-only)                 |
| Frontend   | HTML + Tailwind CSS (CDN) + vanilla JS           |
| Auth       | JWT (httpOnly cookie) + bcrypt                   |
| Hosting    | EasyPanel (Nixpacks)                             |
| Fonte      | Inter (Google Fonts)                             |

## Arquitetura

```
Browser  -->  Express (porta 3700)  -->  PostgreSQL (Chatwoot)
  |                |
  |                +-- /api/auth/login    (Chatwoot API + managers locais)
  |                +-- /api/units         (semaforo por unidade)
  |                +-- /api/units/:id     (drill-down: fila + paradas + operadores)
  |                +-- /api/operators     (ranking geral de operadores)
  |                +-- /api/operators/:id (conversas de um operador)
  |
  +-- public/index.html   (dashboard, requer auth)
  +-- public/login.html   (pagina de login, publica)
  +-- public/app.js       (logica frontend)
```

## Autenticacao

Dois caminhos de login, tentados em sequencia:

1. **Chatwoot API** — `POST /auth/sign_in` na instancia Chatwoot. Se o usuario tem conta la, entra com as mesmas credenciais e herda os accounts dele.
2. **Managers locais** — arquivo `managers.json` com credenciais bcrypt. Usado por gestores e lideres que nao tem login no Chatwoot.

O token JWT e salvo em cookie `farol_token` (httpOnly, secure em producao, SameSite=Lax, 24h expiry).

### Permissoes

| Perfil   | `accounts`            | O que ve                              |
|----------|-----------------------|----------------------------------------|
| Gerente  | `[]` (vazio = global) | Todas as unidades SP (exceto account 38) |
| Lider    | `[7, 9, 29, ...]`    | Apenas as unidades atribuidas           |
| Operador | Chatwoot accounts     | Apenas as unidades do Chatwoot dele     |

## Semaforo (traffic light)

| Status   | Condicao                                      | Cor       |
|----------|-----------------------------------------------|-----------|
| Critical | `stalled > 100` OU `queue > 50`               | Vermelho  |
| Warning  | `stalled > 20` OU `queue > 15`                | Amarelo   |
| OK       | Demais                                        | Verde     |

- **queue** = conversas abertas sem operador atribuido
- **stalled** = conversas abertas com operador, mas sem atividade ha mais de X horas (padrao: 48h)
- Bot/IA (Maria Clara, email `*@arvore.ia`) e excluida do ranking automaticamente

## Variaveis de ambiente

```env
DB_HOST=           # Host do PostgreSQL (Chatwoot)
DB_PORT=5432       # Porta do PostgreSQL
DB_NAME=chat       # Nome do banco
DB_USER=postgres   # Usuario do banco
DB_PASSWORD=       # Senha do banco
JWT_SECRET=        # Secret para assinar tokens JWT
CHATWOOT_BASE_URL= # URL base do Chatwoot (ex: https://chatclinics.example.com)
NODE_ENV=production
PORT=3700
```

## Estrutura de arquivos

```
farol-operacional/
  server.js          # Backend Express (API + auth + static files)
  managers.json      # Credenciais locais (bcrypt hashes)
  package.json       # Dependencias e scripts
  .env               # Variaveis de ambiente (nao commitado)
  .gitignore
  public/
    index.html       # Dashboard (protegido por auth)
    login.html       # Pagina de login
    app.js           # Logica frontend (fetch API, render, modals)
```

## Rodar local

```bash
# 1. Instalar dependencias
npm install

# 2. Criar .env com as variaveis acima
cp .env.example .env  # editar com suas credenciais

# 3. Rodar
npm run dev          # com auto-reload (--watch)
# ou
npm start            # producao
```

## Deploy (EasyPanel)

1. Criar App no EasyPanel com source = GitHub repo
2. Build path: `/`
3. Nixpacks detecta Node.js automaticamente
4. Configurar todas as variaveis de ambiente
5. Marcar "Create .env file"
6. Em Domains, apontar porta interna para `3700`
7. Deploy

## Endpoints da API

| Metodo | Rota                                    | Auth | Descricao                              |
|--------|-----------------------------------------|------|----------------------------------------|
| POST   | `/api/auth/login`                       | Nao  | Login (email + senha)                  |
| POST   | `/api/auth/logout`                      | Nao  | Logout (limpa cookie)                  |
| GET    | `/api/auth/me`                          | Sim  | Dados do usuario logado                |
| GET    | `/api/health`                           | Nao  | Health check + conexao com DB          |
| GET    | `/api/units`                            | Sim  | Lista unidades com semaforo            |
| GET    | `/api/units/:id/detail`                 | Sim  | Drill-down: fila, paradas, operadores  |
| GET    | `/api/operators`                        | Sim  | Ranking de operadores com mais paradas |
| GET    | `/api/operators/:userId/conversations`  | Sim  | Conversas paradas de um operador       |

### Query params

- `hours` — threshold de inatividade em horas (padrao: 48)
- `limit` — max de registros retornados
- `account_id` — filtro por conta (obrigatorio em `/operators/:id/conversations`)

## Seguranca

- **Read-only** — o sistema so faz `SELECT` no banco do Chatwoot, nunca modifica dados
- **Sem secrets no codigo** — todas as credenciais via variaveis de ambiente
- **Hashes bcrypt** — senhas dos managers nunca armazenadas em texto puro
- **httpOnly cookie** — token JWT inacessivel via JavaScript do browser
- **Account 38** (Sorria Goias) excluida do escopo SP automaticamente
