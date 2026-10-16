import 'reflect-metadata';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

// Failure injection lives only in this test fixture, never in production code.
async function start() {
  if (process.env.TEST_PAUSE_BEFORE_ACK_FILE !== undefined) {
    const queueModule = (await import(
      pathToFileURL(resolve('dist/infrastructure/messaging/sqs-wager.queue.js')).href
    )) as { SqsWagerQueue: { prototype: { acknowledge(receipt: string): Promise<void> } } };
    queueModule.SqsWagerQueue.prototype.acknowledge = async () => {
      await writeFile(process.env.TEST_PAUSE_BEFORE_ACK_FILE!, 'commit reached before ack');
      await new Promise<never>(() => {});
    };
  }
  await import(pathToFileURL(resolve('dist/main.js')).href);
}
void start();
