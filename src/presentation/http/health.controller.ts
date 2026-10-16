import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { READINESS_PROBE, type ReadinessProbe } from '../../application/health/readiness-probe';

async function check(work: () => Promise<void>): Promise<'up' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), 2_500);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_PROBE) private readonly probe: ReadinessProbe) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    const [database, sqs] = await Promise.all([
      check(() => this.probe.database()),
      check(() => this.probe.sqs()),
    ]);
    const response = {
      status: database === 'up' && sqs === 'up' ? 'ok' : 'error',
      checks: { database, sqs },
    };
    if (response.status !== 'ok') throw new ServiceUnavailableException(response);
    return response;
  }
}
