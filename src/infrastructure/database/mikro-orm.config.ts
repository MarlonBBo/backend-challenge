import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { getEnvironment } from '../../config/environment';

const environment = getEnvironment(process.env);

export default defineConfig({
  clientUrl: environment.database.url,
  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],
  extensions: [Migrator],
  migrations: {
    path: 'dist/infrastructure/database/migrations',
    pathTs: 'src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
  pool: {
    min: environment.database.poolMin,
    max: environment.database.poolMax,
  },
  allowGlobalContext: false,
  debug: environment.nodeEnv === 'development',
});
