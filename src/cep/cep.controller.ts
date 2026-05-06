import {
  BadRequestException,
  Controller,
  Get,
  Param,
  UseFilters,
} from '@nestjs/common';
import { CepService } from './cep.service';
import { CepResponseDto } from './dto/cep-response.dto';
import { CepExceptionFilter } from './filters/cep-exception.filter';

const CEP_REGEX = /^\d{8}$/;

@Controller('cep')
@UseFilters(CepExceptionFilter)
export class CepController {
  constructor(private readonly cepService: CepService) {}

  @Get(':cep')
  async findCep(@Param('cep') cep: string): Promise<CepResponseDto> {
    const normalized = cep.replace('-', '');

    if (!CEP_REGEX.test(normalized)) {
      throw new BadRequestException(
        'CEP deve conter exatamente 8 dígitos numéricos',
      );
    }

    return this.cepService.findCep(normalized);
  }
}
