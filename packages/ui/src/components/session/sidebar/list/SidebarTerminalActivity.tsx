import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { groupTerminalSessionsByDirectory } from '@/lib/projectActionTerminal';
import { observeTerminalSessions } from '@/lib/terminalSessionObserver';
import { useTerminalStore } from '@/stores/useTerminalStore';

/** Mounted with the visible sidebar, independently of row count and grouping. */
export const SidebarTerminalActivity = () => {
  const { terminal } = useRuntimeAPIs();
  React.useEffect(() => observeTerminalSessions(
    terminal, '',
    () => new Map(useTerminalStore.getState().actionMutationRevisions),
    result => {
      const store = useTerminalStore.getState();
      const byDirectory = groupTerminalSessionsByDirectory(result.sessions);
      const directories = new Set([...store.sessions.keys(), ...byDirectory.keys()]);
      for (const directory of directories) {
        store.reconcileServerSessions(directory, byDirectory.get(directory) ?? [], {
          startedActionMutationRevisions: result.startedActionMutationRevisions,
        });
      }
    },
  ), [terminal]);
  return null;
};
