export class CepNotFoundException extends Error {
  constructor(cep: string) {
    super(`CEP ${cep} não encontrado`);
    this.name = 'CepNotFoundException';
  }
}

export class ProviderTimeoutException extends Error {
  constructor(providerName: string) {
    super(`Provider ${providerName} não respondeu a tempo`);
    this.name = 'ProviderTimeoutException';
  }
}

export class ProviderUnavailableException extends Error {
  constructor(providerName: string) {
    super(`Provider ${providerName} está indisponível`);
    this.name = 'ProviderUnavailableException';
  }
}

export class AllProvidersFailedException extends Error {
  constructor() {
    super('Todos os provedores de CEP estão indisponíveis');
    this.name = 'AllProvidersFailedException';
  }
}
