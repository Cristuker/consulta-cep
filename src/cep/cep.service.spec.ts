import { Test, TestingModule } from '@nestjs/testing';
import { CepService } from './cep.service';
import { CEP_PROVIDERS, CepProvider } from './providers/cep-provider.interface';
import {
  CepNotFoundException,
  ProviderTimeoutException,
  ProviderUnavailableException,
  AllProvidersFailedException,
} from './exceptions/cep.exceptions';
import { CepResponseDto } from './dto/cep-response.dto';
import { CacheService } from '../cache/cache.service';

const mockCep: CepResponseDto = {
  cep: '01001-000',
  logradouro: 'Praça da Sé',
  bairro: 'Sé',
  cidade: 'São Paulo',
  estado: 'SP',
};

function ok(): Promise<CepResponseDto> {
  return Promise.resolve(mockCep);
}

function notFound(cep: string): Promise<CepResponseDto> {
  return Promise.reject(new CepNotFoundException(cep));
}

function timeout(name: string): Promise<CepResponseDto> {
  return Promise.reject(new ProviderTimeoutException(name));
}

function unavailable(name: string): Promise<CepResponseDto> {
  return Promise.reject(new ProviderUnavailableException(name));
}

function makeProvider(
  name: string,
  impl: (cep: string) => Promise<CepResponseDto>,
): CepProvider {
  return { name, fetch: impl };
}

function makeCacheMock(overrides: Partial<jest.Mocked<CacheService>> = {}) {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CacheService;
}

async function createService(
  providers: CepProvider[],
  cache: CacheService = makeCacheMock(),
): Promise<CepService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CepService,
      { provide: CEP_PROVIDERS, useValue: providers },
      { provide: CacheService, useValue: cache },
    ],
  }).compile();
  const service = module.get(CepService);
  service.onModuleInit();
  return service;
}

describe('CepService', () => {
  describe('cache', () => {
    it('retorna do cache sem chamar providers', async () => {
      const fetch = jest.fn<Promise<CepResponseDto>, [string]>();
      const cache = makeCacheMock({
        get: jest.fn().mockResolvedValueOnce(mockCep),
      });
      const service = await createService(
        [
          { name: 'Primary', fetch },
          { name: 'Secondary', fetch },
        ],
        cache,
      );

      const result = await service.findCep('01001000');

      expect(result).toEqual(mockCep);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('lança CepNotFoundException do cache sem chamar providers', async () => {
      const fetch = jest.fn<Promise<CepResponseDto>, [string]>();
      const cache = makeCacheMock({
        get: jest
          .fn()
          .mockResolvedValueOnce(null) // cep key → miss
          .mockResolvedValueOnce(true), // notfound key → hit
      });
      const service = await createService(
        [
          { name: 'Primary', fetch },
          { name: 'Secondary', fetch },
        ],
        cache,
      );

      await expect(service.findCep('00000000')).rejects.toThrow(
        CepNotFoundException,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('salva no cache após consulta bem-sucedida', async () => {
      const setMock = jest.fn().mockResolvedValue(undefined);
      const cache = makeCacheMock({ set: setMock });
      const service = await createService(
        [makeProvider('Primary', ok), makeProvider('Secondary', ok)],
        cache,
      );

      await service.findCep('01001000');

      expect(setMock).toHaveBeenCalledWith(
        'cep:01001000',
        mockCep,
        expect.any(Number),
      );
    });

    it('salva CEP não encontrado no cache com TTL menor', async () => {
      const setMock = jest.fn().mockResolvedValue(undefined);
      const cache = makeCacheMock({ set: setMock });
      const service = await createService(
        [
          makeProvider('Primary', () => notFound('00000000')),
          makeProvider('Secondary', () => notFound('00000000')),
        ],
        cache,
      );

      await expect(service.findCep('00000000')).rejects.toThrow(
        CepNotFoundException,
      );
      expect(setMock).toHaveBeenCalledWith(
        'cep:notfound:00000000',
        true,
        expect.any(Number),
      );
    });
  });

  describe('fallback e resiliência', () => {
    it('retorna o resultado do primeiro provider', async () => {
      const service = await createService([
        makeProvider('Primary', ok),
        makeProvider('Secondary', ok),
      ]);

      expect(await service.findCep('01001000')).toEqual(mockCep);
    });

    it('faz fallback quando o primeiro provider dá timeout', async () => {
      const service = await createService([
        makeProvider('Primary', () => timeout('Primary')),
        makeProvider('Secondary', ok),
      ]);

      expect(await service.findCep('01001000')).toEqual(mockCep);
    });

    it('retorna 404 imediatamente sem tentar fallback', async () => {
      const secondaryFetch = jest.fn<Promise<CepResponseDto>, [string]>();
      const service = await createService([
        makeProvider('Primary', () => notFound('00000000')),
        { name: 'Secondary', fetch: secondaryFetch },
      ]);

      await expect(service.findCep('00000000')).rejects.toThrow(
        CepNotFoundException,
      );
      expect(secondaryFetch).not.toHaveBeenCalled();
    });

    it('lança AllProvidersFailedException quando todos falham', async () => {
      const service = await createService([
        makeProvider('Primary', () => timeout('Primary')),
        makeProvider('Secondary', () => timeout('Secondary')),
      ]);

      await expect(service.findCep('01001000')).rejects.toThrow(
        AllProvidersFailedException,
      );
    });

    it('faz retry apenas para ProviderUnavailableException', async () => {
      let calls = 0;
      const service = await createService([
        makeProvider('Primary', () => {
          calls++;
          return unavailable('Primary');
        }),
        makeProvider('Secondary', ok),
      ]);
      jest.spyOn(service as any, 'retryDelay').mockResolvedValue(undefined);

      await service.findCep('01001000');

      expect(calls).toBe(3); // 1 inicial + 2 retries antes do fallback
    });

    it('não faz retry para ProviderTimeoutException', async () => {
      let calls = 0;
      const service = await createService([
        makeProvider('Primary', () => {
          calls++;
          return timeout('Primary');
        }),
        makeProvider('Secondary', ok),
      ]);

      await service.findCep('01001000');

      expect(calls).toBe(1);
    });

    it('abre o circuit breaker após 3 falhas consecutivas', async () => {
      let primaryCalls = 0;
      const service = await createService([
        makeProvider('Primary', () => {
          primaryCalls++;
          return unavailable('Primary');
        }),
        makeProvider('Secondary', ok),
      ]);
      jest.spyOn(service as any, 'retryDelay').mockResolvedValue(undefined);

      await service.findCep('01001000');
      await service.findCep('01001000');
      await service.findCep('01001000');

      expect(primaryCalls).toBe(3);

      const result = await service.tryFetch(
        makeProvider('Primary', ok),
        '01001000',
      );
      expect(result).toBeInstanceOf(ProviderUnavailableException);
    });

    it('alterna providers em round-robin', async () => {
      const calls: string[] = [];
      const service = await createService([
        makeProvider('Primary', () => {
          calls.push('Primary');
          return ok();
        }),
        makeProvider('Secondary', () => {
          calls.push('Secondary');
          return ok();
        }),
      ]);

      await service.findCep('01001000');
      await service.findCep('01001000');
      await service.findCep('01001000');

      expect(calls).toEqual(['Primary', 'Secondary', 'Primary']);
    });
  });
});
