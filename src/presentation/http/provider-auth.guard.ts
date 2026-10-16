import { Injectable, type CanActivate } from '@nestjs/common';

/** Escopo do desafio: autenticação omitida. Substitua esta proteção por um IdP externo.
* Validação de JWT e vinculação de declarações do provedor às solicitações HTTP. 
* Mantenha as rotas de integridade abertas. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
