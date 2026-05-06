import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { CepController } from './cep.controller';
import { CepService } from './cep.service';
import { ViaCepProvider } from './providers/viacep.provider';
import { BrasilApiProvider } from './providers/brasilapi.provider';
import { CEP_PROVIDERS } from './providers/cep-provider.interface';

@Module({
  imports: [CacheModule],
  controllers: [CepController],
  providers: [
    ViaCepProvider,
    BrasilApiProvider,
    {
      provide: CEP_PROVIDERS,
      useFactory: (viacep: ViaCepProvider, brasilapi: BrasilApiProvider) => [
        viacep,
        brasilapi,
      ],
      inject: [ViaCepProvider, BrasilApiProvider],
    },
    CepService,
  ],
})
export class CepModule {}
