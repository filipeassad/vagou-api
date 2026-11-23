import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Todos os testes usam o mesmo banco vagou_test; em paralelo, a limpeza de um
    // arquivo apagaria os dados de outro.
    fileParallelism: false,
  },
});
