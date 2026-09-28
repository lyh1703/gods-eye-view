import { createInMemoryWorldMemoryRepository } from './repository.js';
import { registerWorldMemoryRepositoryContract } from './worldMemoryContractSuite.mjs';

registerWorldMemoryRepositoryContract('InMemoryWorldMemory', async () => ({
  repository: createInMemoryWorldMemoryRepository({
    now: () => new Date('2026-09-28T00:05:00Z'),
  }),
}));
