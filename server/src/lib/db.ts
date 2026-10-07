import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
// Never auto-build indexes in production; run `syncIndexes` from a migration/deploy step instead.
mongoose.set('autoIndex', !env.isProd);

export async function connectDb() {
  await mongoose.connect(env.MONGO_URI, { maxPoolSize: 50, serverSelectionTimeoutMS: 10_000 });
  logger.info('MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
