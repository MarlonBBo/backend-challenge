import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { getEnvironment } from '../../config/environment';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';

const environment = getEnvironment(process.env);
const isProduction = environment.nodeEnv === 'production';

export default defineConfig({
  clientUrl: environment.database.url,
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: 'dist/infrastructure/database/migrations',
    pathTs: isProduction
      ? 'dist/infrastructure/database/migrations'
      : 'src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
    emit: isProduction ? 'js' : 'ts',
  },
  pool: {
    min: environment.database.poolMin,
    max: environment.database.poolMax,
  },
  allowGlobalContext: false,
  debug: environment.nodeEnv === 'development',
});
