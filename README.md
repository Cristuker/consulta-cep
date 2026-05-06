# Consulta CEP

API de consulta de CEP com cache Redis, resiliência, fallback automático e observabilidade. Construída em NestJS + TypeScript.

## Requisitos

- Node.js 18+
- Docker (para o Redis)

## Instalação e execução

```bash
# 1. sobe o Redis
docker compose up -d

# 2. instala as dependências
npm install

# 3. configura as variáveis de ambiente
cp .env.example .env

# desenvolvimento (hot reload)
npm run start:dev

# produção
npm run build
npm run start:prod
```

> **Sem Docker?** A aplicação funciona normalmente mesmo sem Redis — o cache é ignorado de forma transparente e todas as requisições vão direto aos providers. Veja a seção [Degradação graciosa](#degradação-graciosa) para mais detalhes.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta da API |
| `REDIS_URL` | `redis://localhost:6379` | URL de conexão do Redis |
| `CACHE_TTL_SECONDS` | `86400` | TTL para CEP encontrado (padrão: 24h) |
| `CACHE_NOT_FOUND_TTL_SECONDS` | `3600` | TTL para CEP inexistente (padrão: 1h) |

## Endpoint

```
GET /cep/:cep
```

O CEP pode ser enviado com ou sem traço — `01310100` ou `01310-100`.

**Resposta de sucesso — 200:**

```json
{
  "cep": "01310-100",
  "logradouro": "Avenida Paulista",
  "bairro": "Bela Vista",
  "cidade": "São Paulo",
  "estado": "SP"
}
```

O contrato de resposta é único independente de qual provider respondeu.

**Respostas de erro:**

| Situação | Status |
|---|---|
| CEP com formato inválido | 400 |
| CEP não encontrado | 404 |
| Todos os providers indisponíveis | 503 |

## Testes

```bash
npm test              # unitários
npm run test:cov      # com cobertura
npm run test:watch    # watch mode
```

---

## Arquitetura

### Estrutura de pastas

```
src/
  cache/
    cache.module.ts       — módulo do cache
    cache.service.ts      — wrapper do ioredis com degradação graciosa
  cep/
    cep.module.ts
    cep.controller.ts     — valida o formato do CEP
    cep.service.ts        — orquestra cache, fallback, retry e circuit breaker
    dto/
      cep-response.dto.ts — contrato único de resposta
    providers/
      cep-provider.interface.ts
      viacep.provider.ts
      brasilapi.provider.ts
    exceptions/
      cep.exceptions.ts
    filters/
      cep-exception.filter.ts
```

---

### Cache Redis

CEP é dado praticamente estático — o mesmo CEP consultado 1000 vezes produz sempre a mesma resposta. O cache é a primeira coisa verificada em `findCep`, antes de qualquer chamada a provider externo.

**Chaves e TTLs:**

| Chave Redis | Conteúdo | TTL padrão | Motivo |
|---|---|---|---|
| `cep:{cep}` | `CepResponseDto` em JSON | 24h | CEPs raramente mudam |
| `cep:notfound:{cep}` | `true` | 1h | Novos CEPs podem ser criados |

CEPs inexistentes também são cacheados. Sem isso, um CEP inválido consultado repetidamente dispararia o fluxo completo de fallback entre providers a cada requisição — incluindo retries e potencial acionamento do circuit breaker.

**Fluxo do cache em `findCep`:**

```
findCep("01310100")
  │
  ├─ GET cep:01310100 → hit  → retorna dado (sem chamar nenhum provider)
  ├─ GET cep:notfound:01310100 → hit → lança CepNotFoundException (sem chamar nenhum provider)
  └─ miss → chama providers → ao finalizar:
              sucesso → SET cep:01310100 (TTL 24h)
              404     → SET cep:notfound:01310100 (TTL 1h)
              503     → nada é cacheado
```

O `SET` é disparado com `void` — não bloqueia a resposta enquanto o Redis confirma a escrita.

#### Degradação graciosa

Se o Redis estiver indisponível, `get` retorna `null` e `set` é ignorado silenciosamente. A aplicação continua funcionando normalmente, apenas sem cache. O erro é logado como `WARN`, não `ERROR`, porque não impacta a resposta final ao cliente.

```typescript
async get<T>(key: string): Promise<T | null> {
  try {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    this.logger.warn(`Cache GET falhou — degradando para provider`);
    return null;
  }
}
```

O cliente ioredis é configurado com `lazyConnect: true` e `maxRetriesPerRequest: 1`, evitando que falhas de conexão bloqueiem a inicialização da aplicação ou adicionem latência desnecessária.

---

### Interface de provider como contrato

```typescript
interface CepProvider {
  name: string;
  fetch(cep: string): Promise<CepResponseDto>;
}
```

Cada provider é responsável por três coisas apenas: chamar sua própria API com timeout de 5s, normalizar a resposta para o contrato único e lançar exceções tipadas.

O `CepService` recebe um array de providers via token de injeção (`CEP_PROVIDERS`). Para adicionar um terceiro provider amanhã — basta criar o arquivo implementando a interface e adicioná-lo no `useFactory` do módulo. Nenhuma outra linha muda.

---

### Exceções tipadas

| Exceção | Causa |
|---|---|
| `CepNotFoundException` | CEP não existe (404 da API externa) |
| `ProviderTimeoutException` | API não respondeu dentro de 5s |
| `ProviderUnavailableException` | Erro 5xx ou falha genérica de rede |
| `AllProvidersFailedException` | Todos os providers esgotaram suas tentativas |

Essa distinção define o comportamento de cada falha:

- **Timeout** → sem retry (pode agravar uma API já sobrecarregada)
- **404** → sem fallback, cacheia o miss por 1h
- **5xx** → retriável com backoff exponencial
- **Ambos falharam** → `AllProvidersFailedException` → 503

---

### Result Pattern em `tryFetch`

```typescript
async tryFetch(provider, cep): Promise<CepResponseDto | Error>
```

`tryFetch` nunca lança exceção — retorna o resultado ou o erro como valor. Isso elimina `try/catch` aninhado no código de orquestração e torna o fluxo de fallback linear e explícito:

```typescript
const result = await this.tryFetchWithRetry(primary, cep);

if (!(result instanceof Error)) return result;
if (result instanceof CepNotFoundException) throw result;

this.logger.warn(`${primary.name} falhou. Tentando ${secondary.name}.`);

const fallback = await this.tryFetchWithRetry(secondary, cep);
```

---

### Fallback com round-robin

A cada requisição, o índice do provider primário avança. A requisição 1 vai para ViaCEP, a 2 para BrasilAPI, a 3 para ViaCEP, e assim por diante. Se o provider primário falhar, o secundário é tentado automaticamente.

O **404 não aciona fallback**: um CEP inexistente é uma resposta válida da API, não instabilidade de infraestrutura. Chamar a segunda API seria latência desperdiçada — o resultado seria o mesmo.

---

### Retry com backoff exponencial e jitter

Retry acontece **somente** para `ProviderUnavailableException` (5xx, falha genérica):

```
delay = base * 2^attempt + random(0, base * 2^attempt * 0.25)
```

| Tentativa | Base | Jitter máximo | Total máximo |
|---|---|---|---|
| 1ª retry | 200ms | 50ms | 250ms |
| 2ª retry | 400ms | 100ms | 500ms |

O **jitter** (variação aleatória de 25%) evita que múltiplas instâncias retentando simultaneamente sobrecarreguem a API que acabou de se recuperar.

O delay usa `setTimeout` de `timers/promises` — API nativa do Node.js que aceita `AbortSignal`. Quando a aplicação é desligada, o `AbortController` do serviço cancela qualquer delay em andamento imediatamente.

---

### Circuit Breaker

```
CIRCUIT_THRESHOLD   = 3 falhas consecutivas → abre o circuito
CIRCUIT_COOLDOWN_MS = 30 segundos
```

Mantido em memória por provider (`Map<string, CircuitState>`). Quando um provider acumula 3 falhas consecutivas, o circuito abre: chamadas seguintes retornam `ProviderUnavailableException` sem tocar a API. Após 30s o circuito fecha e uma nova tentativa é liberada.

**404 não conta como falha** — não é instabilidade da API.

---

### Observabilidade

Cada ponto relevante do fluxo é logado com o `Logger` do NestJS:

| Evento | Nível |
|---|---|
| Cache hit (CEP ou not-found) | LOG |
| Provider chamado | LOG |
| CEP encontrado + tempo de resposta | LOG |
| CEP não encontrado via provider | WARN |
| Retry + delay calculado | WARN |
| Fallback acionado + provider destino | WARN |
| Redis indisponível | WARN |
| Circuit breaker aberto | ERROR |
| Circuit breaker fechado | LOG |
| Todos os providers falharam | ERROR |

---

### Fluxo completo de uma requisição

```
GET /cep/01310100
      │
      ▼
 Controller
  └─ valida formato → 400 se inválido
      │
      ▼
 CepService.findCep
  ├─ Redis: GET cep:01310100
  │   └─ hit  → retorna (< 1ms, sem chamar nenhum provider)
  ├─ Redis: GET cep:notfound:01310100
  │   └─ hit  → lança CepNotFoundException (< 1ms)
  └─ miss → fetchWithFallback
      │
      ▼
  round-robin → provider primário + secundário
      │
      ▼
 tryFetchWithRetry(primary)
  ├─ circuit breaker aberto? → erro imediato (sem chamar API)
  └─ provider.fetch() com timeout 5s
      ├─ sucesso → Redis SET cep:01310100 (24h) → retorna dado
      ├─ 404     → Redis SET cep:notfound:01310100 (1h) → lança CepNotFoundException
      ├─ timeout → sem retry → passa para fallback
      └─ 5xx     → incrementa circuit breaker
                   retry 1: aguarda ~200ms
                   retry 2: aguarda ~400ms
                   esgotado → passa para fallback
      │
      ▼
 tryFetchWithRetry(secondary)
  └─ mesma lógica acima
      │
  (se ambos falharam)
      │
      ▼
 AllProvidersFailedException → 503
```
