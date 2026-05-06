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

interface BrasilApiResponse {
  cep: string;
  street: string;
  neighborhood: string;
  city: string;
  state: string;
}

@Injectable()
export class BrasilApiProvider implements CepProvider {
  readonly name = 'BrasilAPI';
  private readonly logger = new Logger(BrasilApiProvider.name);

  async fetch(cep: string): Promise<CepResponseDto> {
    const url = `https://brasilapi.com.br/api/cep/v1/${cep}`;

    try {
      const response = await axios.get<BrasilApiResponse>(url, {
        timeout: REQUEST_TIMEOUT_MS,
      });

      return this.map(response.data);
    } catch (err) {
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

  private map(data: BrasilApiResponse): CepResponseDto {
    return {
      cep: this.formatCep(data.cep),
      logradouro: data.street,
      bairro: data.neighborhood,
      cidade: data.city,
      estado: data.state,
    };
  }

  private formatCep(cep: string): string {
    const digits = cep.replace('-', '');
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
}
