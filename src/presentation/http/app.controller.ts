import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getServiceInfo(): Readonly<{ name: string; status: string }> {
    return Object.freeze({
      name: 'distributed-wagering-processor',
      status: 'ok',
    });
  }
}
