import { setTimeout as nodeDelay } from 'timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CepProvider, CEP_PROVIDERS } from './providers/cep-provider.interface';
import { CepResponseDto } from './dto/cep-response.dto';
import {
  CepNotFoundException,
  ProviderTimeoutException,
  ProviderUnavailableException,
  AllProvidersFailedException,
} from './exceptions/cep.exceptions';
import { CacheService } from '../cache/cache.service';

const CEP_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 86_400);
const CEP_NOT_FOUND_TTL_SECONDS = Number(
  process.env.CACHE_NOT_FOUND_TTL_SECONDS ?? 3_600,
);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 200;
const RETRY_JITTER_FACTOR = 0.25;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

interface CircuitState {
  failures: number;
  isOpen: boolean;
  openedAt: number | null;
}

@Injectable()
export class CepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CepService.name);
  private readonly circuits = new Map<string, CircuitState>();
  private readonly shutdown = new AbortController();
  private currentIndex = 0;

  constructor(
    @Inject(CEP_PROVIDERS) private readonly providers: CepProvider[],
    private readonly cache: CacheService,
  ) {}

  onModuleInit() {
    for (const provider of this.providers) {
      this.circuits.set(provider.name, {
        failures: 0,
        isOpen: false,
        openedAt: null,
      });
    }
  }

  onModuleDestroy() {
    this.shutdown.abort();
  }

  async findCep(cep: string): Promise<CepResponseDto> {
    const cached = await this.cache.get<CepResponseDto>(`cep:${cep}`);
    if (cached) {
      this.logger.log(`Cache hit para CEP ${cep}`);
      return cached;
    }

    const notFoundCached = await this.cache.get<boolean>(`cep:notfound:${cep}`);
    if (notFoundCached) {
      this.logger.log(`Cache hit (not found) para CEP ${cep}`);
      throw new CepNotFoundException(cep);
    }

    try {
      const result = await this.fetchWithFallback(cep);
      void this.cache.set(`cep:${cep}`, result, CEP_TTL_SECONDS);
      return result;
    } catch (err) {
      if (err instanceof CepNotFoundException) {
        void this.cache.set(
          `cep:notfound:${cep}`,
          true,
          CEP_NOT_FOUND_TTL_SECONDS,
        );
      }
      throw err;
    }
  }

  private async fetchWithFallback(cep: string): Promise<CepResponseDto> {
    const [primary, secondary] = this.getProviderOrder();

    const result = await this.tryFetchWithRetry(primary, cep);

    if (!(result instanceof Error)) return result;
    if (result instanceof CepNotFoundException) throw result;

    this.logger.warn(`${primary.name} falhou. Tentando ${secondary.name}.`);

    const fallback = await this.tryFetchWithRetry(secondary, cep);

    if (!(fallback instanceof Error)) return fallback;
    if (fallback instanceof CepNotFoundException) throw fallback;

    throw new AllProvidersFailedException();
  }

  private async tryFetchWithRetry(
    provider: CepProvider,
    cep: string,
  ): Promise<CepResponseDto | Error> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.tryFetch(provider, cep);

      if (!(result instanceof Error)) return result;
      if (!(result instanceof ProviderUnavailableException)) return result;
      if (attempt === MAX_RETRIES) return result;

      try {
        await this.retryDelay(attempt, provider.name);
      } catch {
        return result; // shutdown disparado durante o wait — para de tentar
      }
    }

    return new ProviderUnavailableException(provider.name);
  }

  async tryFetch(
    provider: CepProvider,
    cep: string,
  ): Promise<CepResponseDto | Error> {
    const circuit = this.circuits.get(provider.name)!;

    if (circuit.isOpen) {
      const elapsed = Date.now() - circuit.openedAt!;

      if (elapsed < CIRCUIT_COOLDOWN_MS) {
        const remaining = Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000);
        this.logger.warn(
          `Circuit breaker aberto para ${provider.name} — ignorando (${remaining}s restantes)`,
        );
        return new ProviderUnavailableException(provider.name);
      }

      circuit.isOpen = false;
      circuit.failures = 0;
      circuit.openedAt = null;
      this.logger.log(
        `Circuit breaker fechado para ${provider.name} — testando novamente`,
      );
    }

    const start = Date.now();
    this.logger.log(`Consultando CEP ${cep} via ${provider.name}`);

    try {
      const data = await provider.fetch(cep);
      const elapsed = Date.now() - start;

      circuit.failures = 0;
      this.logger.log(
        `CEP ${cep} encontrado via ${provider.name} em ${elapsed}ms`,
      );
      return data;
    } catch (err) {
      const elapsed = Date.now() - start;

      if (err instanceof CepNotFoundException) {
        this.logger.warn(
          `CEP ${cep} não encontrado via ${provider.name} (${elapsed}ms)`,
        );
        return err;
      }

      const isTimeout = err instanceof ProviderTimeoutException;
      const errorType = isTimeout ? 'timeout' : '5xx/indisponível';
      const message = err instanceof Error ? err.message : String(err);

      this.logger.error(
        `Falha no provider ${provider.name} [${errorType}] após ${elapsed}ms: ${message}`,
      );

      circuit.failures++;
      if (circuit.failures >= CIRCUIT_THRESHOLD) {
        circuit.isOpen = true;
        circuit.openedAt = Date.now();
        this.logger.error(
          `Circuit breaker aberto para ${provider.name} (${circuit.failures} falhas consecutivas)`,
        );
      }

      return err instanceof Error ? err : new Error(message);
    }
  }

  private async retryDelay(
    attempt: number,
    providerName: string,
  ): Promise<void> {
    const base = RETRY_BASE_MS * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * base * RETRY_JITTER_FACTOR);
    const ms = base + jitter;
    this.logger.warn(
      `Retry ${attempt + 1}/${MAX_RETRIES} para ${providerName} em ${ms}ms`,
    );
    await nodeDelay(ms, undefined, { signal: this.shutdown.signal });
  }

  private getProviderOrder(): [CepProvider, CepProvider] {
    const index = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.providers.length;
    return [this.providers[index], this.providers[1 - index]];
  }
}
