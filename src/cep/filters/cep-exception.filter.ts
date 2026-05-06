import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  CepNotFoundException,
  AllProvidersFailedException,
} from '../exceptions/cep.exceptions';

type CepError = CepNotFoundException | AllProvidersFailedException;

@Catch(CepNotFoundException, AllProvidersFailedException)
export class CepExceptionFilter implements ExceptionFilter<CepError> {
  private readonly logger = new Logger(CepExceptionFilter.name);

  catch(exception: CepError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { status, error } = this.resolve(exception);

    this.logger.error(`[${exception.name}] ${exception.message}`);

    response.status(status).json({
      statusCode: status,
      error,
      message: exception.message,
    });
  }

  private resolve(exception: CepError): { status: number; error: string } {
    if (exception instanceof CepNotFoundException) {
      return { status: HttpStatus.NOT_FOUND, error: 'CEP Not Found' };
    }

    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
    };
  }
}
