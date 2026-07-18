// Exclui .claude/ (worktrees de sessões do Claude Code contêm cópias antigas
// dos testes que não devem rodar junto com a suíte principal).
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
