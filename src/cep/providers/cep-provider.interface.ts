import { CepResponseDto } from '../dto/cep-response.dto';

export interface CepProvider {
  readonly name: string;
  fetch(cep: string): Promise<CepResponseDto>;
}

export const CEP_PROVIDERS = 'CEP_PROVIDERS';
