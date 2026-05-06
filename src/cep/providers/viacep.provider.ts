import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { CepProvider } from './cep-provider.interface';
import { CepResponseDto } from '../dto/cep-response.dto';
import {
  CepNotFoundException,
  ProviderTimeoutException,
  ProviderUnavailableException,
} from '../exceptions/cep.exceptions';

const REQUEST_TIMEOUT_MS = 5000;

interface ViaCepResponse {
  cep: string;
  logradouro: string;
  bairro: string;
  localidade: string;
  uf: string;
  erro?: boolean;
}

@Injectable()
export class ViaCepProvider implements CepProvider {
  readonly name = 'ViaCEP';
  private readonly logger = new Logger(ViaCepProvider.name);

  async fetch(cep: string): Promise<CepResponseDto> {
    const url = `https://viacep.com.br/ws/${cep}/json/`;

    try {
      const response = await axios.get<ViaCepResponse>(url, {
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (response.data.erro) {
        throw new CepNotFoundException(cep);
      }

      return this.map(response.data);
    } catch (err) {
      if (err instanceof CepNotFoundException) throw err;

      if (axios.isAxiosError(err)) {
        if (err.code === 'ECONNABORTED')
          throw new ProviderTimeoutException(this.name);
        if (err.response?.status === 404) throw new CepNotFoundException(cep);
      }

      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `Erro inesperado ao consultar ${this.name}: ${message}`,
        stack,
      );
      throw new ProviderUnavailableException(this.name);
    }
  }

  private map(data: ViaCepResponse): CepResponseDto {
    return {
      cep: this.formatCep(data.cep),
      logradouro: data.logradouro,
      bairro: data.bairro,
      cidade: data.localidade,
      estado: data.uf,
    };
  }

  private formatCep(cep: string): string {
    const digits = cep.replace('-', '');
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
}
