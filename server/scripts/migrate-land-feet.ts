// One-off: litigation land area unit Sarsai → Feet (field land.sarsai renamed to land.feet).
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

await mongoose.connect(env.MONGO_URI);
const r = await mongoose.connection.collection('litigationcases').updateMany({ 'land.sarsai': { $exists: true } }, { $rename: { 'land.sarsai': 'land.feet' } });
console.log(`${r.modifiedCount} case(s) updated`);
await mongoose.disconnect();
